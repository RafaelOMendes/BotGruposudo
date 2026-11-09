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

// Onde vai o texto nos templates com painéis/balões (frações da imagem: x, y, largura, altura).
// O resto usa o clássico: cima no topo, baixo no rodapé.
const DIREITA = { cima: [0.5, 0, 0.5, 0.5], baixo: [0.5, 0.5, 0.5, 0.5], dica: 'cima = painel de cima (rejeita), baixo = painel de baixo (prefere)' };
const LAYOUTS = {
  181913649: DIREITA, // Drake
  91998305: DIREITA, // Drake Blank
  178591752: { cima: [0.5, 0, 0.5, 0.53], baixo: [0.5, 0.53, 0.5, 0.47], dica: 'cima = coisa comum, baixo = versão chique' },
  129315248: { cima: [0.4, 0.03, 0.57, 0.44], baixo: [0.4, 0.52, 0.57, 0.44], dica: 'cima = o "não", baixo = o "sim"' },
  99683372: { cima: [0, 0, 0.5, 0.5], baixo: [0, 0.5, 0.5, 0.5], dica: 'cima = o que dá sono, baixo = o que acorda' },
  188390779: { cima: [0, 0, 0.5, 0.27], baixo: [0.5, 0, 0.5, 0.27], dica: 'cima = fala da mulher gritando, baixo = resposta do gato' },
  217743513: { cima: [0.07, 0.2, 0.35, 0.28], baixo: [0.5, 0, 0.5, 0.2], dica: 'cima = o que está na carta (a alternativa), baixo = o cara que prefere comprar 25' },
  129242436: { cima: [0.42, 0.6, 0.45, 0.22], baixo: [0, 0, 1, 0.2], dica: 'cima = frase da placa, baixo = legenda no topo (opcional)' },
  252600902: { cima: [0, 0, 0.5, 0.22], baixo: [0.45, 0, 0.55, 0.15], dica: 'cima = "espera, é tudo X?", baixo = "sempre foi"' },
  438680: { cima: [0.02, 0.02, 0.45, 0.22], baixo: [0.52, 0.02, 0.46, 0.22], dica: 'cima = balão do Robin, baixo = balão do Batman (o tapa)' },
  110133729: { cima: [0, 0, 0.5, 0.3], baixo: [0.5, 0, 0.5, 0.3], dica: 'cima = homem-aranha da esquerda, baixo = o da direita' },
  67452763: { cima: [0, 0, 0.5, 0.4], baixo: [0.5, 0, 0.5, 0.4], dica: 'cima = Lula Molusco sozinho, baixo = a diversão lá fora' },
  354700819: { cima: [0, 0.05, 0.42, 0.38], baixo: [0.55, 0.05, 0.45, 0.35], dica: 'cima = janela do triste, baixo = janela do feliz' },
  148909805: { cima: [0, 0, 1, 0.4], baixo: [0, 0.8, 1, 0.2], dica: 'cima = a situação, baixo = punchline curta (opcional)' },
  221578498: { cima: [0.06, 0.18, 0.36, 0.33], baixo: [0.5, 0.48, 0.5, 0.2], dica: 'cima = no túmulo (o que morreu), baixo = quem está feliz' },
};

/** Texto curto para o prompt: "id | nome" por linha (e onde vai o texto, quando não é o clássico). */
export async function catalogoParaPrompt() {
  try {
    return (await templates()).map((t) => `${t.id} | ${t.nome}${LAYOUTS[t.id] ? ` (${LAYOUTS[t.id].dica})` : ''}`).join('\n');
  } catch {
    return '';
  }
}

const escapar = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Quebra o texto em até `maxLinhas` linhas e escolhe a maior fonte que caiba na caixa.
function diagramar(texto, largura, alturaMax, maxLinhas = 3) {
  const palavras = texto.toUpperCase().trim().split(/\s+/).filter(Boolean);
  if (!palavras.length) return null;
  for (let fonte = Math.round(Math.min(largura / 5, alturaMax / 2, 64)); fonte >= 16; fonte -= 2) {
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
    if (linhas.length <= maxLinhas && linhas.every((l) => l.length <= porLinha) && cabe) return { fonte, linhas };
  }
  return { fonte: 14, linhas: [palavras.join(' ').slice(0, 70)] };
}

/** Texto dentro da caixa (x, y, w, h em px), alinhado no topo, no meio ou na base. */
function blocoTexto(texto, { x, y, w, h }, alinhar = 'meio') {
  const pad = Math.max(4, Math.round(w * 0.04));
  const d = diagramar(texto || '', w - 2 * pad, h - 2 * pad, alinhar === 'meio' ? 5 : 3);
  if (!d) return '';
  const altura = d.fonte * 1.1;
  const total = altura * (d.linhas.length - 1) + d.fonte * 0.9;
  const topo = alinhar === 'topo' ? y + pad : alinhar === 'base' ? y + h - pad - total : y + (h - total) / 2;
  const inicio = topo + d.fonte * 0.9;
  return d.linhas
    .map(
      (l, i) =>
        `<text x="${x + w / 2}" y="${inicio + i * altura}" font-size="${d.fonte}" text-anchor="middle"` +
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

  return figurinhaDeImagem(original, { cima, baixo, recorte: 'inteira', layout: LAYOUTS[t.id] });
}

/**
 * Figurinha a partir de uma imagem qualquer (mandada no grupo, achada na web...), com texto
 * opcional em cima/embaixo. recorte "quadrado" corta o centro; "inteira" mantém a imagem toda.
 */
export async function figurinhaDeImagem(buffer, { cima = '', baixo = '', recorte = 'inteira', layout = null } = {}) {
  const base = await sharp(buffer, { animated: false })
    .resize(512, 512, recorte === 'quadrado' ? { fit: 'cover', position: 'centre' } : { fit: 'inside' })
    .png()
    .toBuffer();
  const { width: w, height: h } = await sharp(base).metadata();
  const caixa = (f) => ({ x: f[0] * w, y: f[1] * h, w: f[2] * w, h: f[3] * h });
  const textos = layout
    ? [layout.cima ? blocoTexto(cima, caixa(layout.cima)) : '', layout.baixo ? blocoTexto(baixo, caixa(layout.baixo)) : '']
    : [blocoTexto(cima, { x: 0, y: 0, w, h: h * 0.4 }, 'topo'), blocoTexto(baixo, { x: 0, y: h * 0.6, w, h: h * 0.4 }, 'base')];
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${textos.join('')}</svg>`);
  const comTexto = await sharp(base).composite([{ input: svg }]).png().toBuffer();
  return sharp(comTexto)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90 })
    .toBuffer();
}

/** Aplica filtros numa imagem parada (antes de virar figurinha). Devolve PNG. */
export async function aplicarEfeitos(buffer, efeitos = []) {
  if (!efeitos?.length) return buffer;
  let img = sharp(buffer, { animated: false }).ensureAlpha();
  for (const e of efeitos) {
    if (e === 'inverter_cores') img = img.negate({ alpha: false });
    else if (e === 'preto_e_branco') img = img.grayscale();
    else if (e === 'sepia') img = img.recomb([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]]);
    else if (e === 'espelhar') img = img.flop();
    else if (e === 'virar_de_cabeca_pra_baixo') img = img.flip();
    else if (e === 'desfocar') img = img.blur(6);
    else if (e === 'saturar') img = img.modulate({ saturation: 2 });
    else if (e === 'brilho_alto') img = img.modulate({ brightness: 1.4 });
    else if (e === 'escurecer') img = img.modulate({ brightness: 0.6 });
    else if (e === 'girar_90' || e === 'pixelar') {
      // rotate/resize em cadeia no sharp precisam de um buffer intermediário
      const meio = await img.png().toBuffer();
      const { width: w, height: h } = await sharp(meio).metadata();
      img = e === 'girar_90'
        ? sharp(meio).rotate(90)
        : sharp(await sharp(meio).resize(Math.max(8, Math.round(w / 16)), Math.max(8, Math.round(h / 16))).png().toBuffer())
          .resize(w, h, { kernel: 'nearest' });
    }
    img = sharp(await img.png().toBuffer()); // cada filtro em cima do resultado do anterior
  }
  return img.png().toBuffer();
}

/** Os mesmos filtros como filtro do ffmpeg (figurinha animada). */
export function filtroFfmpeg(efeitos = []) {
  const mapa = {
    inverter_cores: 'negate', preto_e_branco: 'hue=s=0', sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
    espelhar: 'hflip', virar_de_cabeca_pra_baixo: 'vflip', girar_90: 'transpose=1', desfocar: 'boxblur=6',
    pixelar: 'scale=iw/16:ih/16,scale=iw*16:ih*16:flags=neighbor', saturar: 'eq=saturation=2',
    brilho_alto: 'eq=brightness=0.15', escurecer: 'eq=brightness=-0.2',
  };
  return (efeitos || []).map((e) => mapa[e]).filter(Boolean).join(',');
}

/** Camada PNG 512×512 transparente só com o texto (cima/baixo), para pôr sobre figurinha animada. */
export async function camadaDeTexto({ cima = '', baixo = '' } = {}) {
  if (!cima.trim() && !baixo.trim()) return null;
  const w = 512;
  const h = 512;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    blocoTexto(cima, { x: 0, y: 0, w, h: h * 0.4 }, 'topo') + blocoTexto(baixo, { x: 0, y: h * 0.6, w, h: h * 0.4 }, 'base') + '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
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
