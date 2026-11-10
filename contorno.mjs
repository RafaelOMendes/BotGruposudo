// Contorno: recorta uma pessoa/coisa da foto seguindo o contorno dela (fundo transparente).
//  - MobileSAM (segmentação por instância): pega SÓ o alvo dentro da caixa, separando de quem
//    está encostado nele;
//  - BiRefNet (remoção de fundo): dá a borda fina (cabelo, dedos).
// A transparência final é a combinação das duas máscaras. Tudo roda local, na CPU.
// Os modelos (~270 MB) ficam em .modelos/ e são baixados sozinhos no primeiro uso.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const PASTA = path.join(path.dirname(fileURLToPath(import.meta.url)), '.modelos');
const MODELOS = {
  birefnet: { arquivo: 'birefnet-lite.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx', min: 200e6 },
  samEncoder: { arquivo: 'mobilesam-encoder.onnx', url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx', min: 20e6 },
  samDecoder: { arquivo: 'mobilesam-decoder.onnx', url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx', min: 10e6 },
};
const LADO_BIREFNET = 1024;
const LADO_SAM = 1024;

let ortP = null;
const sessoes = {};
let fila = Promise.resolve(); // uma imagem por vez (memória/CPU)

async function baixar({ arquivo, url, min }) {
  const destino = path.join(PASTA, arquivo);
  if (fs.existsSync(destino) && fs.statSync(destino).size > min) return destino;
  fs.mkdirSync(PASTA, { recursive: true });
  const r = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!r.ok) throw new Error(`não baixou o modelo de contorno ${arquivo} (${r.status})`);
  fs.writeFileSync(`${destino}.tmp`, Buffer.from(await r.arrayBuffer()));
  fs.renameSync(`${destino}.tmp`, destino);
  return destino;
}

function sessao(nome) {
  sessoes[nome] ??= (async () => {
    ortP ??= import('onnxruntime-node');
    const ort = await ortP;
    // Só CPU: a placa de vídeo fica para o ComfyUI (dividida, o DirectML fica sem memória e trava).
    // Sem "arena" de memória: com ela o uso só cresce a cada imagem e estoura ("bad allocation").
    const opcoes = { executionProviders: ['cpu'], enableCpuMemArena: false, enableMemPattern: false };
    return { ort, s: await ort.InferenceSession.create(await baixar(MODELOS[nome]), opcoes) };
  })().catch((e) => { delete sessoes[nome]; throw e; });
  return sessoes[nome];
}

/** Imagem → { data (RGB), w, h }, sempre 3 canais (foto preto e branco vem com 1). */
async function rgbCru(img) {
  const { data, info } = await sharp(img).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 3) return { data, w: info.width, h: info.height };
  const out = Buffer.alloc(info.width * info.height * 3);
  for (let i = 0; i < info.width * info.height; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = data[i * info.channels + Math.min(c, info.channels - 1)];
  return { data: out, w: info.width, h: info.height };
}

/** Redimensiona uma máscara de 1 canal (o sharp devolve 3 canais se não extrair). */
const redimensionar = (m, w, h, W, H) =>
  sharp(m, { raw: { width: w, height: h, channels: 1 } }).resize(W, H, { fit: 'fill' }).extractChannel(0).raw().toBuffer();

/** BiRefNet: máscara suave 0-255 (w x h) de tudo que é "primeiro plano". */
async function mascaraBirefnet(img, w, h) {
  const { ort, s } = await sessao('birefnet');
  const L = LADO_BIREFNET, n = L * L;
  const { data: px } = await rgbCru(await sharp(img).resize(L, L, { fit: 'fill' }).png().toBuffer());
  const media = [0.485, 0.456, 0.406], desvio = [0.229, 0.224, 0.225];
  const dados = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) dados[c * n + i] = (px[i * 3 + c] / 255 - media[c]) / desvio[c];
  const saida = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', dados, [1, 3, L, L]) });
  const pred = saida[s.outputNames[0]].data;
  const sig = new Float32Array(n);
  let mi = Infinity, ma = -Infinity;
  for (let i = 0; i < n; i++) { const v = 1 / (1 + Math.exp(-pred[i])); sig[i] = v; if (v < mi) mi = v; if (v > ma) ma = v; }
  const m = Buffer.alloc(n);
  for (let i = 0; i < n; i++) m[i] = Math.round(((sig[i] - mi) / (ma - mi || 1)) * 255);
  return redimensionar(m, L, L, w, h);
}

/** MobileSAM: máscara 0/255 (w x h) do objeto dentro da caixa [x0, y0, x1, y1] (pixels). */
async function mascaraSam(img, w, h, caixa) {
  const enc = await sessao('samEncoder');
  const dec = await sessao('samDecoder');
  const { ort } = enc;
  const esc = LADO_SAM / Math.max(w, h);
  const rw = Math.round(w * esc), rh = Math.round(h * esc);
  const { data: px } = await rgbCru(await sharp(img).resize(rw, rh, { fit: 'fill' }).png().toBuffer());
  const entrada = Float32Array.from(px); // HWC, 0-255 (o encoder normaliza e completa até 1024)
  const { image_embeddings: emb } = await enc.s.run({ input_image: new ort.Tensor('float32', entrada, [rh, rw, 3]) });
  const [x0, y0, x1, y1] = caixa.map((v) => v * esc);
  // Caixa (rótulos 2 e 3) + um ponto positivo no meio dela (só a caixa deixa o SAM em dúvida).
  const pontos = new Float32Array([x0, y0, x1, y1, (x0 + x1) / 2, (y0 + y1) / 2]);
  const rotulos = new Float32Array([2, 3, 1]);
  const out = await dec.s.run({
    image_embeddings: emb,
    point_coords: new ort.Tensor('float32', pontos, [1, 3, 2]),
    point_labels: new ort.Tensor('float32', rotulos, [1, 3]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
    orig_im_size: new ort.Tensor('float32', new Float32Array([h, w]), [2]),
  });
  const logits = out.masks.data; // [1,1,h,w]
  const m = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) m[i] = logits[i] > 0 ? 255 : 0;
  return m;
}

/** Fica só com a maior ilha da máscara (some pedaço solto). Devolve 0/255. */
// "abertura" (em pixels da grade de 256) encolhe a máscara antes de separar as ilhas e cresce de
// volta depois: corta as pontes finas (a manga do vizinho encostada) sem comer o alvo.
async function soMaiorIlha(m, w, h, abertura = 0) {
  const L = 256;
  let peq = await redimensionar(m, w, h, L, L);
  if (abertura) peq = await sharp(peq, { raw: { width: L, height: L, channels: 1 } }).erode(abertura).extractChannel(0).raw().toBuffer();
  const rot = new Int32Array(L * L).fill(-1);
  const tamanhos = [];
  for (let i = 0; i < L * L; i++) {
    if (peq[i] < 128 || rot[i] >= 0) continue;
    const id = tamanhos.length; let t = 0; const pilha = [i]; rot[i] = id;
    while (pilha.length) {
      const p = pilha.pop(); t++;
      const x = p % L, y = (p / L) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= L || ny >= L) continue;
        const q = ny * L + nx;
        if (peq[q] >= 128 && rot[q] < 0) { rot[q] = id; pilha.push(q); }
      }
    }
    tamanhos.push(t);
  }
  const maior = tamanhos.indexOf(Math.max(...tamanhos, 0));
  const manter = Buffer.alloc(L * L);
  for (let i = 0; i < L * L; i++) manter[i] = rot[i] === maior ? 255 : 0;
  const volta = abertura ? await sharp(manter, { raw: { width: L, height: L, channels: 1 } }).dilate(abertura).extractChannel(0).raw().toBuffer() : manter;
  return redimensionar(volta, L, L, w, h);
}

/** RGB + alfa → PNG transparente, cortado justo em volta do que sobrou. */
async function montarPng(img, alfa) {
  const { data, w, h } = await rgbCru(img);
  const rgba = Buffer.alloc(w * h * 4);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2];
    rgba[i * 4 + 3] = alfa[i];
    if (alfa[i] > 16) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error('não achei ninguém para contornar');
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).png().toBuffer();
}

/**
 * Recorta o alvo pelo contorno.
 * @param {Buffer} buffer a imagem inteira
 * @param {{x:number,y:number,w:number,h:number}} [area] caixa do alvo em fração (0-1); sem ela, a imagem toda
 * @returns {Promise<Buffer>} PNG com fundo transparente, justo no alvo
 */
export function contornar(buffer, area = { x: 0, y: 0, w: 1, h: 1 }) {
  const tarefa = fila.then(async () => {
    const girada = await sharp(buffer, { animated: false }).rotate().flatten({ background: '#ffffff' }).png().toBuffer();
    const { width: W, height: H } = await sharp(girada).metadata();
    // Folga de 12% em volta da caixa: o contorno do alvo às vezes passa um pouco dela.
    const fx = area.w * 0.12, fy = area.h * 0.12;
    const left = Math.max(0, Math.floor((area.x - fx) * W)), top = Math.max(0, Math.floor((area.y - fy) * H));
    const right = Math.min(W, Math.ceil((area.x + area.w + fx) * W)), bottom = Math.min(H, Math.ceil((area.y + area.h + fy) * H));
    const w = Math.max(1, right - left), h = Math.max(1, bottom - top);
    const img = await sharp(girada).extract({ left, top, width: w, height: h }).png().toBuffer();
    const caixa = [area.x * W - left, area.y * H - top, (area.x + area.w) * W - left, (area.y + area.h) * H - top]
      .map((v, i) => Math.min(i % 2 ? h : w, Math.max(0, v)));

    const fundo = await mascaraBirefnet(img, w, h);
    let alvo = null;
    if (area.w * area.h < 0.9) try { // com a imagem toda (só tirar o fundo) o SAM não ajuda
      const sam = await soMaiorIlha(await mascaraSam(img, w, h, caixa), w, h);
      const cobertura = sam.reduce((s, v) => s + (v ? 1 : 0), 0) / (w * h);
      if (cobertura > 0.01) alvo = sam; // SAM achou algo que faz sentido
    } catch { /* sem SAM: fica só a remoção de fundo */ }

    // Folga de alguns pixels na máscara do SAM (a borda dele é dura); a borda fina vem do BiRefNet.
    const raio = Math.max(2, Math.round(Math.min(w, h) / 120));
    const limite = alvo ? await sharp(alvo, { raw: { width: w, height: h, channels: 1 } }).dilate(raio).blur(raio).extractChannel(0).raw().toBuffer() : null;
    const alfa = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) alfa[i] = limite ? Math.round((fundo[i] * limite[i]) / 255) : fundo[i];
    // Nada muito fora da caixa marcada (5% de folga): o que passa disso é de quem está do lado.
    if (alvo) {
      const fx2 = (caixa[2] - caixa[0]) * 0.05, fy2 = (caixa[3] - caixa[1]) * 0.05;
      for (let i = 0; i < w * h; i++) {
        const x = i % w, y = (i / w) | 0;
        if (x < caixa[0] - fx2 || x > caixa[2] + fx2 || y < caixa[1] - fy2 || y > caixa[3] + fy2) alfa[i] = 0;
      }
    }
    const final = await soMaiorIlha(alfa, w, h, 1);
    for (let i = 0; i < w * h; i++) if (!final[i]) alfa[i] = 0;
    return montarPng(img, alfa);
  });
  fila = tarefa.catch(() => {});
  tarefa.finally(liberarDepois).catch(() => {});
  return tarefa;
}

// Os modelos ocupam 1-2 GB de memória: sem uso por 2 min, libera (o gerador de imagem precisa dela).
let timerLiberar = null;
function liberarDepois() {
  clearTimeout(timerLiberar);
  timerLiberar = setTimeout(async () => {
    for (const [nome, p] of Object.entries(sessoes)) {
      delete sessoes[nome];
      try { await (await p).s.release(); } catch { /* já liberada */ }
    }
  }, 2 * 60_000);
  timerLiberar.unref?.();
}
