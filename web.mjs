// Baixa conteúdo da internet com segurança para mandar no WhatsApp. As URLs vêm do Claude, que
// pode ter sido influenciado por mensagens do grupo ou por páginas da web, então:
//  - só https, sem usuário/senha na URL e só na porta padrão;
//  - recusa endereços da máquina, da rede local e afins (checa o DNS a cada redirecionamento);
//  - limite de tamanho por tipo; imagens são validadas e convertidas com o sharp;
//  - documentos só em formatos inofensivos (nada de .exe, .bat, .apk...).
// Vídeos/áudios de sites (YouTube, TikTok, Instagram, X...) são baixados com o yt-dlp, se instalado.
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const MB = 1024 * 1024;
const LIMITE = { imagem: 8 * MB, gif: 15 * MB, video: 45 * MB, audio: 16 * MB, documento: 50 * MB };
const MAX_REDIRECTS = 3;
const DOCUMENTOS_OK = new Set(['pdf', 'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'epub', 'rtf', 'md', 'json']);
const MIME_DOC = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', epub: 'application/epub+zip', rtf: 'application/rtf',
};

function ipPrivado(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return ipPrivado(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
}

async function validarUrl(texto) {
  const url = new URL(texto);
  if (url.protocol !== 'https:') throw new Error('só https');
  if (url.username || url.password) throw new Error('URL com credenciais');
  if (url.port && url.port !== '443') throw new Error('porta não permitida');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const enderecos = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!enderecos.length || enderecos.some((e) => ipPrivado(e.address))) throw new Error('endereço não permitido');
  return url;
}

/** GET com checagem de endereço a cada redirecionamento e limite de bytes. */
async function baixarBytes(endereco, maxBytes) {
  let url = await validarUrl(endereco);
  let resposta;
  for (let i = 0; ; i++) {
    resposta = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BotDoGabreu' },
    });
    const destino = resposta.headers.get('location');
    if (resposta.status >= 300 && resposta.status < 400 && destino) {
      if (i >= MAX_REDIRECTS) throw new Error('redirecionamentos demais');
      url = await validarUrl(new URL(destino, url).toString());
      continue;
    }
    break;
  }
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  if (Number(resposta.headers.get('content-length') || 0) > maxBytes) throw new Error(`arquivo maior que ${maxBytes / MB} MB`);

  const partes = [];
  let total = 0;
  for await (const parte of resposta.body) {
    total += parte.length;
    if (total > maxBytes) throw new Error(`arquivo maior que ${maxBytes / MB} MB`);
    partes.push(parte);
  }
  return { buffer: Buffer.concat(partes), tipo: (resposta.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), url };
}

const extensao = (url) => (path.extname(new URL(url).pathname).slice(1) || '').toLowerCase();
const nomeDoArquivo = (url, padrao) => decodeURIComponent(path.basename(new URL(url).pathname)) || padrao;

// ---------- yt-dlp (opcional) ----------
const SITES_VIDEO = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|twitter\.com|x\.com|threads\.net|threads\.com|reddit\.com|redd\.it|facebook\.com|fb\.watch|vimeo\.com|twitch\.tv|kwai\.com|kw\.ai|dailymotion\.com|soundcloud\.com|pinterest\.com|pin\.it|bilibili\.com|streamable\.com|snapchat\.com|linkedin\.com|tumblr\.com|9gag\.com|imgur\.com|bsky\.app)$/i;
let ytdlp = null;
let ffmpeg = null;
let cookies = null;

// O bot pode ter sido iniciado por um processo com o PATH antigo (antes de instalar as
// ferramentas). Então, se não achar no PATH, procura nas pastas onde o winget instala.
function procurarExecutavel(nome) {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const links = path.join(local, 'Microsoft', 'WinGet', 'Links', `${nome}.exe`);
  if (fs.existsSync(links)) return links;
  const pacotes = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  if (!fs.existsSync(pacotes)) return null;
  const busca = (dir, nivel) => {
    if (nivel > 3) return null;
    let itens;
    try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    const exe = itens.find((i) => i.isFile() && i.name.toLowerCase() === `${nome}.exe`);
    if (exe) return path.join(dir, exe.name);
    for (const i of itens) {
      if (!i.isDirectory()) continue;
      const achou = busca(path.join(dir, i.name), nivel + 1);
      if (achou) return achou;
    }
    return null;
  };
  // Prioriza o pacote com o nome da ferramenta (ex: yt-dlp.yt-dlp, Gyan.FFmpeg).
  const dirs = fs.readdirSync(pacotes).sort((a, b) => Number(b.toLowerCase().includes(nome)) - Number(a.toLowerCase().includes(nome)));
  for (const d of dirs) {
    const achou = busca(path.join(pacotes, d), 1);
    if (achou) return achou;
  }
  return null;
}

// Coloca a pasta do executável no PATH deste processo (o yt-dlp precisa achar o ffmpeg e o deno).
function adicionarAoPath(arquivo) {
  if (!arquivo) return;
  const dir = path.dirname(arquivo);
  const atual = process.env.PATH || '';
  if (!atual.split(path.delimiter).includes(dir)) process.env.PATH = `${dir}${path.delimiter}${atual}`;
}

async function acharFerramenta(preferido, nome, argVersao) {
  for (const candidato of [preferido, procurarExecutavel(nome)].filter(Boolean)) {
    try {
      await rodar(candidato, [argVersao], os.tmpdir(), 20_000);
      if (path.isAbsolute(candidato)) adicionarAoPath(candidato);
      return candidato;
    } catch { /* tenta o próximo */ }
  }
  return null;
}

function rodar(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('download demorou demais')); }, timeoutMs);
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `yt-dlp saiu com ${code}`)); });
  });
}

/** Procura o yt-dlp (e diz se dá para juntar áudio+vídeo, o que precisa do ffmpeg). */
export async function iniciarDownloads(caminho = 'yt-dlp', caminhoFfmpeg = 'ffmpeg', arquivoCookies = '') {
  // cookies.txt (formato Netscape) de uma conta logada: libera Instagram/Reddit/X que pedem login.
  cookies = arquivoCookies && fs.existsSync(arquivoCookies) ? arquivoCookies : null;
  ffmpeg = await acharFerramenta(caminhoFfmpeg, 'ffmpeg', '-version');
  adicionarAoPath(procurarExecutavel('deno')); // o yt-dlp usa o deno no YouTube
  ytdlp = await acharFerramenta(caminho, 'yt-dlp', '--version');
  return { ytdlp: !!ytdlp, ffmpeg: !!ffmpeg, cookies: !!cookies, caminhoYtdlp: ytdlp, caminhoFfmpeg: ffmpeg };
}

/** Converte GIF/vídeo para MP4 (H.264 + AAC) que o WhatsApp toca. Precisa do ffmpeg. */
async function paraMp4(buffer, extEntrada, { semAudio = false } = {}) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-gabreu-ff-'));
  try {
    const entrada = path.join(pasta, `in.${extEntrada || 'bin'}`);
    fs.writeFileSync(entrada, buffer);
    await rodar(ffmpeg, [
      '-y', '-i', entrada,
      '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(min(iw\\,1280)/2)*2:-2', // largura par e no máx. 1280 (a vírgula precisa de escape)
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      ...(semAudio ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']),
      'saida.mp4',
    ], pasta, 3 * 60_000);
    return fs.readFileSync(path.join(pasta, 'saida.mp4'));
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}
export const temDownloaderDeVideo = () => !!ytdlp;
export const ehSiteDeVideo = (url) => { try { return SITES_VIDEO.test(new URL(url).hostname); } catch { return false; } };

async function baixarComYtdlp(url, tipo) {
  if (!ytdlp) throw new Error('yt-dlp não instalado');
  await validarUrl(url);
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-gabreu-dl-'));
  try {
    const formato = tipo === 'audio'
      ? 'ba[ext=m4a]/ba[ext=mp3]/ba'
      // Prefere mp4 já com áudio (não precisa de ffmpeg); 720p no máximo.
      : 'b[ext=mp4][height<=720]/bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[height<=720]/b';
    await rodar(ytdlp, [
      '--no-playlist', '--playlist-items', '1', '--no-warnings', '--quiet',
      // "<=?" aceita quando o site não informa a duração (Instagram, X...).
      '--match-filter', 'duration <=? 900',
      '--max-filesize', `${(tipo === 'audio' ? LIMITE.audio : LIMITE.video) / MB}M`,
      ...(cookies ? ['--cookies', cookies] : []),
      '-f', formato, '-o', 'midia.%(ext)s', url,
    ], pasta, 5 * 60_000);
    const arquivo = fs.readdirSync(pasta).find((f) => f.startsWith('midia.') && !f.endsWith('.part'));
    if (!arquivo) throw new Error('nada baixado (vídeo longo/grande demais ou indisponível)');
    const buffer = fs.readFileSync(path.join(pasta, arquivo));
    const ext = path.extname(arquivo).slice(1).toLowerCase();
    return { buffer, ext };
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

// ---------- conversões ----------
async function comoImagem(buffer) {
  return sharp(buffer, { animated: false })
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
}

// Sem ffmpeg, GIF vira figurinha animada (o WhatsApp só toca "GIF" como vídeo mp4).
async function gifComoFigurinha(buffer) {
  return sharp(buffer, { animated: true })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 70 })
    .toBuffer();
}

// Formatos que o WhatsApp toca direto; o resto é convertido com o ffmpeg.
// (.ogg/.opus da web podem ser Vorbis, que o WhatsApp não toca: esses passam pelo ffmpeg.)
const AUDIO_NATIVO = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac' };
const EXT_AUDIO = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac', 'webm', 'weba', 'wma', 'amr'];
const EXT_VIDEO = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', '3gp', 'wmv', 'flv'];
const EXT_IMAGEM = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic'];

/** Converte qualquer áudio para MP3 (o WhatsApp toca). Precisa do ffmpeg. */
async function paraMp3(buffer, extEntrada) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-gabreu-ff-'));
  try {
    const entrada = path.join(pasta, `in.${extEntrada || 'bin'}`);
    fs.writeFileSync(entrada, buffer);
    await rodar(ffmpeg, ['-y', '-i', entrada, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', 'saida.mp3'], pasta, 3 * 60_000);
    return fs.readFileSync(path.join(pasta, 'saida.mp3'));
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

/** Qual é o tipo de verdade do arquivo (pelo content-type, depois pela extensão). */
function tipoReal(mime, ext, pedido) {
  if (mime === 'image/gif' || ext === 'gif') return 'gif';
  if (mime.startsWith('image/') || EXT_IMAGEM.includes(ext)) return 'imagem';
  if (mime.startsWith('video/') || EXT_VIDEO.includes(ext)) return pedido === 'audio' ? 'audio' : 'video';
  if (mime.startsWith('audio/') || EXT_AUDIO.includes(ext)) return 'audio';
  if (DOCUMENTOS_OK.has(ext) || mime === 'application/pdf') return 'documento';
  return null;
}

/** Monta a mensagem no tipo certo: vídeo vai como vídeo, áudio como áudio, etc. */
async function montar(tipo, buffer, { mime = '', ext = '', nome = '', url = '', legenda = '' }) {
  if (tipo === 'imagem') return { image: await comoImagem(buffer), caption: legenda };

  if (tipo === 'gif') {
    if (mime === 'video/mp4' || ext === 'mp4') return { video: buffer, mimetype: 'video/mp4', gifPlayback: true, caption: legenda };
    if (ffmpeg) {
      try {
        return { video: await paraMp4(buffer, ext || 'gif', { semAudio: true }), mimetype: 'video/mp4', gifPlayback: true, caption: legenda };
      } catch { /* cai na figurinha animada */ }
    }
    return { sticker: await gifComoFigurinha(buffer) };
  }

  if (tipo === 'video') {
    if (mime === 'video/mp4' || ext === 'mp4') return { video: buffer, mimetype: 'video/mp4', caption: legenda };
    if (ffmpeg) return { video: await paraMp4(buffer, ext || (mime.split('/')[1] || 'bin')), mimetype: 'video/mp4', caption: legenda };
    return { document: buffer, mimetype: mime || 'video/mp4', fileName: nome || `video.${ext || 'mp4'}`, caption: legenda };
  }

  if (tipo === 'audio') {
    if (AUDIO_NATIVO[ext] && !EXT_VIDEO.includes(ext)) return { audio: buffer, mimetype: AUDIO_NATIVO[ext] };
    if (mime === 'audio/mpeg') return { audio: buffer, mimetype: 'audio/mpeg' };
    if (ffmpeg) return { audio: await paraMp3(buffer, ext || (mime.split('/')[1] || 'bin')), mimetype: 'audio/mpeg' };
    return { document: buffer, mimetype: mime || 'audio/mpeg', fileName: nome || `audio.${ext || 'mp3'}`, caption: legenda };
  }

  if (tipo === 'documento') {
    if (!DOCUMENTOS_OK.has(ext) && mime !== 'application/pdf') throw new Error(`tipo de documento não permitido (.${ext || '?'})`);
    const e = DOCUMENTOS_OK.has(ext) ? ext : 'pdf';
    return { document: buffer, mimetype: MIME_DOC[e] || 'application/octet-stream', fileName: nome || nomeDoArquivo(url, `arquivo.${e}`), caption: legenda };
  }
  throw new Error(`tipo de anexo desconhecido: ${tipo}`);
}

/**
 * Baixa um anexo e devolve o conteúdo pronto para o sock.sendMessage do Baileys, no tipo real do
 * arquivo (vídeo como vídeo, áudio como áudio, imagem como imagem, documento como documento).
 * @param {{url: string, tipo: 'imagem'|'gif'|'video'|'audio'|'documento', nome?: string}} anexo
 * @param {string} legenda
 */
export async function prepararAnexo({ url, tipo, nome }, legenda = '') {
  // Redes sociais (TikTok, X, YouTube, Instagram...): baixa com o yt-dlp.
  if (ehSiteDeVideo(url) && tipo !== 'imagem' && tipo !== 'documento') {
    const { buffer, ext } = await baixarComYtdlp(url, tipo === 'audio' ? 'audio' : 'video');
    return montar(tipo === 'audio' ? 'audio' : 'video', buffer, { ext, nome, url, legenda });
  }

  // Arquivo direto: baixa uma vez e decide pelo tipo de verdade (o "tipo" do Claude é só uma dica).
  if (tipo === 'documento' && !DOCUMENTOS_OK.has(extensao(url)) && extensao(url)) {
    throw new Error(`tipo de documento não permitido (.${extensao(url)})`);
  }
  const limite = LIMITE[tipo] || LIMITE.documento;
  const { buffer, tipo: mime } = await baixarBytes(url, Math.max(limite, LIMITE.video));
  if (mime === 'text/html') throw new Error('o link é uma página, não um arquivo');
  const ext = extensao(url);
  const real = tipoReal(mime, ext, tipo);
  if (!real) throw new Error(`não sei mandar esse tipo de arquivo (${mime || ext || 'desconhecido'})`);
  if (buffer.length > LIMITE[real]) throw new Error(`${real} maior que ${LIMITE[real] / MB} MB`);
  return montar(real, buffer, { mime, ext, nome, url, legenda });
}

/** Compatibilidade: baixa só uma imagem (JPEG). */
export async function baixarImagemDaWeb(url) {
  const { buffer } = await baixarBytes(url, LIMITE.imagem);
  return comoImagem(buffer);
}
