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
const SITES_VIDEO = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|twitter\.com|x\.com|reddit\.com|redd\.it|facebook\.com|fb\.watch|vimeo\.com|twitch\.tv|kwai\.com|dailymotion\.com|soundcloud\.com)$/i;
let ytdlp = null;
let ffmpeg = null;

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
export async function iniciarDownloads(caminho = 'yt-dlp', caminhoFfmpeg = 'ffmpeg') {
  try {
    await rodar(caminho, ['--version'], os.tmpdir(), 20_000);
    ytdlp = caminho;
  } catch {
    ytdlp = null;
  }
  try {
    await rodar(caminhoFfmpeg, ['-version'], os.tmpdir(), 20_000);
    ffmpeg = caminhoFfmpeg;
  } catch {
    ffmpeg = null;
  }
  return { ytdlp: !!ytdlp, ffmpeg: !!ffmpeg };
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
      '--no-playlist', '--no-warnings', '--quiet',
      '--match-filter', 'duration <= 900',
      '--max-filesize', `${(tipo === 'audio' ? LIMITE.audio : LIMITE.video) / MB}M`,
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

/**
 * Baixa um anexo e devolve o conteúdo pronto para o sock.sendMessage do Baileys.
 * @param {{url: string, tipo: 'imagem'|'gif'|'video'|'audio'|'documento', nome?: string}} anexo
 * @param {string} legenda
 */
export async function prepararAnexo({ url, tipo, nome }, legenda = '') {
  if ((tipo === 'video' || tipo === 'audio') && ehSiteDeVideo(url)) {
    const { buffer, ext } = await baixarComYtdlp(url, tipo);
    if (tipo === 'audio') return { audio: buffer, mimetype: ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4' };
    if (ext === 'mp4') return { video: buffer, mimetype: 'video/mp4', caption: legenda };
    if (ffmpeg) return { video: await paraMp4(buffer, ext), mimetype: 'video/mp4', caption: legenda };
    return { document: buffer, mimetype: `video/${ext}`, fileName: `video.${ext}`, caption: legenda };
  }

  const ext = extensao(url);
  if (tipo === 'imagem') {
    const { buffer } = await baixarBytes(url, LIMITE.imagem);
    return { image: await comoImagem(buffer), caption: legenda };
  }
  if (tipo === 'gif') {
    const { buffer, tipo: mime } = await baixarBytes(url, LIMITE.gif);
    if (mime === 'video/mp4' || ext === 'mp4') return { video: buffer, mimetype: 'video/mp4', gifPlayback: true, caption: legenda };
    if (ffmpeg) {
      try {
        return { video: await paraMp4(buffer, ext || 'gif', { semAudio: true }), mimetype: 'video/mp4', gifPlayback: true, caption: legenda };
      } catch { /* cai na figurinha animada */ }
    }
    return { sticker: await gifComoFigurinha(buffer) };
  }
  if (tipo === 'video') {
    const { buffer, tipo: mime } = await baixarBytes(url, LIMITE.video);
    if (!mime.startsWith('video/') && ext !== 'mp4') throw new Error(`não é vídeo (${mime || 'tipo desconhecido'})`);
    if (mime === 'video/mp4' || ext === 'mp4') return { video: buffer, mimetype: 'video/mp4', caption: legenda };
    if (ffmpeg) return { video: await paraMp4(buffer, ext || mime.split('/')[1]), mimetype: 'video/mp4', caption: legenda };
    return { document: buffer, mimetype: mime, fileName: nome || nomeDoArquivo(url, 'video'), caption: legenda };
  }
  if (tipo === 'audio') {
    const { buffer, tipo: mime } = await baixarBytes(url, LIMITE.audio);
    if (!mime.startsWith('audio/') && !['mp3', 'm4a', 'ogg', 'opus', 'aac', 'wav'].includes(ext)) throw new Error(`não é áudio (${mime || 'tipo desconhecido'})`);
    return { audio: buffer, mimetype: mime.startsWith('audio/') ? mime : 'audio/mpeg' };
  }
  if (tipo === 'documento') {
    if (!DOCUMENTOS_OK.has(ext)) throw new Error(`tipo de documento não permitido (.${ext || '?'})`);
    const { buffer, tipo: mime } = await baixarBytes(url, LIMITE.documento);
    if (mime === 'text/html') throw new Error('o link é uma página, não um arquivo');
    return { document: buffer, mimetype: MIME_DOC[ext] || 'application/octet-stream', fileName: nome || nomeDoArquivo(url, `arquivo.${ext}`), caption: legenda };
  }
  throw new Error(`tipo de anexo desconhecido: ${tipo}`);
}

/** Compatibilidade: baixa só uma imagem (JPEG). */
export async function baixarImagemDaWeb(url) {
  const { buffer } = await baixarBytes(url, LIMITE.imagem);
  return comoImagem(buffer);
}
