// Templates de meme (API pública do Imgflip, sem chave) e geração de figurinha com texto.
import sharp from 'sharp';

const API = 'https://api.imgflip.com/get_memes';
const HOST_PERMITIDO = 'i.imgflip.com';
const VALIDADE_MS = 12 * 60 * 60 * 1000;

let cache = { em: 0, lista: [] };

/** Lista de templates com até 2 caixas de texto: [{id, nome, url}] (cache de 12h). */
export async function templates() {
  if (cache.lista.length && Date.now() - cache.em < VALIDADE_MS) return cache.lista;
  const r = await fetch(API, { signal: AbortSignal.timeout(15_000) });
  const json = await r.json();
  if (!json.success) throw new Error('Imgflip não respondeu');
  const lista = json.data.memes
    .filter((m) => m.box_count <= 2 && new URL(m.url).hostname === HOST_PERMITIDO)
    .map((m) => ({ id: String(m.id), nome: m.name, url: m.url }));
  cache = { em: Date.now(), lista };
  return lista;
}

/** Texto curto para o prompt: "id | nome" por linha. */
export async function catalogoParaPrompt() {
  try {
    return (await templates()).map((t) => `${t.id} | ${t.nome}`).join('\n');
  } catch {
    return '';
  }
}

const escapar = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Quebra o texto em até 3 linhas e escolhe uma fonte que caiba na largura.
function diagramar(texto, largura, alturaMax) {
  const palavras = texto.toUpperCase().trim().split(/\s+/).filter(Boolean);
  if (!palavras.length) return null;
  for (let fonte = Math.round(largura / 10); fonte >= 16; fonte -= 2) {
    const porLinha = Math.max(4, Math.floor(largura / (fonte * 0.62)));
    const linhas = [];
    let atual = '';
    for (const p of palavras) {
      const teste = atual ? `${atual} ${p}` : p;
      if (teste.length <= porLinha) atual = teste;
      else { if (atual) linhas.push(atual); atual = p; }
    }
    if (atual) linhas.push(atual);
    const cabe = linhas.length * fonte * 1.1 <= alturaMax;
    if (linhas.length <= 3 && linhas.every((l) => l.length <= porLinha) && cabe) return { fonte, linhas };
  }
  return { fonte: 14, linhas: [palavras.join(' ').slice(0, 70)] };
}

function blocoTexto(texto, largura, alturaMax, y0, deBaixo) {
  const d = diagramar(texto || '', largura, alturaMax);
  if (!d) return '';
  const altura = d.fonte * 1.1;
  const inicio = deBaixo ? y0 - altura * (d.linhas.length - 1) : y0 + d.fonte * 0.9;
  return d.linhas
    .map(
      (l, i) =>
        `<text x="${largura / 2}" y="${inicio + i * altura}" font-size="${d.fonte}" text-anchor="middle"` +
        ` font-family="Impact, 'Arial Black', Arial, sans-serif" font-weight="bold" fill="#fff"` +
        ` stroke="#000" stroke-width="${Math.max(2, d.fonte / 12)}" paint-order="stroke">${escapar(l)}</text>`
    )
    .join('');
}

/**
 * Baixa o template, escreve o texto em cima/embaixo (estilo meme) e devolve uma figurinha
 * webp 512×512 com fundo transparente.
 */
export async function figurinhaDeMeme({ id, cima = '', baixo = '' }) {
  const t = (await templates()).find((x) => x.id === String(id));
  if (!t) throw new Error(`template ${id} não existe`);
  const url = new URL(t.url);
  if (url.protocol !== 'https:' || url.hostname !== HOST_PERMITIDO) throw new Error('URL de template não permitida');

  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`não baixou o template (${r.status})`);
  const original = Buffer.from(await r.arrayBuffer());

  return figurinhaDeImagem(original, { cima, baixo, recorte: 'inteira' });
}

/**
 * Figurinha a partir de uma imagem qualquer (mandada no grupo, achada na web...), com texto
 * opcional em cima/embaixo. recorte "quadrado" corta o centro; "inteira" mantém a imagem toda.
 */
export async function figurinhaDeImagem(buffer, { cima = '', baixo = '', recorte = 'inteira' } = {}) {
  const base = await sharp(buffer, { animated: false })
    .resize(512, 512, recorte === 'quadrado' ? { fit: 'cover', position: 'centre' } : { fit: 'inside' })
    .png()
    .toBuffer();
  const { width: w, height: h } = await sharp(base).metadata();
  const margem = Math.round(h * 0.03);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      blocoTexto(cima, w, h * 0.4, margem, false) +
      blocoTexto(baixo, w, h * 0.4, h - margem - 4, true) +
      '</svg>'
  );
  const comTexto = await sharp(base).composite([{ input: svg }]).png().toBuffer();
  return sharp(comTexto)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90 })
    .toBuffer();
}

const CORES = {
  branco: ['#ffffff', '#000000'], preto: ['#111111', '#ffffff'], amarelo: ['#ffd500', '#000000'],
  vermelho: ['#ff2d2d', '#ffffff'], azul: ['#2d7bff', '#ffffff'], verde: ['#22c55e', '#000000'],
  rosa: ['#ff5fb3', '#ffffff'], roxo: ['#9b5cff', '#ffffff'], laranja: ['#ff8a00', '#000000'],
};

/** Figurinha só de texto: letras grandes com contorno, fundo transparente. */
export async function figurinhaDeTexto(texto, { cor = 'branco' } = {}) {
  const [preenchimento, contorno] = CORES[cor] || CORES.branco;
  const palavras = String(texto || '').trim().split(/\s+/).filter(Boolean);
  if (!palavras.length) throw new Error('sem texto para a figurinha');
  // Acha a maior fonte em que o texto cabe em até 5 linhas dentro de 480×480.
  let escolha = null;
  for (let fonte = 120; fonte >= 28; fonte -= 4) {
    const porLinha = Math.max(3, Math.floor(480 / (fonte * 0.6)));
    const linhas = [];
    let atual = '';
    for (const p of palavras) {
      const teste = atual ? `${atual} ${p}` : p;
      if (teste.length <= porLinha) atual = teste;
      else { if (atual) linhas.push(atual); atual = p; }
    }
    if (atual) linhas.push(atual);
    if (linhas.length <= 5 && linhas.every((l) => l.length <= porLinha) && linhas.length * fonte * 1.15 <= 480) {
      escolha = { fonte, linhas };
      break;
    }
  }
  escolha ||= { fonte: 28, linhas: [palavras.join(' ').slice(0, 80)] };
  const { fonte, linhas } = escolha;
  const altura = fonte * 1.15;
  const y0 = 256 - (altura * (linhas.length - 1)) / 2 + fonte * 0.35;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">` +
    linhas
      .map(
        (l, i) =>
          `<text x="256" y="${y0 + i * altura}" font-size="${fonte}" text-anchor="middle"` +
          ` font-family="Impact, 'Arial Black', Arial, sans-serif" font-weight="bold" fill="${preenchimento}"` +
          ` stroke="${contorno}" stroke-width="${Math.max(3, fonte / 9)}" paint-order="stroke">${escapar(l)}</text>`
      )
      .join('') +
    '</svg>';
  return sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer();
}
