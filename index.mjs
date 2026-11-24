// Bot do Gabreu, no grupo configurado:
//  1. Gabriel manda uma mensagem só de interrogações ("?", "??", "????"...) → responde com o
//     áudio em audio/gabreu.ogg (mensagem de voz).
//  2. Nicolas manda figurinha ou imagem → o Claude (via `claude -p`, sem chave de API) decide se é non-sense; se for, responde
//     com uma figurinha zoando: figurinhas/manda-figurinha.webp (para figurinha) ou
//     figurinhas/manda-imagem.webp (para imagem).
//  3. Alguém marca o bot (@) num grupo → o Claude lê a mensagem (com o contexto recente) e responde,
//     ou cria/apaga uma regra ("quando o Bernardo mandar X, faça Y"), salva em regras.json.
//
// Usa Baileys (protocolo do WhatsApp direto, sem navegador). Os pedidos de reenvio que o
// iPhone faz quando não consegue descriptografar ("Aguardando mensagem") são atendidos via getMessage.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import NodeCache from '@cacheable/node-cache';
import makeWASocket, {
  Browsers,
  BufferJSON,
  proto,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidNormalizedUser,
  useMultiFileAuthState,
} from 'baileys';
import { acharArea, agoraBrasil, avaliarEntregas, avaliarNonsense, configurarModelos, falaramComOBot, implementarNoCodigo, iniciarIA, interpretarMencao, julgarBanimento, memeDeRegra, responderNoPrivado, respostaDeRegra } from './ia.mjs';
import { iniciarAvisos, listaParaPergunta, PERGUNTA_ENTREGA } from './entregas.mjs';
import { vigiarLogin, manterMateriais, indiceMateriais, idsDeLinkClassroom, PASTA_MATERIAIS, PERGUNTA_AULA } from './classroom.mjs';
import { contornar } from './contorno.mjs';
import { aplicarEfeitos, camadaDeTexto, catalogoParaPrompt, filtroFfmpeg, figurinhaDeImagem, figurinhaDeMeme, figurinhaDeTexto } from './memes.mjs';
import { Regras } from './regras.mjs';
import { configurarGerador, desligarGerador, disponivel as temGerador, gerarImagem } from './gerador.mjs';
import { gerarPdf, gerarPdfConversa } from './pdf.mjs';
import { decifrarEdicao, guardarSegredo } from './edicoes.mjs';
import { contagem, encerrar, enquetesAbertas, novoSegredo, registrarEnquete, registrarVoto } from './enquetes.mjs';
import { agendar, pendentes, vencidas, salvarAgenda, cancelar as cancelarAgendada } from './agenda.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { baixarImagemDaWeb, baixarMidiaDaWeb, ehAnimada, ehSiteDeVideo, figurinhaAnimada, figurinhaParaMidia, iniciarDownloads, prepararAnexo, temDownloaderDeVideo } from './web.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// "node index.mjs --verificar": só carrega os módulos (pega import quebrado) e sai. Usado antes de
// reiniciar depois de o bot mudar o próprio código.
if (process.argv.includes('--verificar')) process.exit(0);

// ---------- configuração ----------
// Valores padrão, sobrescritos por config.json (local, fora do git) e por variáveis de ambiente.
const arquivoConfig = path.join(DIR, 'config.json');
const local = fs.existsSync(arquivoConfig) ? JSON.parse(fs.readFileSync(arquivoConfig, 'utf8')) : {};
const CONFIG = {
  grupo: process.env.BOT_GRUPO || local.grupo || 'Gruposudo',
  remetente: process.env.BOT_REMETENTE || local.remetente || 'Gabriel Lassen',
  // IDs do WhatsApp do Gabriel (ex: "123...@lid" ou "5511999999999@s.whatsapp.net"). Mais confiável que o nome.
  ids: (process.env.BOT_IDS ? process.env.BOT_IDS.split(',') : local.ids || []).map((s) => s.trim()),
  gatilho: /^[?？]+$/,
  // Dono do bot (Rafa): acesso total; o que o bot não souber fazer, ele programa no próprio código.
  donos: (local.donos || ['555599806277']).map((s) => String(s).replace(/\D/g, '')),
  audio: path.join(DIR, 'audio', 'gabreu.ogg'),
  // Mensagens mais velhas que isso (ex: entregues ao reconectar) são ignoradas.
  idadeMaxSeg: 10 * 60,
  figurinha: {
    remetente: local.figurinha?.remetente || 'Nicolas Bresolin',
    ids: (local.figurinha?.ids || []).map((s) => s.trim()),
    // Resposta para figurinha e para imagem (webp 512×512).
    arquivo: path.join(DIR, local.figurinha?.arquivo || 'figurinhas/manda-figurinha.webp'),
    arquivoImagem: path.join(DIR, local.figurinha?.arquivoImagem || 'figurinhas/manda-imagem.webp'),
    // Intervalo mínimo entre respostas (evita spam e gasto com a IA).
    intervaloSeg: local.figurinha?.intervaloSeg ?? 60,
    // Se o `claude` não estiver disponível: chance de responder mesmo assim (1 = sempre, 0 = nunca).
    chanceSemIA: local.figurinha?.chanceSemIA ?? 1,
  },
  // Caminho do Claude Code CLI (já logado). Padrão: `claude` no PATH.
  claude: process.env.CLAUDE_CLI_PATH || local.claude || 'claude',
  // Geração de imagem local (ComfyUI + Z-Image Turbo na placa de vídeo).
  gerador: {
    ativo: local.gerador?.ativo ?? true,
    pasta: local.gerador?.pasta || 'E:/IA/ComfyUI_windows_portable',
    porta: local.gerador?.porta ?? 8188,
    liberarVramMin: local.gerador?.liberarVramMin ?? 5,
  },
  // Link de rede social (TikTok, Instagram, X, YouTube...) no grupo → o bot baixa e manda o vídeo.
  links: {
    ativo: local.links?.ativo ?? true,
    intervaloSeg: local.links?.intervaloSeg ?? 5,
  },
  mencao: {
    ativo: local.mencao?.ativo ?? true,
    // Intervalo mínimo entre respostas para a mesma pessoa.
    intervaloSeg: local.mencao?.intervaloSeg ?? 10,
    // Quantas mensagens recentes do grupo vão como contexto.
    historico: local.mencao?.historico ?? 100,
    // Quando pedem para ler/resumir a conversa ("lê aí", "o que o fulano falou?"), vai até este tanto.
    historicoLeitura: local.mencao?.historicoLeitura ?? 200,
  },
};

// ---------- log ----------
const LOG_FILE = path.join(DIR, 'bot.log');
const LOG_MAX = 5 * 1024 * 1024; // passou de 5 MB → vira bot.log.1 (o antigo .1 é apagado)
function log(...args) {
  const line = `[${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] ${args.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch { /* segue no mesmo arquivo */ }
  fs.appendFileSync(LOG_FILE, line + '\n');
}
const logger = pino({ level: 'silent' });

// ---------- faxina: apaga pastas temporárias do bot que sobraram (ex: bot fechado no meio de um download) ----------
function faxinaTemporarios() {
  const tmp = os.tmpdir();
  let apagadas = 0;
  for (const nome of fs.readdirSync(tmp)) {
    if (!nome.startsWith('bot-gabreu-')) continue;
    const caminho = path.join(tmp, nome);
    try {
      if (Date.now() - fs.statSync(caminho).mtimeMs < 60 * 60 * 1000) continue; // deixa as recentes (podem estar em uso)
      fs.rmSync(caminho, { recursive: true, force: true });
      apagadas++;
    } catch { /* em uso; tenta na próxima */ }
  }
  if (apagadas) log(`Faxina: ${apagadas} pasta(s) temporária(s) antiga(s) apagada(s).`);
}
faxinaTemporarios();
setInterval(faxinaTemporarios, 6 * 60 * 60 * 1000).unref();

// ---------- trava de instância única ----------
const LOCK = path.join(DIR, '.bot.lock');
function processoVivo(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
if (fs.existsSync(LOCK)) {
  const pid = Number(fs.readFileSync(LOCK, 'utf8'));
  if (pid && pid !== process.pid && processoVivo(pid)) {
    log(`Já existe outra instância do bot rodando (PID ${pid}); saindo.`);
    process.exit(2); // start.cmd não reinicia com código 2
  }
}
fs.writeFileSync(LOCK, String(process.pid));
const liberarLock = () => {
  try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK); } catch {}
};
process.on('exit', liberarLock);
for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => process.exit(0));

// ---------- utilidades ----------
const normalizar = (s) =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const textoDa = (m) => {
  const c = conteudo(m);
  return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || '';
};

const contextoDa = (c) =>
  c.extendedTextMessage?.contextInfo ||
  c.imageMessage?.contextInfo ||
  c.stickerMessage?.contextInfo ||
  c.videoMessage?.contextInfo ||
  c.audioMessage?.contextInfo ||
  null;

// Descrição curta de uma mensagem para o histórico ("[figurinha]", texto, legenda...).
function resumo(c) {
  const texto = c.conversation || c.extendedTextMessage?.text || '';
  if (texto) return texto;
  if (c.imageMessage) return `[imagem]${c.imageMessage.caption ? ' ' + c.imageMessage.caption : ''}`;
  if (c.videoMessage) return `[vídeo]${c.videoMessage.caption ? ' ' + c.videoMessage.caption : ''}`;
  if (c.stickerMessage) return '[figurinha]';
  if (c.audioMessage) return '[áudio]';
  if (c.documentMessage) return `[arquivo ${c.documentMessage.fileName || ''}]`.trim();
  return '';
}

const audio = fs.readFileSync(CONFIG.audio);
const lerSeExistir = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null);
const respostas = {
  figurinha: { buffer: lerSeExistir(CONFIG.figurinha.arquivo), nome: 'manda figurinha', arquivo: CONFIG.figurinha.arquivo },
  imagem: { buffer: lerSeExistir(CONFIG.figurinha.arquivoImagem), nome: 'manda imagem', arquivo: CONFIG.figurinha.arquivoImagem },
};
const ia = await iniciarIA(CONFIG.claude);
const modelos = configurarModelos(local.modelos);
const regras = new Regras(DIR); // regras criadas pelo grupo (regras.json)
const geradorOk = CONFIG.gerador.ativo && configurarGerador({ ...CONFIG.gerador, log: (msg) => log(msg) });
process.on('exit', desligarGerador);
const downloads = await iniciarDownloads(
  process.env.YTDLP_PATH || local.ytdlp || 'yt-dlp',
  process.env.FFMPEG_PATH || local.ffmpeg || 'ffmpeg',
  path.join(DIR, local.cookies || 'cookies.txt')
);

// Desembrulha mensagens temporárias / de visualização única.
function conteudo(m) {
  let c = m.message;
  for (let i = 0; i < 3 && c; i++) {
    const dentro = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message;
    if (!dentro) break;
    c = dentro;
  }
  return c || {};
}

// Um ID bate com a lista configurada, ou (sem lista) o nome de perfil contém parte do nome.
function ehDe(m, { ids, remetente }) {
  const meus = [m.key.participant, m.key.participantAlt].filter(Boolean).map(jidNormalizedUser);
  if (ids.length) return meus.some((id) => ids.map(jidNormalizedUser).includes(id));
  const nome = normalizar(m.pushName);
  if (!nome) return false;
  const alvo = normalizar(remetente);
  if (nome === alvo || alvo.startsWith(nome) || nome.startsWith(alvo)) return true;
  return alvo.split(/\s+/).some((parte) => parte.length >= 4 && nome.includes(parte));
}

// Mensagens que o bot enviou, para reenviar quando algum aparelho (ex: iPhone) pedir retry.
const enviadas = new Map();
function guardarEnviada(msg) {
  if (!msg?.key?.id) return msg;
  enviadas.set(msg.key.id, msg.message);
  if (enviadas.size > 200) enviadas.delete(enviadas.keys().next().value);
  guardarMensagem(msg, 'Bot');
  return msg;
}

// ---------- anexos repetidos ----------
// O mesmo arquivo não vai duas vezes: nem na mesma resposta (o Claude às vezes põe o link do YouTube e o do
// music.youtube.com, que são o mesmo vídeo), nem em duas respostas ao mesmo tempo (duas marcações pedindo a
// mesma coisa), nem quando o bot refaz um pedido depois de reiniciar.
/** Chave do link: YouTube (www, m, music, youtu.be, shorts) vira o ID do vídeo; o resto, a URL sem "www.". */
function chaveDoLink(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return `yt:${u.pathname.split('/')[1]}`;
    if (host === 'youtube.com') {
      const id = u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/)?.[1];
      if (id) return `yt:${id}`;
    }
    return `${host}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    return url;
  }
}
/** Onde tentar baixar, em ordem: o link e, se for YouTube, o mesmo vídeo pelo outro endereço (www ↔ music). */
function alternativasDoLink(url) {
  const chave = chaveDoLink(url);
  if (!chave.startsWith('yt:')) return [url];
  const id = chave.slice(3);
  const outro = /music\.youtube\.com/i.test(url) ? `https://www.youtube.com/watch?v=${id}` : `https://music.youtube.com/watch?v=${id}`;
  return [url, outro];
}
const TIPOS_DE_MIDIA = ['audioMessage', 'videoMessage', 'imageMessage', 'documentMessage'];
/** fileSha256 (base64) da mídia de uma mensagem guardada, ou null. Áudio de voz (o do Gabreu) não conta. */
function shaDaMensagem(c) {
  const tipo = TIPOS_DE_MIDIA.find((t) => c?.[t]);
  const h = tipo && !c[tipo].ptt ? c[tipo].fileSha256 : null;
  if (!h) return null;
  return typeof h === 'string' ? h : Buffer.from(h instanceof Uint8Array ? h : Object.values(h)).toString('base64');
}
/** SHA-256 (base64) do arquivo que vai ser enviado: é o mesmo fileSha256 que o WhatsApp guarda. */
function shaDoAnexo(anexo) {
  const b = anexo?.audio || anexo?.video || anexo?.image || anexo?.document;
  return Buffer.isBuffer(b) ? crypto.createHash('sha256').update(b).digest('base64') : null;
}
/** O bot já mandou esse link ou esse arquivo no grupo nos últimos `janelaSeg` segundos? */
function anexoRecente(jid, { chave, sha }, janelaSeg) {
  const desde = Math.floor(Date.now() / 1000) - janelaSeg;
  for (const g of mensagensGuardadas.values()) {
    if (!g.key.fromMe || g.key.remoteJid !== jid || (g.em || 0) < desde) continue;
    if ((chave && g.chave === chave) || (sha && shaDaMensagem(conteudo(g)) === sha)) return true;
  }
  return false;
}
// Link sendo baixado/enviado agora (grupo|chave -> quando começou): outra resposta com o mesmo link espera.
const baixandoAgora = new Map();
async function esperarDownloadIgual(k) {
  for (let i = 0; i < 120 && Date.now() - (baixandoAgora.get(k) || 0) < 10 * 60e3; i++) await new Promise((r) => setTimeout(r, 2000));
}

// Mensagens recentes do grupo (só a mensagem em si: texto, quem mandou, a quem respondeu e a
// referência da mídia; nada baixado). Servem para "puxar o fio" das respostas: a mensagem respondida,
// a que ela respondia, e assim por diante, para o bot não perder o contexto.
// Ficam salvas em disco (.mensagens-recentes.json), para o fio não se perder quando o bot reinicia.
const mensagensGuardadas = new Map(); // id -> { key, message, nome }
const ARQ_MENSAGENS = path.join(DIR, '.mensagens-recentes.json');
try {
  for (const [id, v] of JSON.parse(fs.readFileSync(ARQ_MENSAGENS, 'utf8'), BufferJSON.reviver)) mensagensGuardadas.set(id, v);
} catch { /* primeira vez, ou arquivo estragado: começa vazio */ }
let timerSalvar = null;
function salvarMensagens() {
  clearTimeout(timerSalvar);
  timerSalvar = null;
  try {
    fs.writeFileSync(ARQ_MENSAGENS + '.tmp', JSON.stringify([...mensagensGuardadas], BufferJSON.replacer));
    fs.renameSync(ARQ_MENSAGENS + '.tmp', ARQ_MENSAGENS);
  } catch (e) {
    console.error('Não deu para salvar as mensagens recentes:', e.message);
  }
}
process.on('exit', salvarMensagens);
function guardarMensagem(msg, nome) {
  if (!msg?.key?.id || !msg.message) return;
  const antes = mensagensGuardadas.get(msg.key.id);
  // Mensagem do histórico traz o autor em msg.participant (não em msg.key.participant). E uma versão nova
  // da mesma mensagem nunca apaga o que a anterior já sabia (autor, LID/número).
  const key = { ...(antes?.key || {}), ...Object.fromEntries(Object.entries(msg.key).filter(([, v]) => v != null)) };
  if (!key.participant && msg.participant) key.participant = msg.participant;
  if (nome && !key.fromMe) { lembrarNome(key.participant, nome); lembrarNome(key.participantAlt, nome); }
  mensagensGuardadas.set(msg.key.id, {
    key,
    message: copiaDaMensagem(msg.message),
    nome: nome || antes?.nome || '',
    ...(antes?.chave ? { chave: antes.chave } : {}), // link de onde veio o anexo que o bot mandou
    em: numero(msg.messageTimestamp) || antes?.em || Math.floor(Date.now() / 1000),
  });
  // Cabe o histórico inteiro de um grupo; se passar, descarta as mais ANTIGAS (por horário).
  if (mensagensGuardadas.size > MAX_MENSAGENS + 500) {
    const ordem = [...mensagensGuardadas.entries()].sort((a, b) => (a[1].em || 0) - (b[1].em || 0));
    for (const [id] of ordem.slice(0, mensagensGuardadas.size - MAX_MENSAGENS)) mensagensGuardadas.delete(id);
  }
  timerSalvar ??= setTimeout(salvarMensagens, 10_000); // junta várias mensagens numa gravação
}
const MAX_MENSAGENS = 30_000;

/**
 * Mídias (foto, álbum, GIF, vídeo, figurinha) que a pessoa mandou na última leva antes do pedido:
 * vai voltando enquanto o intervalo entre uma e outra for de até 3 min (no máx. 10 min e 10 mídias).
 */
function midiasRecentes(jid, donos, pedidoMsg) {
  const ate = numero(pedidoMsg.messageTimestamp) || Math.floor(Date.now() / 1000);
  const delas = [...mensagensGuardadas.values()]
    .filter((g) => g.key.remoteJid === jid && !g.key.fromMe && (g.em || 0) <= ate + 5 && (g.em || 0) >= ate - 600)
    .filter((g) => [g.key.participant, g.key.participantAlt].filter(Boolean).map(jidNormalizedUser).some((x) => donos.includes(x)))
    .filter((g) => { const c = conteudo(g); return c.imageMessage || c.stickerMessage || c.videoMessage; })
    .sort((a, b) => (b.em || 0) - (a.em || 0));
  const leva = [];
  let anterior = ate;
  for (const g of delas) {
    if (anterior - (g.em || 0) > 180 || leva.length >= 10) break;
    leva.push(g);
    anterior = g.em || 0;
  }
  return leva.reverse(); // na ordem em que foram mandadas
}

// Nomes das pessoas (número ou LID -> nome). Mensagens antigas do histórico vêm sem nome: o nome sai
// daqui (aprendido das mensagens ao vivo e dos contatos que o WhatsApp manda junto com o histórico).
const ARQ_NOMES = path.join(DIR, '.nomes.json');
const nomes = new Map((() => { try { return Object.entries(JSON.parse(fs.readFileSync(ARQ_NOMES, 'utf8'))); } catch { return []; } })());
let timerNomes = null;
const chaveNome = (id) => String(id || '').split('@')[0].split(':')[0];
function lembrarNome(id, nome) {
  const k = chaveNome(id);
  if (!k || !nome || nomes.get(k) === nome) return;
  nomes.set(k, nome);
  timerNomes ??= setTimeout(() => {
    timerNomes = null;
    try { fs.writeFileSync(ARQ_NOMES, JSON.stringify(Object.fromEntries(nomes))); } catch { /* tenta na próxima */ }
  }, 5000);
}
function nomeDaPessoa(...ids) {
  for (const id of ids) {
    const n = id && nomes.get(chaveNome(id));
    if (n) return n;
  }
  return '';
}
for (const g of mensagensGuardadas.values()) if (g.nome && !g.key.fromMe) { lembrarNome(g.key.participant, g.nome); lembrarNome(g.key.participantAlt, g.nome); }
// Conserta mensagens salvas sem autor (bug antigo do histórico): se tem o nome, o autor sai de outra
// mensagem da mesma pessoa.
{
  const idDoNome = new Map();
  for (const g of mensagensGuardadas.values()) if (g.nome && g.key.participant && !g.key.fromMe) idDoNome.set(g.nome, g.key);
  for (const g of mensagensGuardadas.values()) {
    if (g.key.fromMe || g.key.participant || !idDoNome.has(g.nome)) continue;
    const k = idDoNome.get(g.nome);
    g.key.participant = k.participant;
    if (k.participantAlt) g.key.participantAlt = k.participantAlt;
  }
}

// Tira o rótulo "🤖 *Serviço: X*" (um ou vários) do começo do texto.
const semRotulo = (t) => String(t || '').replace(/^(\s*🤖\s*\*?Servi[çc]o:[^*\n]*\*?\s*)+/u, '');

// Confirmação de serviço no grupo fica curta (pedido do Rafa): no máximo 2 linhas e ~220 caracteres,
// cortando no fim de uma frase. O que vai no privado e as respostas de conversa não passam por aqui.
function curto(t, max = 220) {
  const s = semRotulo(t).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2).join('\n');
  if (s.length <= max) return s;
  const corte = s.slice(0, max);
  const fim = Math.max(...['. ', '! ', '? ', '\n'].map((p) => corte.lastIndexOf(p)));
  return fim > 40 ? corte.slice(0, fim + 1).trim() : `${corte.replace(/\s+\S*$/, '')}…`;
}

// Cópia de verdade: ao responder uma mensagem, o Baileys APAGA o contextInfo (a quem ela respondia)
// do objeto original. Sem cópia, o fio se partia em toda mensagem que o bot respondeu.
function copiaDaMensagem(message) {
  try {
    return proto.Message.decode(proto.Message.encode(message).finish());
  } catch {
    return JSON.parse(JSON.stringify(message, BufferJSON.replacer), BufferJSON.reviver);
  }
}

// Número de um campo que pode vir como Long do protobuf (ou objeto {low, high} depois de salvo em JSON).
const numero = (x) => (x && typeof x === 'object' ? (x.low >>> 0) + (x.high || 0) * 2 ** 32 : Number(x || 0));

// ---------- página local com o QR (o terminal às vezes é estreito demais) ----------
const PORTA_QR = Number(process.env.BOT_QR_PORT || 3999);
let qrAtual = null;
let servidorQr = null;
function paginaQr() {
  const corpo = qrAtual
    ? `<img src="${qrAtual}" alt="QR code"><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p>`
    : '<p>✅ Conectado! Pode fechar esta página.</p>';
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="3"><title>QR do Bot do Gabreu</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f4f5;color:#18181b;text-align:center}
img{width:min(80vmin,420px);background:#fff;padding:16px;border-radius:12px}</style></head>
<body><main><h1>🎙️ Bot do Gabreu</h1>${corpo}</main></body></html>`;
}
async function mostrarQr(qr) {
  qrAtual = await QRCode.toDataURL(qr, { margin: 1, width: 420 });
  if (!servidorQr) {
    servidorQr = http
      .createServer((_, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(paginaQr()))
      .listen(PORTA_QR, '127.0.0.1', () => log(`QR também disponível em http://localhost:${PORTA_QR}`))
      .on('error', (e) => log('Não deu para abrir a página do QR:', e.message));
  }
}
function fecharQr() {
  if (!servidorQr) return;
  qrAtual = null;
  setTimeout(() => { servidorQr?.close(); servidorQr = null; }, 10_000); // dá tempo da página mostrar "Conectado"
}

const groupCache =new NodeCache({ stdTTL: 5 * 60, useClones: false });
const msgRetryCounterCache = new NodeCache();
const jaRespondidas = new Set();

// Conexão atual (troca a cada reconexão) e fila do Claude, compartilhadas com os avisos de entregas.
let sockAtual = null;
// Enquetes com prazo: confere a cada minuto (a função é da conexão atual; reconectar troca).
let avaliarEnquetes = null;
setInterval(() => avaliarEnquetes?.(), 60_000).unref?.();
// Ações com timer: confere a cada 15 s.
let rodarAgendadas = null;
const horaBR = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
// Agendamentos que ainda não dispararam, para o Claude poder listar, cancelar ou trocar.
const agendadasParaPrompt = (jid) => pendentes(jid).filter((a) => !a.historico).sort((a, b) => a.quando - b.quando)
  .map((a) => `${a.id} | ${new Date(a.quando).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} | ${a.descricao}${a.mensagem ? `: "${a.mensagem.slice(0, 200)}"` : ''} (pedido por ${a.pedidoPor})`)
  .join('\n');
setInterval(() => rodarAgendadas?.(), 15_000).unref?.();
// Julgamentos antes do banimento: quando o prazo da defesa acaba, dá o veredito (confere a cada 15 s).
let conferirJulgamentos = null;
setInterval(() => conferirJulgamentos?.(), 15_000).unref?.();
let conectado = false;
let filaClaude = Promise.resolve(); // uma pergunta por vez para o claude
const naFilaDoClaude = (f) => {
  const p = filaClaude.then(f);
  filaClaude = p.catch(() => {});
  return p;
};

// ---------- avisos de entregas da faculdade (12h, 20h e 22h) ----------
let sincronizarMateriais = null;
if (local.entregas?.ativo && ia) {
  iniciarAvisos({
    cfg: local.entregas,
    avaliar: avaliarEntregas,
    fila: naFilaDoClaude,
    log,
    enviar: async (texto) => {
      if (!sockAtual || !conectado) return false;
      const grupos = await sockAtual.groupFetchAllParticipating();
      const grupo = Object.values(grupos).find((g) => normalizar(g.subject) === normalizar(CONFIG.grupo));
      if (!grupo) { log(`Entregas: grupo "${CONFIG.grupo}" não encontrado.`); return false; }
      guardarEnviada(await sockAtual.sendMessage(grupo.id, { text: texto }));
      return true;
    },
  });
  // Login do Classroom expirou → abre o navegador sozinho para entrar de novo.
  if (local.entregas.classroom?.clientId) {
    vigiarLogin(local.entregas.classroom, { log });
    // Materiais do Classroom (avisos, plano de ensino, slides...) em texto, para o Claude procurar.
    sincronizarMateriais = manterMateriais(local.entregas.classroom, { log });
  }
}

// ---------- conexão ----------
async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DIR, '.baileys_auth'));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  let codigoPedido = false;
  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.windows('Bot do Gabreu'),
    markOnlineOnConnect: false,
    // Na conexão (QR), pede o histórico COMPLETO e aceita todos os tipos: as mensagens antigas dos grupos
    // viram contexto e fio de respostas.
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
    msgRetryCounterCache,
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
    getMessage: async (key) => enviadas.get(key.id),
  });

  sock.ev.on('creds.update', saveCreds);
  sockAtual = sock;

  // Ao responder, o Baileys apaga as menções da mensagem citada (contextInfo): aí o WhatsApp mostra o
  // "@253914339389476" cru na citação. Passa para ele uma cópia com o "@número" já trocado pelo nome
  // (e a original fica intacta para o fio de respostas).
  const enviarOriginal = sock.sendMessage.bind(sock);
  sock.sendMessage = (jid, conteudoMsg, opcoes) =>
    enviarOriginal(jid, conteudoMsg, opcoes?.quoted?.message ? { ...opcoes, quoted: citacaoComNomes(opcoes.quoted) } : opcoes);
  /** "@253914339389476" → "@Nome" (quando se sabe o nome). */
  function arrobasComNomes(t) {
    const meus = new Set(meusIds().map(digitos));
    const nome = (d) => (meus.has(d) ? sock.user?.name || 'Bot' : nomeDaPessoa(`${d}@lid`, `${d}@s.whatsapp.net`));
    return String(t || '').replace(/@(\d{6,})/g, (tudo, d) => (nome(d) ? `@${nome(d)}` : tudo));
  }
  function citacaoComNomes(q) {
    const trocar = arrobasComNomes;
    const copia = copiaDaMensagem(q.message);
    const andar = (o, nivel = 0) => {
      if (!o || typeof o !== 'object' || nivel > 6) return;
      for (const k of Object.keys(o)) {
        if (typeof o[k] === 'string' && (k === 'conversation' || k === 'text' || k === 'caption')) o[k] = trocar(o[k]);
        else if (o[k] && typeof o[k] === 'object' && !Buffer.isBuffer(o[k]) && !(o[k] instanceof Uint8Array)) andar(o[k], nivel + 1);
      }
    };
    andar(copia);
    return { ...q, message: copia };
  }

  async function metadadosGrupo(jid) {
    let meta = groupCache.get(jid);
    if (!meta) {
      meta = await sock.groupMetadata(jid);
      groupCache.set(jid, meta);
    }
    return meta;
  }
  // ---------- histórico retroativo ----------
  // O WhatsApp manda o histórico completo das conversas quando o aparelho é conectado (QR escaneado).
  // Tudo o que vier de grupo é salvo junto com as mensagens recentes: vira contexto e fio de respostas.
  // (Pedir lotes antigos sob demanda foi testado: o celular desta conta responde sempre vazio.)
  // Os nomes dos contatos vêm pelo número de telefone, mas no grupo cada pessoa aparece pelo LID:
  // liga os dois pela lista de participantes (e pelo mapa LID↔número do WhatsApp).
  async function ligarNomesDosGrupos() {
    const grupos = await sock.groupFetchAllParticipating().catch(() => ({}));
    let ligados = 0;
    for (const meta of Object.values(grupos)) {
      for (const p of meta.participants || []) {
        const ids = [p.id, p.phoneNumber, p.lid].filter(Boolean);
        if (!ids.some((i) => i.endsWith('@s.whatsapp.net'))) {
          const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(p.id).catch(() => null);
          if (pn) ids.push(pn);
        }
        const nome = nomeDaPessoa(...ids);
        if (!nome) continue;
        for (const i of ids) if (!nomeDaPessoa(i)) { lembrarNome(i, nome); ligados++; }
      }
    }
    if (ligados) log(`Nomes: ${ligados} identificador(es) de participantes ligados a um nome.`);
  }

  let historicoRecebido = 0;
  sock.ev.on('messaging-history.set', ({ messages = [], contacts = [], syncType, progress }) => {
    for (const c of contacts) {
      const nome = c.notify || c.name || c.verifiedName;
      lembrarNome(c.id, nome);
      lembrarNome(c.lid, nome);
    }
    let salvas = 0;
    for (const msg of messages) {
      if (!msg?.message || !isJidGroup(msg.key?.remoteJid || '')) continue;
      guardarMensagem(msg, msg.pushName);
      salvas++;
    }
    if (!salvas) return;
    historicoRecebido += salvas;
    log(`Histórico do WhatsApp (tipo ${syncType}${progress != null ? `, ${progress}%` : ''}): +${salvas} mensagens de grupo (total ${historicoRecebido}).`);
    salvarMensagens();
    ligarNomesDosGrupos().catch(() => {});
  });

  sock.ev.on('groups.update', (updates) => updates.forEach((u) => groupCache.del(u.id)));
  sock.ev.on('group-participants.update', (u) => {
    groupCache.del(u.id);
    // Hora em que a pessoa voltou (adicionada ou pelo link): o "histórico da última remoção" vai até aqui.
    if (u.action === 'add') {
      for (const p of u.participants || []) {
        const ids = (typeof p === 'string' ? [p] : [p.id, p.phoneNumber, p.lid]).filter(Boolean);
        marcarVolta(u.id, ids);
        encerrarBanimento(u.id, ids.map((i) => digitos(jidNormalizedUser(i))), 'voltou', true);
        // "Histórico na volta" ligado no grupo: quem tinha saído recebe sozinho o que perdeu. Espera um
        // pouco para o "adicionar com mandar_historico" do próprio bot marcar que já vai mandar.
        if (historicoNaVolta[u.id] && !ids.some((i) => meusIds().includes(jidNormalizedUser(i)))) {
          setTimeout(() => mandarHistoricoNaVolta(u.id, ids).catch((e) => log(`Histórico na volta: erro (${e.message}).`)), 8_000);
        }
      }
    }
    // Saiu ou foi removido por alguém no próprio WhatsApp (não pelo bot): também conta como período fora.
    if (u.action === 'remove') {
      for (const p of u.participants || []) marcarSaida(u.id, typeof p === 'string' ? [p] : [p.id, p.phoneNumber, p.lid]);
    }
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    // Sem sessão e com "numeroBot" no config: também dá para conectar digitando um código no celular
    // (WhatsApp > Aparelhos conectados > Conectar aparelho > Conectar com número de telefone).
    if (qr && !state.creds.me && local.numeroBot && !codigoPedido) {
      codigoPedido = true;
      sock.requestPairingCode(String(local.numeroBot).replace(/\D/g, ''))
        .then((codigo) => {
          fs.writeFileSync(path.join(DIR, '.codigo-pareamento.txt'), codigo);
          log(`Código de pareamento: ${codigo} (vale alguns minutos).`);
        })
        .catch((e) => log('Não deu para pedir o código de pareamento:', e.message));
    }
    if (qr) {
      log('Escaneie o QR code abaixo no WhatsApp (Aparelhos conectados > Conectar aparelho):');
      qrcode.generate(qr, { small: true });
      mostrarQr(qr).catch((e) => log('Erro ao gerar imagem do QR:', e.message));
    }
    if (connection === 'open') {
      conectado = true;
      fecharQr();
      log(`Bot pronto. Ouvindo "?" de ${CONFIG.remetente} em ${CONFIG.grupo}.`);
      for (const [tipo, r] of Object.entries(respostas)) if (!r.buffer) log(`Figurinha de resposta não encontrada em ${r.arquivo}; resposta a ${tipo} desligada.`);
      log(`Figurinhas de ${CONFIG.figurinha.remetente}: ${ia ? 'IA decide se é non-sense' : `claude CLI não encontrado, responde com chance ${CONFIG.figurinha.chanceSemIA}`}.`);
      const ids = [sock.user?.id, sock.user?.lid].filter(Boolean).map((j) => '…' + jidNormalizedUser(j).split('@')[0].slice(-4) + '@' + j.split('@')[1]);
      log(`Downloads: yt-dlp ${downloads.ytdlp ? 'ok' : 'não encontrado (vídeos de sites viram link)'}, ffmpeg ${downloads.ffmpeg ? 'ok' : 'não encontrado (GIF vira figurinha)'}, cookies ${downloads.cookies ? 'ok' : 'sem (Instagram/Reddit privados podem falhar)'}.`);
      log(`Modelos: ${Object.entries(modelos).map(([t, m]) => `${t}=${m.modelo.replace('claude-', '')}/${m.esforco}`).join(', ')}.`);
      log(`Gerador de imagem (ComfyUI): ${geradorOk ? `pronto em ${CONFIG.gerador.pasta}` : 'desligado/não instalado'}.`);
      log(`Marcações (@) da conta ${ids.join(' / ')}: ${CONFIG.mencao.ativo && ia ? 'o Claude responde' : 'desligadas'}.`);
      log(`Entregas (Moodle/Classroom): ${local.entregas?.ativo && ia ? 'avisos às 12h, 20h e 22h' : 'desligadas'}.`);
      // depois do histórico chegar: liga os nomes (por número) aos participantes (por LID)
      setTimeout(() => ligarNomesDosGrupos().catch((e) => log('Nomes: erro', e.message)), 30_000);
      setTimeout(() => retomarPedidoDoDono().catch((e) => log('Implementar: erro ao refazer', e.message)), 15_000);
      // Banidos que ainda não foram avisados no privado (ex: removidos antes desta função existir).
      setTimeout(() => { for (const b of banimentos) if (b.ativo && Date.now() < voltaDoBan(b)) avisarBanido(b); }, 20_000);
    }
    if (connection === 'close') {
      conectado = false;
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) {
        log('Sessão desconectada pelo celular. Apague a pasta .baileys_auth e rode de novo para escanear o QR.');
        process.exit(3);
      }
      log(`Conexão caiu (código ${codigo}); reconectando...`);
      setTimeout(() => iniciar().catch((e) => log('Erro ao reconectar:', e.stack || e)), 3000);
    }
  });

  async function responderInterrogacao(m, jid) {
    if (!CONFIG.gatilho.test(textoDa(m).trim())) return;
    if (!ehDe(m, { ids: CONFIG.ids, remetente: CONFIG.remetente })) {
      log(`"?" no grupo, mas de outra pessoa (${m.pushName || '?'} / ${m.key.participant}); ignorado.`);
      return;
    }
    jaRespondidas.add(m.key.id);
    const enviada = await sock.sendMessage(
      jid,
      { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true },
      { quoted: m }
    );
    guardarEnviada(enviada);
    log(`Áudio enviado em resposta a "${textoDa(m).trim()}" de ${m.pushName || CONFIG.remetente}.`);
  }

  let ultimaFigurinha = 0;
  async function responderFigurinha(m, jid) {
    const c = conteudo(m);
    const tipo = c.stickerMessage ? 'figurinha' : c.imageMessage ? 'imagem' : null;
    if (!tipo || !respostas[tipo].buffer) return;
    if (!ehDe(m, CONFIG.figurinha)) return;

    const quem = `${m.pushName || CONFIG.figurinha.remetente} (${m.key.participant})`;
    if (Date.now() - ultimaFigurinha < CONFIG.figurinha.intervaloSeg * 1000) {
      log(`${tipo} de ${quem}, mas ainda no intervalo mínimo; ignorada.`);
      return;
    }

    let veredito;
    let buffer = null;
    if (ia) {
      buffer = await baixar(m);
      veredito = await avaliarNonsense(buffer, { autor: m.pushName || CONFIG.figurinha.remetente, tipo, catalogo: await catalogoParaPrompt() });
    } else {
      veredito = { nonsense: Math.random() < CONFIG.figurinha.chanceSemIA, motivo: 'sem claude CLI', resposta: 'padrao' };
    }
    log(`${tipo} de ${quem}: ${veredito.nonsense ? 'NON-SENSE' : 'normal'} — ${veredito.motivo}`);
    if (!veredito.nonsense) return;

    ultimaFigurinha = Date.now();
    jaRespondidas.add(m.key.id);

    // O Claude escolheu montar um meme? Se der errado, cai na figurinha padrão.
    if (veredito.resposta === 'meme' && veredito.meme_id) {
      try {
        const meme = await figurinhaDeMeme({ id: veredito.meme_id, cima: veredito.texto_cima, baixo: veredito.texto_baixo });
        guardarEnviada(await sock.sendMessage(jid, { sticker: meme }, { quoted: m }), [{ buffer: meme }, { buffer }]);
        log(`Meme ${veredito.meme_id} ("${veredito.texto_cima}" / "${veredito.texto_baixo}") enviado em resposta à ${tipo} de ${quem}.`);
        return;
      } catch (e) {
        log('Não deu para montar o meme, mandando a figurinha padrão:', e.message);
      }
    }
    const resposta = respostas[tipo];
    guardarEnviada(await sock.sendMessage(jid, { sticker: resposta.buffer }, { quoted: m }));
    log(`Figurinha "${resposta.nome}" enviada em resposta à ${tipo} de ${quem}.`);
  }

  // ---------- @menção → Claude ----------
  const meusIds = () => [sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNormalizedUser);
  const digitos = (jid) => jid.split('@')[0];

  function meMarcaram(m) {
    const ctx = contextoDa(conteudo(m));
    const eu = meusIds();
    if (ctx?.mentionedJid?.some((j) => eu.includes(jidNormalizedUser(j)))) return true;
    // Respondeu (função "responder" do WhatsApp) uma mensagem do bot: conta como falar com ele.
    if (ctx?.stanzaId && ctx?.participant && eu.includes(jidNormalizedUser(ctx.participant))) return true;
    const texto = textoDa(m);
    return eu.some((id) => texto.includes('@' + digitos(id)));
  }

  async function baixar(msg) {
    return downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  }

  const ultimaMencao = new Map(); // autor -> timestamp
  // "@<número do bot>" dentro de mensagens citadas vira "@bot (você)", para o Claude saber que é ele.
  const semMeuArroba = (t) => meusIds().reduce((s, id) => s.split('@' + digitos(id)).join('@bot (você)'), t || '');

  // ---------- falaram com o bot sem marcar ("bot o que tem hoje?", continuação da conversa) ----------
  const ultimaRespostaBot = new Map(); // grupo -> { autorId, em, n } (quem o bot respondeu por último)
  const contadorMsgs = new Map(); // grupo -> nº de mensagens de gente vistas
  let ultimaChecagem = 0;

  /** Só chama o Claude para mensagens candidatas; ele só responde se for MUITO claro que é com ele. */
  async function talvezFalaramComigo(m, jid, meta) {
    const texto = textoDa(m).trim();
    if (!texto || texto.length > 500) return;
    const autorId = jidNormalizedUser(m.key.participant || jid);
    const r = ultimaRespostaBot.get(jid);
    // Continuação: o bot respondeu essa pessoa há menos de 3 min e no máximo 2 mensagens de outros no meio.
    const continuacao = !!r && r.autorId === autorId && Date.now() - r.em < 3 * 60e3 && (contadorMsgs.get(jid) || 0) - r.n <= 3;
    const chamaBot = /\bbot\b/.test(normalizar(texto));
    if (!continuacao && !chamaBot) return;
    if (Date.now() - ultimaChecagem < 3000) return; // rajada de mensagens: não checa todas
    ultimaChecagem = Date.now();
    const autor = m.pushName || digitos(autorId);
    try {
      const { hist } = historicoPara(jid, '', m.key.id);
      const v = await falaramComOBot({ grupo: meta.subject, historico: hist, autor, mensagem: texto, botAcabouDeResponder: continuacao });
      log(`Sem @, ${autor}: "${texto.slice(0, 60)}" → ${v.para_o_bot ? 'é com o bot' : 'não é com o bot'} (${v.motivo})`);
      if (v.para_o_bot && !jaRespondidas.has(m.key.id)) await responderMarcacao(m, jid, meta);
    } catch (e) {
      log(`Não deu para ver se falaram com o bot (${e.message}).`);
    }
  }

  async function responderMarcacao(m, jid, meta, { aposImplementar = false } = {}) {
    const autorId = m.key.participant || jid;
    const autor = m.pushName || digitos(autorId);
    const dono = ehDono(m, meta);
    if (!aposImplementar && Date.now() - (ultimaMencao.get(autorId) || 0) < CONFIG.mencao.intervaloSeg * 1000) {
      log(`Marcação de ${autor} ignorada (intervalo mínimo).`);
      return;
    }
    ultimaMencao.set(autorId, Date.now());
    jaRespondidas.add(m.key.id);

    let pedido = textoDa(m);
    for (const id of meusIds()) pedido = pedido.split('@' + digitos(id)).join('').trim();

    const c = conteudo(m);
    const ctx = contextoDa(c);
    const imagens = [];
    // GIF, vídeo curto ou figurinha animada (na mensagem ou na citada): vira figurinha animada.
    let animado = null;
    const pegarMidia = async (conteudoMsg, msg) => {
      if (conteudoMsg.imageMessage || conteudoMsg.stickerMessage) {
        const b = await baixar(msg);
        imagens.push(b);
        if (!animado && conteudoMsg.stickerMessage?.isAnimated) animado = { buffer: b, ext: 'webp' };
      } else if (conteudoMsg.videoMessage && !animado && numero(conteudoMsg.videoMessage.fileLength) <= 25 * 1024 * 1024) {
        animado = { buffer: await baixar(msg), ext: 'mp4', gif: !!conteudoMsg.videoMessage.gifPlayback };
      }
    };
    await pegarMidia(c, m);

    let citada = '';
    if (ctx?.quotedMessage) {
      const q = ctx.quotedMessage;
      const quemCitado = ctx.participant && meusIds().includes(jidNormalizedUser(ctx.participant)) ? 'você (o bot)'
        : ctx.participant ? `${nomeDaPessoa(ctx.participant) || 'alguém do grupo'} (@${digitos(jidNormalizedUser(ctx.participant))})` : 'alguém do grupo';
      citada = `${quemCitado}: ${semMeuArroba(resumo(q)) || '[mensagem]'}`;
      try {
        await pegarMidia(q, { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: q });
      } catch (e) {
        log('Não deu para baixar a mídia citada:', e.message);
      }
    }

    // Puxa o fio: a mensagem respondida, a que ELA respondia, e assim por diante, até acabarem os elos.
    // Sem responder nada, mas continuando a conversa com o bot logo depois, o fio começa na última
    // mensagem do bot para essa pessoa. A primeira imagem/GIF achada no caminho vai junto.
    const fio = [];
    let proximo = ctx?.stanzaId || null;
    if (!proximo && !imagens.length && !animado) {
      const r = ultimaRespostaBot.get(jid);
      if (r?.msgId && r.autorId === jidNormalizedUser(autorId) && Date.now() - r.em < 10 * 60e3) proximo = r.msgId;
    }
    const vistos = new Set();
    for (let nivel = 0; proximo && nivel < 500 && !vistos.has(proximo); nivel++) {
      vistos.add(proximo);
      const guardada = mensagensGuardadas.get(proximo);
      if (nivel > 0 || !ctx?.stanzaId) {
        if (!guardada) break; // o fio sai do que o bot viu desde que ligou
        const quem = guardada.key.fromMe ? 'você (o bot)' : guardada.nome || nomeDaPessoa(guardada.key.participant, guardada.key.participantAlt) || 'alguém';
        fio.unshift(`${quem}: ${semMeuArroba(semRotulo(resumo(conteudo(guardada)))).replace(/\s+/g, ' ').slice(0, 600) || '[mensagem]'}`);
        if (!imagens.length && !animado) {
          try { await pegarMidia(conteudo(guardada), guardada); } catch (e) { log('Não deu para baixar a mídia do fio:', e.message); }
        }
      }
      proximo = contextoDa(conteudo(guardada || { message: ctx?.quotedMessage || {} }))?.stanzaId || null;
    }
    if (fio.length) log(`Marcação de ${autor}: puxei ${fio.length} mensagem(ns) do fio de respostas${imagens.length || animado ? ' (com imagem)' : ''}.`);

    const { hist, leituraPedida } = historicoPara(jid, pedido, m.key.id);
    log(`${autor} marcou o bot: "${pedido.slice(0, 80)}"${citada ? ` (respondendo ${citada.slice(0, 60)})` : ''}${imagens.length ? ` (+${imagens.length} imagem)` : ''}${leituraPedida ? ` (lendo ${hist.length} mensagens)` : ''}`);

    // Pessoas marcadas na mensagem (fora o bot): viram os IDs do remetente se a pessoa criar uma regra.
    const outrosMarcados = (ctx?.mentionedJid || []).map(jidNormalizedUser).filter((j) => !meusIds().includes(j));

    const respondeuBot = !!(ctx?.participant && meusIds().includes(jidNormalizedUser(ctx.participant)));
    // "Figurinha de cada imagem que mandei": de quem são as mídias (de quem foi respondido, se não for o bot).
    // e o momento delas: respondendo a mensagem de alguém ("faz figurinha de tudo que ele mandou"), vale a
    // hora DAQUELA mensagem; senão, a hora do próprio pedido.
    const citadaSalva = ctx?.stanzaId ? mensagensGuardadas.get(ctx.stanzaId) : null;
    const donoDasMidias = ctx?.participant && !respondeuBot
      ? [ctx.participant, citadaSalva?.key.participant, citadaSalva?.key.participantAlt].filter(Boolean).map(jidNormalizedUser)
      : [m.key.participant, m.key.participantAlt].filter(Boolean).map(jidNormalizedUser);
    const momentoDasMidias = ctx?.participant && !respondeuBot && citadaSalva?.em ? { messageTimestamp: citadaSalva.em } : m;

    // 1) Só a pergunta ao Claude entra na fila (uma por vez).
    const decidir = async () => {
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      // Pergunta sobre trabalho/prova/prazo → consulta Moodle e Classroom e manda a lista junto.
      let entregas = '';
      if (local.entregas?.ativo && PERGUNTA_ENTREGA.test(`${pedido} ${citada}`)) {
        try {
          entregas = await listaParaPergunta(local.entregas, { log });
          log(`Marcação sobre entregas: lista do Moodle/Classroom enviada ao Claude.`);
        } catch (e) {
          log(`Não deu para buscar as entregas (${e.message}).`);
        }
      }
      // Pergunta sobre as aulas/matérias → o Claude vasculha os materiais do Classroom.
      let materiais = null;
      // Também conta o fio: "foi de programação paralela, pesquisa aí" continua uma conversa sobre o class.
      const linksClass = idsDeLinkClassroom(`${pedido} ${citada} ${fio.join(' ')}`);
      if (sincronizarMateriais && (PERGUNTA_AULA.test(`${pedido} ${citada} ${fio.join(' ')}`) || entregas || linksClass.length)) {
        // Antes de responder, busca no Classroom para a cópia local ficar em dia (o que o professor
        // acabou de postar). Rápida: só os murais e anexos novos; se demorar, usa a cópia que tem.
        let atualizado = '';
        const t0 = Date.now();
        const r = await Promise.race([
          sincronizarMateriais({ rapido: true }),
          new Promise((ok) => setTimeout(() => ok('demorou'), 60_000)),
        ]);
        if (r && r !== 'demorou') atualizado = agoraBrasil();
        log(`Classroom: busca na hora da pergunta ${r === 'demorou' ? 'demorou; usando a cópia que já tinha' : r ? `ok em ${((Date.now() - t0) / 1000).toFixed(0)} s` : 'falhou; usando a cópia que já tinha'}.`);
        const indice = indiceMateriais();
        if (indice) {
          const links = linksClass.map((l) => `O link do Classroom na mensagem é da turma id ${l.turma}${l.post ? `, post id ${l.post}: procure "id do post: ${l.post}" nos _mural.md (Grep) e responda sobre ESSE post` : ''}.`).join('\n');
          materiais = { indice, pasta: PASTA_MATERIAIS, atualizado, links };
          log('Marcação sobre aulas: o Claude vai procurar nos materiais do Classroom.');
        }
      }
      return interpretarMencao({
        entregas,
        materiais,
        grupo: meta.subject, historico: hist, leituraPedida, autor, pedido, citada, imagens, regras: regras.resumo(jid), fio,
        agendadas: agendadasParaPrompt(jid),
        banimentos: banimentosParaPrompt(jid),
        julgamentos: julgamentosParaPrompt(jid),
        animacao: animado ? (animado.ext === 'webp' ? 'uma figurinha animada' : animado.gif ? 'um GIF' : 'um vídeo') : '',
        temVideo: temDownloaderDeVideo(), respondeuBot, catalogo: await catalogoParaPrompt(), temGerador: !!geradorOk && temGerador(),
        pessoas: pessoasParaPrompt(jid, meta),
        dono, aposImplementar,
      });
    };

    // 2) O resto (gerar imagem, baixar, enviar) roda fora da fila: enquanto uma imagem gera,
    //    o bot continua respondendo as outras marcações.
    const reservas = []; // links que esta resposta está baixando (ver baixandoAgora)
    const chavesDosAnexos = new Map(); // anexo pronto -> chave do link de onde veio
    const tarefa = async (v, erroClaude) => {
      let resposta;
      let anexos = [];
      let figurinhaPronta = null;
      let servico = null; // quando o bot fez um serviço (não só respondeu), a mensagem leva uma marca
      const idsDoAutor = [m.key.participant, m.key.participantAlt].filter(Boolean).map((i) => digitos(jidNormalizedUser(i)));
      // Gerar imagem leva ~1 a 2 min: avisa na hora para ninguém achar que travou.
      const avisarGerando = async () => {
        guardarEnviada(await sock.sendMessage(jid, { text: marcaServico('Gerando imagem', 'Começou aqui, leva uns 1 a 2 minutos.') }, { quoted: m }));
      };
      try {
        if (erroClaude) throw erroClaude;
        resposta = v.texto;
        if (v.usouModeloMaior) log(`Pedido de ${autor} era complexo: refeito no ${v.usouModeloMaior}.`);
        // Dono pediu algo que o bot não sabe: programa no próprio código (em segundo plano) e depois executa.
        if (dono && v.implementar?.fazer && v.implementar.pedido?.trim()) {
          servico = 'Implementando';
          resposta = resposta || 'Isso eu ainda não sei fazer: vou programar agora e já faço (leva alguns minutos).';
          implementarPedido({ pedido: v.implementar.pedido.trim(), original: pedido, m, jid, autor }).catch((e) => log('Implementar: erro', e.stack || e));
        }
        if (v.acao === 'responder' && Array.isArray(v.anexos)) anexos = v.anexos.filter((a) => a?.url).slice(0, 3);
        if (v.acao === 'criar_regra') {
          const remetente = { nome: v.regra_remetente || '', ids: v.regra_remetente ? outrosMarcados : [] };
          const figurinha = v.regra_so_figurinha_citada ? shaFigurinha(ctx?.quotedMessage?.stickerMessage || conteudo(m).stickerMessage) : null;
          const r = regras.criar(jid, v, remetente, autor, { figurinha });
          if (r.ok) {
            log(`Regra ${r.regra.id} criada por ${autor}: ${r.regra.descricao}`);
            servico = 'Regra criada';
          } else {
            log(`Regra recusada (${r.erro}) pedida por ${autor}.`);
            resposta = `Não criei essa regra: ${r.erro}.`;
          }
        } else if (v.acao === 'apagar_regra') {
          const ok = regras.apagar(jid, v.regra_apagar_id);
          log(`Regra ${v.regra_apagar_id} ${ok ? 'apagada' : 'não encontrada'} (pedido de ${autor}).`);
          if (ok) servico = 'Regra apagada';
          else resposta = `Não achei a regra "${v.regra_apagar_id}".`;
        }

        // Contestação de banimento: o bot confere quem contesta; se o Claude aceitou, a pessoa volta na hora.
        if (v.acao === 'responder' && v.contestacao?.fazer) {
          try {
            const r = await contestarBanimento(v.contestacao, { jid, m, autor, texto: v.texto });
            resposta = r.texto;
            if (!r.pergunta) servico = 'Contestação';
          } catch (e) {
            log(`Contestação de ${autor} não deu (${e.message}).`);
            resposta = `Não consegui: ${e.message}.`;
          }
        }

        // Fala num julgamento aberto (defesa, acusação, o julgado pedindo um defensor): o bot anota para o veredito.
        if (v.acao === 'responder' && v.julgamento?.fazer) {
          try {
            const r = await falarNoJulgamento(v.julgamento, { jid, idsAutor: idsDoAutor, autor, onde: 'grupo' });
            if (r.texto) {
              resposta = [r.texto, r.avisoGrupo].filter(Boolean).join('\n');
              servico = 'Julgamento';
            }
          } catch (e) {
            log(`Julgamento: fala de ${autor} não deu (${e.message}).`);
          }
        }

        // Ban pedido por quem não é o dono do bot: não remove na hora, abre um julgamento (o veredito sai no prazo).
        // A volta com tempo pedida junto ("bane por 10 min") fica guardada no julgamento para a hora da condenação.
        const julgar = v.acao === 'responder' && v.admin?.acao === 'remover' && !dono && !v.contestacao?.fazer;
        if (julgar && !v.julgamento?.fazer) {
          try {
            const voltas = (v.agendadas || []).filter((x) => x.admin?.acao === 'adicionar');
            const r = await abrirJulgamentos(v.admin, {
              jid, ctx, outrosMarcados, pedidoPor: autor, pedidoPorIds: idsDoAutor, voltas,
              pedido: `${autor}: "${pedido || '(só marcou o bot)'}"${citada ? ` (respondendo ${citada.slice(0, 300)})` : ''}`,
            });
            v.agendadas = (v.agendadas || []).filter((x) => !r.consumidas.includes(x));
            resposta = r.texto;
            servico = 'Julgamento';
          } catch (e) {
            log(`Julgamento pedido por ${autor} não deu (${e.message}).`);
            resposta = `Não consegui abrir o julgamento: ${e.message}.`;
          }
        }

        // Função de admin (remover, adicionar, promover, nome, link...): só confirma depois de conseguir.
        // (Na contestação quem adiciona é ela: não executa um "adicionar" repetido.)
        if (v.acao === 'responder' && v.admin?.acao && v.admin.acao !== 'nenhuma' && !v.contestacao?.fazer && !julgar) {
          try {
            const r = await executarAdmin(v.admin, { jid, ctx, imagens, outrosMarcados, pedidoPor: autor });
            log(`Admin: ${v.admin.acao}${v.admin.pessoas?.length ? ` (${v.admin.pessoas.join(', ')})` : ''} pedido por ${autor}: feito (${r.detalhe}).`);
            servico = 'Admin';
            // Quando o bot tem o resumo com os números (histórico), ele basta: sem o texto do Claude junto.
            resposta = [r.resumoParcial || (r.extra ? '' : resposta), r.parcial, r.extra].filter(Boolean).join('\n');
            // Volta automática do banimento (30 min): avisa, se o pedido não tinha a volta com tempo.
            if (r.aviso && !(v.agendadas || []).some((x) => x.admin?.acao === 'adicionar')) resposta = [resposta, r.aviso].filter(Boolean).join('\n');
          } catch (e) {
            log(`Admin: ${v.admin.acao} pedido por ${autor} não deu (${e.message}).`);
            resposta = `Não consegui: ${e.message}.`;
          }
        }

        // Cancelar agendamentos que ainda não dispararam (antes de criar os novos: "troca a lição pro Nicolas").
        if (v.acao === 'responder' && Array.isArray(v.cancelar_agendadas) && v.cancelar_agendadas.length) {
          const canceladas = [];
          for (const id of v.cancelar_agendadas.slice(0, 10)) {
            const a = pendentes(jid).find((p) => p.id === String(id).trim());
            // A volta de um banimento fica: ninguém passa de 30 min fora (para trazer antes, só contestando).
            const ban = a && banimentos.find((b) => b.ativo && b.agendaId === a.id);
            if (ban) {
              log(`Cancelar agendado ${a.id} (pedido de ${autor}): é a volta do banimento de ${ban.nome}; fica.`);
              resposta = [resposta, `A volta de ${ban.nome} não cancela: o máximo fora é ${BAN_MAX_MIN} min.`].filter(Boolean).join('\n');
              continue;
            }
            if (!a || !cancelarAgendada(a.id)) { log(`Cancelar agendado ${id} (pedido de ${autor}): não achei.`); continue; }
            canceladas.push(`${a.descricao} das ${horaBR(a.quando)}`);
            log(`Agendado ${a.id} cancelado por ${autor}: ${a.descricao} das ${horaBR(a.quando)}${a.mensagem ? ` (mensagem "${a.mensagem.slice(0, 60)}")` : ''}.`);
          }
          if (canceladas.length) {
            servico = servico ? `${servico} + Cancelado` : 'Cancelado';
            resposta = [resposta, `❌ Cancelado: ${canceladas.join('; ')}.`].filter(Boolean).join('\n');
          }
        }

        // Ações com timer ("adiciona o Nicolas de volta em 10 min", "me lembra em 1 hora").
        if (v.acao === 'responder' && Array.isArray(v.agendadas) && v.agendadas.length) {
          const meta2 = await metadadosGrupo(jid).catch(() => meta);
          const feitas = [];
          // Banimento: a volta é no máximo 30 min depois da remoção (agora, ou a remoção agendada neste pedido).
          const removeEm = new Map();
          for (const a of v.agendadas.slice(0, 5)) {
            if (a.admin?.acao === 'remover') for (const f of await fonesDe(a.admin.pessoas, meta2)) removeEm.set(f, Math.max(0.25, Number(a.minutos) || 0));
          }
          let passouDoLimite = false;
          for (const a of v.agendadas.slice(0, 5)) {
            let minutos = Math.min(7 * 24 * 60, Math.max(0.25, Number(a.minutos) || 0));
            const admin = a.admin?.acao && a.admin.acao !== 'nenhuma' ? a.admin : null;
            if (!admin && !a.mensagem?.trim()) continue;
            if (admin?.acao === 'adicionar') {
              const fonesDaVolta = await fonesDe(admin.pessoas, meta2);
              const ban = fonesDaVolta.map((f) => banAtivo(jid, f)).find(Boolean);
              const removidoEm = ban ? (ban.em - Date.now()) / 60e3 : fonesDaVolta.map((f) => removeEm.get(f)).find((x) => x != null);
              if (removidoEm != null && minutos > removidoEm + BAN_MAX_MIN + 0.5) {
                minutos = Math.max(0.25, removidoEm + BAN_MAX_MIN);
                passouDoLimite = true;
              }
              // A volta automática do banimento já está na agenda: só muda a hora (e junta o histórico), sem criar outra.
              const volta = ban && pendentes(jid).find((p) => p.id === ban.agendaId);
              if (volta) {
                volta.quando = Date.now() + minutos * 60e3;
                volta.pedidoPor = autor;
                if (admin.mandar_historico) {
                  Object.assign(volta.admin, { mandar_historico: true, historico_completo: !!(admin.historico_completo || volta.admin.historico_completo), texto: admin.texto || volta.admin.texto });
                }
                salvarAgenda();
                ban.volta = volta.quando;
                salvarBans();
                feitas.push(`${volta.descricao} às ${horaBR(volta.quando)}${admin.mandar_historico ? ' (com o histórico)' : ''}`);
                log(`Agendado por ${autor}: volta do banimento ${ban.id} (${ban.nome}) às ${horaBR(volta.quando)} (em ${minutos.toFixed(1)} min).`);
                continue;
              }
            }
            // Mesma ação para a mesma pessoa já agendada perto dessa hora (ex: duas pessoas pediram, ou
            // "quando ele voltar manda o histórico"): não repete; se o novo pede o histórico, junta no que já tem.
            // A pessoa pode vir pelo LID num pedido e pelo número no outro: compara pelo telefone.
            const fones = async (lista) => (await Promise.all((lista || []).map((n) => telefoneDe(n, meta2)))).sort().join();
            let igual = null;
            if (admin) {
              const meus = await fones(admin.pessoas);
              for (const p of pendentes(jid)) {
                if (p.admin?.acao === admin.acao && Math.abs(p.quando - (Date.now() + minutos * 60e3)) < 10 * 60e3
                  && await fones(p.admin.pessoas) === meus) { igual = p; break; }
              }
            }
            if (igual) {
              if (admin.mandar_historico && (!igual.admin.mandar_historico || (admin.historico_completo && !igual.admin.historico_completo))) {
                igual.admin.mandar_historico = true;
                if (admin.historico_completo) Object.assign(igual.admin, { historico_completo: true, texto: admin.texto || igual.admin.texto });
                salvarAgenda();
                feitas.push(`${igual.descricao} (já estava agendado; agora manda o histórico junto)`);
              } else feitas.push(`${descreverAcao(admin, meta2)} (já estava agendado)`);
              continue;
            }
            const quando = Date.now() + minutos * 60e3;
            const descricao = admin ? descreverAcao(admin, meta2) : 'aviso';
            // historico_desde: se for "adicionar e mandar o histórico", conta a partir do pedido.
            // Remoção agendada por quem não é o dono do bot vira julgamento na hora marcada (semJulgamento = pedido do dono).
            agendar({ jid, quando, admin: admin ? { ...admin, historico_desde: Date.now() } : null, mensagem: a.mensagem || '', pedidoPor: autor, descricao, semJulgamento: dono, pedidoPorIds: idsDoAutor });
            const hora = horaBR(quando);
            feitas.push(`${descricao} às ${hora}`);
            log(`Agendado por ${autor} para ${hora} (em ${minutos} min): ${admin ? admin.acao + (admin.pessoas?.length ? ` (${admin.pessoas.join(', ')})` : '') : ''}${a.mensagem ? ` mensagem "${a.mensagem.slice(0, 60)}"` : ''}.`);
          }
          if (feitas.length) {
            servico = servico ? `${servico} + Agendado` : 'Agendado';
            resposta = [resposta, `⏰ ${feitas.join('; ')}.`].filter(Boolean).join('\n');
          }
          if (passouDoLimite && !/limite/i.test(resposta || '')) resposta = [resposta, `Limite é ${BAN_MAX_MIN} min, então fica ${BAN_MAX_MIN} min.`].filter(Boolean).join('\n');
        }

        // Enquete (com ação se aprovada, ex: expulsar se metade + 1 votar sim).
        if (v.acao === 'responder' && v.enquete?.fazer) {
          try {
            const regra = await criarEnquete(v.enquete, jid, autor);
            servico = 'Enquete';
            resposta = [resposta, regra].filter(Boolean).join('\n');
          } catch (e) {
            log(`Enquete pedida por ${autor} não deu (${e.message}).`);
            resposta = `Não criei a enquete: ${e.message}.`;
          }
        }

        // Imagem gerada pela IA local (ComfyUI).
        if (v.acao === 'responder' && v.imagem_gerada?.fazer && v.imagem_gerada.prompt) {
          if (!geradorOk || !temGerador()) resposta = 'O gerador de imagem tá desligado agora.';
          else {
            try {
              await sock.sendPresenceUpdate('composing', jid).catch(() => {});
              await avisarGerando();
              const png = await gerarImagem(v.imagem_gerada.prompt, { formato: v.imagem_gerada.formato });
              anexos.push({ url: '', gerada: png });
              servico = 'Imagem gerada';
              log(`Imagem gerada para ${autor}: "${v.imagem_gerada.prompt.slice(0, 80)}"`);
            } catch (e) {
              log(`Não deu para gerar a imagem${e.semMemoria ? '' : ' depois de 3 tentativas'} (${e.message}).`);
              resposta = e.semMemoria ? `Não gerei a imagem: ${e.message}.` : falhaAmigavel('imagem');
              // Guarda o prompt no histórico: se pedirem "tenta de novo", o Claude sabe o que era.
              registrar(jid, 'Bot (nota interna)', `a imagem não saiu; prompt usado: ${v.imagem_gerada.prompt}`);
            }
          }
        }

        // Várias figurinhas: uma para CADA mídia que a pessoa mandou nos últimos minutos, cada uma
        // como um serviço próprio (responde a mídia de origem; se uma falhar, as outras saem).
        if (v.acao === 'responder' && v.figurinha?.fazer && v.figurinha.varias && v.figurinha.origem === 'imagem') {
          const fontes = midiasRecentes(jid, donoDasMidias, momentoDasMidias);
          if (!fontes.length) {
            resposta = 'Não achei imagem, GIF ou vídeo mandado nesse momento para virar figurinha.';
          } else {
            let feitas = 0;
            for (const g of fontes) {
              try {
                const c2 = conteudo(g);
                const buffer = await baixar(g);
                const anim = c2.videoMessage ? { buffer, ext: 'mp4' } : c2.stickerMessage?.isAnimated ? { buffer, ext: 'webp' } : null;
                const fig = await montarFigurinha({ ...v.figurinha, origem: 'imagem' }, anim ? [] : [buffer], anim);
                guardarEnviada(await sock.sendMessage(jid, { sticker: fig }, { quoted: g }));
                feitas++;
              } catch (e) {
                log(`Figurinha de uma das mídias de ${autor} falhou (${e.message}).`);
              }
            }
            log(`Figurinhas: ${feitas} de ${fontes.length} mídias de ${autor}.`);
            servico = 'Figurinhas';
            resposta = feitas === fontes.length
              ? `${feitas} figurinha(s), uma para cada mídia.`
              : `${feitas} de ${fontes.length} figurinhas saíram; ${fontes.length - feitas} não deu (mídia antiga ou grande demais).`;
          }
          v.figurinha.fazer = false; // já tratado aqui
        }

        // Figurinha pedida (de imagem mandada, da web, de meme, só texto ou gerada pela IA).
        if (v.acao === 'responder' && v.figurinha?.fazer) {
          try {
            if (v.figurinha.origem === 'gerada') await avisarGerando();
            figurinhaPronta = await montarFigurinha(v.figurinha, imagens, animado);
            servico = 'Figurinha';
            log(`Figurinha (${v.figurinha.origem}) feita para ${autor}.`);
          } catch (e) {
            log(`Não deu para fazer a figurinha (${e.message}).`);
            if (v.figurinha.origem === 'gerada') {
              resposta = e.semMemoria ? `Não gerei a figurinha: ${e.message}.` : falhaAmigavel('figurinha');
              registrar(jid, 'Bot (nota interna)', `a figurinha não saiu; prompt usado: ${v.figurinha.prompt}`);
            } else resposta = `Não consegui fazer a figurinha: ${e.message}.`; // ex: "manda a imagem junto"
          }
        }

        // Figurinha → imagem (ou GIF, se for animada): o contrário da figurinha.
        if (v.acao === 'responder' && v.figurinha_para_imagem && !figurinhaPronta) {
          try {
            const animada = animado?.ext === 'webp';
            if (!imagens.length && !animada) throw new Error('manda (ou responde) a figurinha junto com o pedido');
            anexos.unshift({ pronto: await figurinhaParaMidia(animada ? animado.buffer : imagens[0], { animada }) });
            servico = animada ? 'Figurinha em GIF' : 'Figurinha em imagem';
            log(`Figurinha virou ${animada ? 'GIF' : 'imagem'} para ${autor}.`);
          } catch (e) {
            log(`Não deu para converter a figurinha (${e.message}).`);
            resposta = `Não consegui converter a figurinha: ${e.message}.`;
          }
        }

        // PDF escrito pelo Claude (questões resolvidas, resumo...): o Chrome headless gera o arquivo.
        if (v.acao === 'responder' && v.documento?.fazer && v.documento.html?.trim()) {
          try {
            const pdf = await gerarPdf({ titulo: v.documento.titulo || 'Documento', html: v.documento.html }, { navegador: local.navegador });
            const nome = `${(v.documento.nome || v.documento.titulo || 'documento').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'documento'}.pdf`;
            anexos.unshift({ pronto: { document: pdf, mimetype: 'application/pdf', fileName: nome, caption: '' } });
            servico = 'PDF';
            log(`PDF "${nome}" gerado para ${autor} (${Math.round(pdf.length / 1024)} KB).`);
          } catch (e) {
            log(`Não deu para gerar o PDF (${e.message}).`);
            resposta = `${resposta || ''}\n\nNão consegui gerar o PDF agora (${e.message}).`.trim();
          }
        }

        // Baixa o que o Claude pediu para mandar (com as travas de segurança do web.mjs).
        // Áudio/vídeo: UM só por pedido; os outros links são alternativas, tentadas só se o anterior falhou
        // (ex: YouTube deu 403 → tenta pelo music.youtube.com). E nada repetido: nem o mesmo link, nem o mesmo
        // arquivo, nem o que o bot acabou de mandar no grupo (outra resposta, ou antes de reiniciar).
        const prontos = [];
        const falhas = [];
        const jaMandados = [];
        const chavesVistas = new Set();
        const shasVistos = new Set();
        let midiaOk = false;
        const janela = aposImplementar ? 2 * 3600 : 15 * 60;
        for (const a of anexos) {
          if (a.pronto) { prontos.push(a.pronto); continue; }
          if (a.gerada) { prontos.push({ image: a.gerada, caption: '' }); continue; }
          const somOuVideo = a.tipo === 'audio' || a.tipo === 'video';
          if (somOuVideo && midiaOk) { log(`Anexo extra ignorado (já tem ${a.tipo} neste pedido): ${a.url}`); continue; }
          const chave = chaveDoLink(a.url);
          if (chavesVistas.has(chave)) { log(`Anexo repetido ignorado: ${a.url}`); continue; }
          chavesVistas.add(chave);
          const k = `${jid}|${chave}`;
          if (baixandoAgora.has(k)) await esperarDownloadIgual(k);
          if (anexoRecente(jid, { chave }, janela)) {
            log(`Não mando de novo (o bot já mandou esse ${a.tipo}): ${a.url}`);
            jaMandados.push(a.tipo);
            if (somOuVideo) midiaOk = true;
            continue;
          }
          baixandoAgora.set(k, Date.now());
          reservas.push(k);
          let pronto = null;
          let erro = null;
          for (const url of alternativasDoLink(a.url)) {
            try {
              pronto = await prepararAnexo({ ...a, url }, '');
              log(`Baixei ${a.tipo}: ${url}`);
              break;
            } catch (e) {
              erro = e;
              log(`Não deu para baixar ${a.tipo} (${e.message}): ${url}`);
            }
          }
          if (!pronto) { falhas.push({ somOuVideo, texto: `${a.url} (${erro.message})` }); continue; }
          const sha = shaDoAnexo(pronto);
          if (sha && (shasVistos.has(sha) || anexoRecente(jid, { sha }, janela))) {
            log(`Não mando de novo (mesmo arquivo já ${shasVistos.has(sha) ? 'nesta resposta' : 'mandado'}): ${a.url}`);
            if (!shasVistos.has(sha)) jaMandados.push(a.tipo);
            if (somOuVideo) midiaOk = true;
            continue;
          }
          if (sha) shasVistos.add(sha);
          prontos.push(pronto);
          chavesDosAnexos.set(pronto, chave);
          if (somOuVideo) midiaOk = true;
        }
        anexos = prontos;
        if (anexos.length && !servico) servico = 'Download';
        // Se um áudio/vídeo deu certo, as tentativas que falharam antes não interessam a ninguém.
        const erros = falhas.filter((f) => !(f.somOuVideo && midiaOk)).map((f) => f.texto);
        if (erros.length) resposta = `${resposta || ''}\n\nNão consegui baixar:\n${erros.map((f) => '- ' + f).join('\n')}`.trim();
        if (jaMandados.length && !anexos.some((x) => x.audio || x.video)) {
          const oQue = jaMandados.includes('audio') ? 'Esse áudio' : jaMandados.includes('video') ? 'Esse vídeo' : 'Esse arquivo';
          resposta = `${resposta || ''}\n\n(${oQue} já foi mandado aí em cima; não mando de novo.)`.trim();
        }
      } catch (e) {
        log('Erro ao perguntar ao claude:', e.message);
        resposta = 'Travei aqui, tenta de novo daqui a pouco.';
        anexos = [];
        figurinhaPronta = null;
        servico = null;
      } finally {
        await sock.sendPresenceUpdate('paused', jid).catch(() => {});
      }
      if (!resposta && !anexos.length && !figurinhaPronta) return;
      // Confirmação de serviço: só o essencial do texto do Claude (o que o bot junta, como erros e
      // horários agendados, fica). Download não: ali o texto costuma ser a própria resposta.
      const textoClaude = String(v?.texto || '').trim();
      if (servico && servico !== 'Download' && textoClaude && resposta?.includes(textoClaude)) {
        resposta = resposta.replace(textoClaude, curto(textoClaude));
      }
      if (servico) resposta = marcaServico(servico, resposta);

      // "@123..." no texto só vira marcação de verdade se a mensagem disser quem está sendo marcado.
      const mentions = mencoesDoTexto(resposta, meta);

      // Se o primeiro anexo aceita legenda, o texto vai nele; senão vai antes, numa mensagem própria.
      if (anexos.length && 'caption' in anexos[0] && resposta && resposta.length <= 1000) {
        anexos[0].caption = resposta;
        if (mentions.length) anexos[0].mentions = mentions;
      }
      let ultimaId = null;
      if (!(anexos.length && 'caption' in anexos[0] && anexos[0].caption) && resposta) {
        ultimaId = guardarEnviada(await sock.sendMessage(jid, { text: resposta, mentions }, { quoted: m }))?.key?.id || ultimaId;
      }
      for (const [i, anexo] of anexos.entries()) {
        const id = guardarEnviada(await sock.sendMessage(jid, anexo, i === 0 ? { quoted: m } : {}))?.key?.id;
        const g = id && mensagensGuardadas.get(id);
        if (g && chavesDosAnexos.has(anexo)) g.chave = chavesDosAnexos.get(anexo); // para não mandar de novo
        ultimaId = id || ultimaId;
      }
      if (figurinhaPronta) ultimaId = guardarEnviada(await sock.sendMessage(jid, { sticker: figurinhaPronta }, { quoted: m }))?.key?.id || ultimaId;
      registrar(jid, 'Bot', resposta || '[anexo]');
      ultimaRespostaBot.set(jid, { autorId: jidNormalizedUser(autorId), em: Date.now(), n: contadorMsgs.get(jid) || 0, msgId: ultimaId });
      log(`Respondi ${autor}: "${(resposta || '').slice(0, 80).replace(/\n/g, ' ')}"${anexos.length ? ` + ${anexos.length} anexo(s)` : ''}${figurinhaPronta ? ' + figurinha' : ''}`);
    };
    const decisao = filaClaude.then(decidir);
    filaClaude = decisao.catch(() => {}); // libera a fila assim que o Claude responde
    decisao
      .then((v) => tarefa(v, null), (e) => tarefa(null, e))
      .catch((e) => log('Erro ao responder marcação:', e.stack || e))
      .finally(() => { for (const k of reservas) baixandoAgora.delete(k); }); // link enviado (ou desistiu)
  }

  // ---------- dono do bot ----------
  function ehDono(m, meta) {
    const ids = [m.key.participant, m.key.participantAlt].filter(Boolean).map(jidNormalizedUser);
    const p = (meta?.participants || []).find((x) => [x.id, x.lid, x.phoneNumber].filter(Boolean).some((j) => ids.includes(jidNormalizedUser(j))));
    return [...ids, p?.phoneNumber, p?.id, p?.lid].filter(Boolean).some((j) => CONFIG.donos.includes(digitos(jidNormalizedUser(j))));
  }

  // O dono pediu algo que o bot não sabe: o Claude Code (Opus) programa na pasta do bot; o bot confere
  // (sintaxe + carregar os módulos), faz o push e reinicia. Ao voltar, processa o mesmo pedido de novo.
  // Se a conferência falhar, desfaz o commit e continua no código antigo.
  let implementando = false;
  const ARQ_PENDENTE = path.join(DIR, '.pendente-dono.json');
  const git = (...args) => execFileSync('git', args, { cwd: DIR, encoding: 'utf8', windowsHide: true }).trim();
  async function implementarPedido({ pedido, original, m, jid, autor }) {
    const avisar = async (texto) => guardarEnviada(await sock.sendMessage(jid, { text: marcaServico('Implementação', texto) }, { quoted: m }));
    if (implementando) { await avisar('Já estou programando outra coisa; manda de novo quando eu terminar.'); return; }
    if (git('status', '--porcelain', '--untracked-files=no')) {
      log('Implementar: há mudanças não salvas no código; não mexo.');
      await avisar('Tem mudança não salva no código do bot (alguém está mexendo nele); não vou programar por cima agora.');
      return;
    }
    implementando = true;
    const antes = git('rev-parse', 'HEAD');
    log(`Implementar (pedido de ${autor}): ${pedido.slice(0, 200)}`);
    try {
      const resumoFeito = await implementarNoCodigo({ pedido, original, dir: DIR });
      // Sobrou mudança sem commit: o bot commita.
      if (git('status', '--porcelain', '--untracked-files=no')) {
        git('add', '-u');
        git('commit', '-m', `Implementado a pedido do dono: ${pedido.slice(0, 60)}

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
      }
      if (git('rev-parse', 'HEAD') === antes) {
        log(`Implementar: nada mudou no código (${resumoFeito.slice(0, 200)}).`);
        await avisar(curto(resumoFeito) || 'Não mudei nada no código.');
        return;
      }
      // Confere antes de reiniciar: sintaxe de cada .mjs e carregar todos os módulos.
      const linhas = (t) => (t || '').trim().split(/\r?\n/);
      const arquivos = linhas(git('ls-files', '*.mjs')).filter(Boolean);
      for (const f of arquivos) {
        const r = spawnSync(process.execPath, ['--check', f], { cwd: DIR, encoding: 'utf8', windowsHide: true });
        if (r.status !== 0) throw new Error(`erro de sintaxe em ${f}: ${linhas(r.stderr).slice(0, 4).join(' ')}`);
      }
      const v = spawnSync(process.execPath, ['index.mjs', '--verificar'], { cwd: DIR, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
      if (v.status !== 0) throw new Error(`o bot não carrega: ${linhas(v.stderr).slice(0, 4).join(' ')}`);
      try { git('push', '-q'); } catch (e) { log(`Implementar: push falhou (${e.message}); fica só local.`); }
      log(`Implementar: pronto (${git('log', '--oneline', '-1')}). Reiniciando para usar.`);
      await avisar(`${curto(resumoFeito, 160) || 'Pronto.'}\nReiniciando; já volto e faço o pedido.`);
      fs.writeFileSync(ARQ_PENDENTE, JSON.stringify({ jid, id: m.key.id, em: Date.now() }));
      setTimeout(() => process.exit(0), 3000); // start.cmd sobe de novo com o código novo
    } catch (e) {
      log(`Implementar: falhou (${e.message}).`);
      if (git('rev-parse', 'HEAD') !== antes || git('status', '--porcelain', '--untracked-files=no')) {
        git('reset', '--hard', antes); // só desfaz o que foi feito agora (antes estava tudo salvo)
        log(`Implementar: código voltou para ${antes.slice(0, 7)}.`);
      }
      await avisar(`Não consegui programar isso: ${e.message.slice(0, 150)}`).catch(() => {});
    } finally {
      implementando = false;
    }
  }

  // Ao ligar: se reiniciou por causa de uma implementação, refaz o pedido do dono (agora com a função nova).
  async function retomarPedidoDoDono() {
    let p;
    try { p = JSON.parse(fs.readFileSync(ARQ_PENDENTE, 'utf8')); } catch { return; }
    fs.rmSync(ARQ_PENDENTE, { force: true });
    if (Date.now() - p.em > 60 * 60e3) return;
    const m = mensagensGuardadas.get(p.id);
    if (!m) { log('Implementar: não achei a mensagem do pedido para refazer.'); return; }
    log('Implementar: refazendo o pedido do dono com o código novo.');
    await responderMarcacao(m, p.jid, await metadadosGrupo(p.jid), { aposImplementar: true });
  }

  // ---------- marcar pessoas ----------
  // Nomes vistos no grupo (nome de perfil), para o Claude saber como marcar cada um.
  const conhecidos = new Map(); // grupo -> Map(id -> nome)
  function lembrarPessoa(jid, m) {
    if (m.key.fromMe || !m.pushName) return;
    lembrarNome(m.key.participant, m.pushName);
    lembrarNome(m.key.participantAlt, m.pushName);
    const mapa = conhecidos.get(jid) || new Map();
    for (const id of [m.key.participant, m.key.participantAlt].filter(Boolean)) mapa.set(digitos(jidNormalizedUser(id)), m.pushName);
    conhecidos.set(jid, mapa);
  }
  // Todos os participantes (não só quem falou desde que o bot ligou), com o nome quando se sabe e
  // quem é admin: o Claude precisa disso para marcar e para as funções de admin.
  function pessoasParaPrompt(jid, meta) {
    const linhas = new Map();
    // Quem falou no grupo mas não está mais nele (removido/saiu): marcado, para o Claude não tentar remover.
    const presentes = new Set((meta?.participants || []).flatMap((p) => [p.id, p.lid, p.phoneNumber].filter(Boolean).map((i) => digitos(jidNormalizedUser(i)))));
    for (const [id, nome] of conhecidos.get(jid) || new Map()) linhas.set(id, { nome, admin: meta?.participants && !presentes.has(id) ? ' (fora do grupo)' : '' });
    for (const p of meta?.participants || []) {
      const ids = [p.id, p.lid, p.phoneNumber].filter(Boolean);
      if (ids.some((i) => meusIds().includes(jidNormalizedUser(i)))) continue; // o próprio bot
      const id = digitos(jidNormalizedUser(p.id));
      const nome = linhas.get(id)?.nome || nomeDaPessoa(...ids) || (p.phoneNumber ? `+${digitos(p.phoneNumber)}` : '(sem nome)');
      linhas.set(id, { nome, admin: p.admin === 'superadmin' ? ' (dono do grupo)' : p.admin ? ' (admin)' : '' });
    }
    return [...linhas].map(([id, { nome, admin }]) => `${nome} = @${id}${admin}`).join('\n');
  }

  // ---------- funções de admin ----------
  // Quando cada pessoa saiu do grupo (para mandar o que ela perdeu quando voltar).
  const ARQ_SAIDAS = path.join(DIR, '.saidas.json');
  let saidas = {};
  try { saidas = JSON.parse(fs.readFileSync(ARQ_SAIDAS, 'utf8')); } catch { /* nenhuma */ }
  // Todas as vezes que cada pessoa ficou fora ({ "grupo|número": { saidas: [ms], voltas: [ms] } }): o
  // "histórico completo" junta as mensagens de cada período, da primeira saída até agora.
  const ARQ_PERIODOS = path.join(DIR, '.periodos-fora.json');
  let periodos = {};
  try { periodos = JSON.parse(fs.readFileSync(ARQ_PERIODOS, 'utf8')); } catch { /* nenhum */ }
  function marcarSaida(jid, ids, sufixo = '') {
    const agora = Date.now();
    const tipo = sufixo ? 'voltas' : 'saidas';
    for (const i of ids.filter(Boolean)) {
      const chave = `${jid}|${digitos(jidNormalizedUser(i))}`;
      saidas[chave + sufixo] = agora;
      if (!/^\d{8,}$/.test(digitos(jidNormalizedUser(i)))) continue;
      const lista = ((periodos[chave] ||= { saidas: [], voltas: [] })[tipo] ||= []);
      // O comando do bot e o aviso do WhatsApp marcam a mesma saída/volta: conta uma vez só.
      if (!lista.length || agora - lista[lista.length - 1] > 30_000) lista.push(agora);
      while (lista.length > 300) lista.shift();
    }
    try { fs.writeFileSync(ARQ_SAIDAS, JSON.stringify(saidas)); } catch { /* tenta na próxima */ }
    try { fs.writeFileSync(ARQ_PERIODOS, JSON.stringify(periodos)); } catch { /* tenta na próxima */ }
  }
  /** Cada período fora da pessoa (todos os ids dela juntos), mais antigo primeiro: [{ saiu, voltou, ate }] em ms. */
  function periodosFora(jid, ids) {
    const chaves = [...new Set(ids.filter(Boolean).map((i) => `${jid}|${digitos(jidNormalizedUser(i))}`))];
    const juntar = (tipo) => [...new Set(chaves.flatMap((k) => periodos[k]?.[tipo] || []))].sort((x, y) => x - y)
      .filter((t, i, l) => !i || t - l[i - 1] > 30_000);
    const saiu = juntar('saidas');
    const voltas = juntar('voltas');
    return saiu.map((s, i) => {
      const proxima = saiu[i + 1] || Infinity;
      const voltou = voltas.find((v) => v > s && v <= proxima) || null;
      // Sem volta registrada: vai até a saída seguinte (ou até agora, se ainda está fora).
      return { saiu: s, voltou, ate: voltou || (proxima < Infinity ? proxima : Date.now()) };
    });
  }
  // Todos os ids (LID e número) da mesma pessoa, para achar as saídas marcadas por qualquer um deles.
  async function idsDaPessoa(j, meta) {
    const d = digitos(jidNormalizedUser(j));
    const p = (meta?.participants || []).find((x) => [x.id, x.lid, x.phoneNumber].filter(Boolean).some((i) => digitos(jidNormalizedUser(i)) === d));
    const ids = [j, p?.id, p?.lid, p?.phoneNumber];
    const mapa = sock.signalRepository?.lidMapping;
    ids.push(await mapa?.getPNForLID?.(`${d}@lid`).catch(() => null), await mapa?.getLIDForPN?.(`${d}@s.whatsapp.net`).catch(() => null));
    return [...new Set(ids.filter(Boolean).map((i) => jidNormalizedUser(String(i))))];
  }
  /** Manda no privado as mensagens do grupo desde que a pessoa saiu (ou desde `desde`). */
  // Número de telefone de alguém (vindo como LID ou número), para comparar a mesma pessoa.
  async function telefoneDe(n, meta) {
    const d = digitos(n);
    const p = (meta?.participants || []).find((x) => [x.id, x.lid, x.phoneNumber].filter(Boolean).some((j) => digitos(jidNormalizedUser(j)) === d));
    if (p?.phoneNumber) return digitos(jidNormalizedUser(p.phoneNumber));
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(`${d}@lid`).catch(() => null);
    return pn ? digitos(jidNormalizedUser(pn)) : d;
  }

  const marcarVolta = (jid, ids) => marcarSaida(jid, ids, '|volta');

  // ---------- banimentos (remoções do bot) e contestação ----------
  // Cada remoção feita pelo bot vira um banimento em .banimentos.json ({ id, jid, fone, ids, nome, pedidoPor,
  // em, volta, agendaId, ativo, contestacoes }). Ninguém fica fora mais que BAN_MAX_MIN: o bot agenda a volta.
  const BAN_MAX_MIN = 30;
  const ARQ_BANS = path.join(DIR, '.banimentos.json');
  let banimentos = [];
  try { banimentos = JSON.parse(fs.readFileSync(ARQ_BANS, 'utf8')); } catch { /* nenhum */ }
  const salvarBans = () => {
    while (banimentos.length > 300) banimentos.shift();
    try { fs.writeFileSync(ARQ_BANS, JSON.stringify(banimentos, null, 1)); } catch { /* tenta na próxima */ }
  };
  const banAtivo = (jid, fone) => banimentos.find((b) => b.jid === jid && b.ativo && (b.fone === fone || b.ids.includes(fone)));
  // Números das pessoas de uma ação (LID ou telefone → telefone), para achar a mesma pessoa.
  const fonesDe = (lista, meta) => Promise.all((lista || []).map((n) => telefoneDe(n, meta)));
  /** A pessoa voltou (ou foi removida de novo): o banimento acaba. Com cancelarVolta, tira a volta automática da agenda. */
  function encerrarBanimento(jid, nums, como, cancelarVolta = false) {
    let mudou = false;
    for (const b of banimentos) {
      if (b.jid !== jid || !b.ativo || !nums.some((n) => n && (n === b.fone || b.ids.includes(n)))) continue;
      Object.assign(b, { ativo: false, fim: Date.now(), como });
      // A volta que ia mandar o histórico continua (se já voltou pelo link, ela manda o PDF na hora marcada).
      const volta = pendentes(jid).find((a) => a.id === b.agendaId);
      if (cancelarVolta && volta && !volta.admin?.mandar_historico && (volta.admin?.pessoas || []).length <= 1) cancelarAgendada(volta.id);
      log(`Banimento ${b.id} de ${b.nome} encerrado (${como}).`);
      mudou = true;
    }
    if (mudou) salvarBans();
  }
  /** O bot removeu alguém: guarda o banimento e garante a volta em até 30 min. Devolve o aviso para o grupo (ou ''). */
  async function registrarBanimento(jid, j, p, meta, pedidoPor) {
    const ids = [...new Set([j, p?.id, p?.lid, p?.phoneNumber].filter(Boolean).map((i) => digitos(jidNormalizedUser(i))))];
    const fone = p?.phoneNumber ? digitos(jidNormalizedUser(p.phoneNumber)) : await telefoneDe(digitos(jidNormalizedUser(j)), meta);
    if (!ids.includes(fone)) ids.push(fone);
    encerrarBanimento(jid, ids, 'removido de novo');
    // Removido por outro caminho (pedido do dono, enquete) durante o julgamento: o julgamento acaba.
    for (const x of julgamentos) {
      if (x.jid === jid && x.status === 'aberto' && ids.some((i) => i === x.fone || x.ids.includes(i))) fecharJulgamento(x, 'encerrado', `removido a pedido de ${pedidoPor || 'alguém'}`);
    }
    const nome = nomeDaPessoa(j, p?.id, p?.lid, p?.phoneNumber) || `+${fone}`;
    const agora = Date.now();
    const limite = agora + BAN_MAX_MIN * 60e3;
    const ban = { id: crypto.randomBytes(3).toString('hex'), jid, fone, ids, nome, pedidoPor: pedidoPor || 'alguém', em: agora, volta: limite, agendaId: null, ativo: true, contestacoes: [] };
    // Volta já agendada (ex: "remove daqui a 5 min e volta em 10"): usa ela, cortando em 30 min.
    let volta = null;
    for (const a of pendentes(jid)) {
      if (a.admin?.acao === 'adicionar' && (await fonesDe(a.admin.pessoas, meta)).includes(fone)) { volta = a; break; }
    }
    let aviso = '';
    if (volta) {
      if (volta.quando > limite) {
        volta.quando = limite;
        salvarAgenda();
        aviso = `Limite é ${BAN_MAX_MIN} min, então ${nome} volta às ${horaBR(limite)}.`;
      }
      Object.assign(ban, { agendaId: volta.id, volta: volta.quando });
    } else {
      ban.agendaId = agendar({
        jid, quando: limite, mensagem: '', pedidoPor: `limite de ${BAN_MAX_MIN} min`, descricao: `adiciono ${nome}`,
        admin: { acao: 'adicionar', pessoas: [fone], texto: '', tempo: '', mandar_historico: false, historico_completo: false, historico_desde: agora },
      });
      aviso = `⏰ ${nome} volta às ${horaBR(limite)} (máximo ${BAN_MAX_MIN} min fora).`;
    }
    banimentos.push(ban);
    salvarBans();
    log(`Banimento ${ban.id}: ${nome} (${fone}) removido a pedido de ${ban.pedidoPor}; volta às ${horaBR(ban.volta)}.`);
    avisarBanido(ban); // no privado: até quando fica fora e que pode contestar ali
    return aviso;
  }
  // Banimentos que ainda valem, para o Claude saber quem dá para contestar (e o que já foi contestado).
  function banimentosParaPrompt(jid) {
    return banimentos.filter((b) => b.jid === jid && b.ativo && Date.now() - b.em < 24 * 60 * 60e3).map((b) => {
      const volta = pendentes(jid).find((a) => a.id === b.agendaId);
      const cont = b.contestacoes.length
        ? b.contestacoes.map((c) => `${c.por} contestou às ${horaBR(c.em)} ("${c.motivo.slice(0, 150)}"): ${c.aceita ? 'aceita' : 'NEGADA'}`).join('; ')
        : 'sem contestação';
      return `${b.id} | ${b.nome} = @${b.fone} | removido às ${horaBR(b.em)} a pedido de ${b.pedidoPor} | volta às ${horaBR(volta?.quando || b.volta)} | ${cont}`;
    }).join('\n');
  }
  /**
   * Contestação de banimento: confere quem contesta (tem que estar no grupo e não ser o banido) e, se o
   * Claude aceitou o argumento, adiciona de volta na hora e tira a volta antiga da agenda. Devolve { texto, pergunta, julgada }.
   * Com `doBanido` (o banimento), é o próprio banido contestando pelo privado do bot: aí não precisa estar no grupo.
   */
  async function contestarBanimento(c, { jid, m, autor, texto, doBanido = null }) {
    const ativos = banimentos.filter((b) => b.jid === jid && b.ativo);
    const ban = doBanido || ativos.find((b) => b.id === String(c.banimento_id || '').trim()) || (ativos.length === 1 ? ativos[0] : null);
    if (!ban) return { texto: ativos.length ? 'Contestar o banimento de quem?' : 'Não tem banimento valendo pra contestar.', pergunta: true };
    const meta = await sock.groupMetadata(jid); // na hora: quem está no grupo agora
    if (!doBanido) {
      const doAutor = [m.key.participant, m.key.participantAlt].filter(Boolean).map((i) => digitos(jidNormalizedUser(i)));
      const membro = (meta.participants || []).find((p) => [p.id, p.lid, p.phoneNumber].filter(Boolean).some((i) => doAutor.includes(digitos(jidNormalizedUser(i)))));
      if (!membro) {
        log(`Contestação do banimento ${ban.id} por ${autor} recusada: não está no grupo.`);
        return { texto: 'Contestação não vale: só quem tá no grupo pode contestar (quem foi banido contesta no meu privado).' };
      }
      const idsAutor = [...doAutor, ...[membro.id, membro.lid, membro.phoneNumber].filter(Boolean).map((i) => digitos(jidNormalizedUser(i)))];
      if (idsAutor.some((i) => i === ban.fone || ban.ids.includes(i))) return { texto: 'Não dá pra contestar o próprio banimento aqui: manda o motivo no meu privado.' };
    }
    const motivo = String(c.motivo || '').trim();
    if (!motivo) return { texto: texto?.trim() || `Qual o motivo da contestação do banimento de ${ban.nome}?`, pergunta: true };
    // Uma contestação por banimento: depois de negada, só volta a julgar se trouxer argumento novo.
    if (ban.contestacoes.some((x) => !x.aceita) && !c.argumento_novo) {
      log(`Contestação do banimento ${ban.id} por ${autor} ignorada: já foi negada e não trouxe argumento novo.`);
      return { texto: 'Esse banimento já foi contestado e negado; só com argumento novo.' };
    }
    const registro = { por: autor, motivo: motivo.slice(0, 500), aceita: !!c.aceitar, em: Date.now() };
    ban.contestacoes.push(registro);
    salvarBans();
    log(`Contestação do banimento ${ban.id} (${ban.nome}) por ${autor}: ${registro.aceita ? 'aceita' : 'negada'} ("${registro.motivo.slice(0, 80)}").`);
    if (!registro.aceita) return { texto: texto?.trim() || 'Contestação negada, fica o tempo que tá.', julgada: true };

    // Aceita: as voltas agendadas dessa pessoa (se alguma ia mandar o histórico, a volta de agora manda).
    const voltas = [];
    for (const a of pendentes(jid)) {
      if (a.admin?.acao === 'adicionar' && (a.id === ban.agendaId || (await fonesDe(a.admin.pessoas, meta)).includes(ban.fone))) voltas.push(a);
    }
    const comHistorico = voltas.find((a) => a.admin.mandar_historico)?.admin;
    let r;
    try {
      r = await executarAdmin({
        acao: 'adicionar', pessoas: [ban.fone], texto: comHistorico?.texto || '', tempo: '',
        mandar_historico: !!comHistorico, historico_completo: !!comHistorico?.historico_completo, historico_desde: comHistorico?.historico_desde || ban.em,
      }, { jid, ctx: null, imagens: [], outrosMarcados: [], pedidoPor: autor });
    } catch (e) {
      log(`Contestação aceita, mas não deu para adicionar ${ban.nome} (${e.message}).`);
      return { texto: `Contestação aceita, mas não consegui adicionar ${ban.nome}: ${e.message}.`, julgada: true, aceita: true };
    }
    // Para não adicionar duas vezes: tira a pessoa das voltas agendadas (a agendada só some se era só ela).
    for (const a of voltas) {
      const resto = [];
      for (const n of a.admin.pessoas || []) if (await telefoneDe(n, meta) !== ban.fone) resto.push(n);
      if (resto.length) {
        a.admin.pessoas = resto;
        a.descricao = descreverAcao(a.admin, meta);
        salvarAgenda();
      } else cancelarAgendada(a.id);
      log(`Contestação aceita: volta agendada ${a.id} das ${horaBR(a.quando)} ${resto.length ? 'sem ' + ban.nome : 'cancelada'}.`);
    }
    if (!r.parcial) encerrarBanimento(jid, [ban.fone, ...ban.ids], 'contestação aceita');
    return { texto: [r.resumoParcial || texto?.trim() || `Contestação aceita, ${ban.nome} de volta.`, r.parcial].filter(Boolean).join('\n'), julgada: true, aceita: true };
  }

  // ---------- julgamento antes do banimento ----------
  // Pedido de ban de quem não é o dono do bot não remove na hora: abre um julgamento em .julgamentos.json
  // ({ id, jid, alvo, fone, ids, nome, pedidoPor, pedidoPorIds, pedido, em, prazo, falas, volta, defensor, status }).
  // O bot avisa no grupo quem é julgado e quem pediu; o julgado se defende (sozinho ou pedindo um defensor)
  // no grupo ou no privado até o prazo. Aí o Claude dá o veredito (quem pediu o ban é só acusação):
  // condenado = remove e vira banimento (volta em até 30 min, contestação depois); absolvido = fica.
  const JULG_PRAZO_MIN = 5;
  const JULG_EXTRA_MIN = 3; // o julgado pediu um defensor: o prazo estica (uma vez) para ele falar
  const ARQ_JULG = path.join(DIR, '.julgamentos.json');
  let julgamentos = [];
  try { julgamentos = JSON.parse(fs.readFileSync(ARQ_JULG, 'utf8')); } catch { /* nenhum */ }
  const salvarJulg = () => {
    while (julgamentos.length > 200) julgamentos.shift();
    try { fs.writeFileSync(ARQ_JULG, JSON.stringify(julgamentos, null, 1)); } catch { /* tenta na próxima */ }
  };
  const julgAbertos = (jid) => julgamentos.filter((j) => j.status === 'aberto' && (!jid || j.jid === jid));
  const ehDaPessoa = (lista, ids) => ids.some((i) => i && lista.includes(i));
  function fecharJulgamento(j, status, motivo) {
    Object.assign(j, { status, fim: Date.now(), motivo: String(motivo || '').slice(0, 300) });
    salvarJulg();
    log(`Julgamento ${j.id} de ${j.nome}: ${status}${motivo ? ` (${String(motivo).slice(0, 120)})` : ''}.`);
  }
  // Quem está falando no julgamento (para o juiz pesar: a palavra de quem pediu o ban é só acusação).
  const papelNoJulgamento = (j, ids) => (ehDaPessoa([j.fone, ...j.ids], ids) ? 'julgado'
    : ehDaPessoa(j.pedidoPorIds || [], ids) ? 'quem pediu o ban'
    : ehDaPessoa(j.defensor?.ids || [], ids) ? 'defensor pedido pelo julgado' : 'outro membro');
  // Julgamentos em andamento, para o Claude saber quem está sendo julgado e o que já foi dito.
  function julgamentosParaPrompt(jid) {
    return julgAbertos(jid).map((j) => {
      const falas = j.falas.length ? j.falas.slice(-6).map((f) => `${f.por} (${f.papel}): "${f.texto.slice(0, 120)}"`).join('; ') : 'ninguém falou ainda';
      return `${j.id} | ${j.nome} = @${digitos(j.alvo)} | pedido por ${j.pedidoPor} | veredito às ${horaBR(j.prazo)}${j.defensor ? ` | defensor: ${j.defensor.nome}` : ''} | ${falas}`;
    }).join('\n');
  }

  /**
   * Abre um julgamento para cada pessoa do pedido de remoção (em vez de remover). Devolve { texto, consumidas }:
   * o aviso para o grupo e as agendadas de volta ("bane por 10 min") que ficaram guardadas nos julgamentos.
   */
  async function abrirJulgamentos(a, { jid, ctx, outrosMarcados = [], pedidoPor, pedidoPorIds = [], pedido = '', voltas = [] }) {
    const meta = await sock.groupMetadata(jid); // na hora: quem está no grupo agora
    const eu = (meta.participants || []).find((p) => [p.id, p.lid, p.phoneNumber].filter(Boolean).some((i) => meusIds().includes(jidNormalizedUser(i))));
    if (!eu?.admin) throw new Error('não sou admin do grupo, então não conseguiria cumprir a condenação');
    const participante = (n) => (meta.participants || []).find((x) =>
      [x.id, x.lid, x.phoneNumber].filter(Boolean).some((j) => digitos(jidNormalizedUser(j)) === n));
    let alvos = [...new Set((a.pessoas || []).map(digitos).filter((n) => n.length >= 8))].map(participante).filter(Boolean);
    // Sem número: quem foi marcado na mensagem, ou o autor da mensagem respondida.
    if (!alvos.length) alvos = (outrosMarcados.length ? outrosMarcados : ctx?.participant ? [ctx.participant] : []).map((j) => participante(digitos(jidNormalizedUser(j)))).filter(Boolean);
    alvos = [...new Set(alvos)].filter((p) => ![p.id, p.lid, p.phoneNumber].filter(Boolean).some((i) => meusIds().includes(jidNormalizedUser(i))));
    if (!alvos.length) throw new Error('não achei quem é a pessoa no grupo');
    const acusador = pedidoPorIds.map(participante).find(Boolean);
    const quemPediu = acusador ? `@${digitos(acusador.id)}` : pedidoPor;
    const consumidas = [];
    const textos = [];
    for (const p of alvos) {
      const ids = [...new Set([p.id, p.lid, p.phoneNumber].filter(Boolean).map((i) => digitos(jidNormalizedUser(i))))];
      const fone = p.phoneNumber ? digitos(jidNormalizedUser(p.phoneNumber)) : await telefoneDe(digitos(jidNormalizedUser(p.id)), meta);
      if (!ids.includes(fone)) ids.push(fone);
      const nome = nomeDaPessoa(p.id, p.lid, p.phoneNumber) || `+${fone}`;
      const ja = julgAbertos(jid).find((j) => ehDaPessoa([j.fone, ...j.ids], ids));
      if (ja) { textos.push(`${nome} já está em julgamento: veredito às ${horaBR(ja.prazo)}.`); continue; }
      // Volta com tempo pedida junto (neste pedido, ou já na agenda quando a remoção era agendada).
      let volta = null;
      for (const x of voltas) {
        if (!consumidas.includes(x) && (await fonesDe(x.admin.pessoas, meta)).includes(fone)) {
          volta = { minutos: Math.max(0.25, Number(x.minutos) || 0), admin: x.admin, mensagem: x.mensagem || '' };
          consumidas.push(x);
          break;
        }
      }
      if (!volta) {
        for (const x of pendentes(jid)) {
          if (x.admin?.acao !== 'adicionar' || (x.admin.pessoas || []).length > 1 || !(await fonesDe(x.admin.pessoas, meta)).includes(fone)) continue;
          volta = { minutos: Math.max(0.25, (x.quando - Date.now()) / 60e3), admin: x.admin, mensagem: x.mensagem || '' };
          cancelarAgendada(x.id);
          log(`Julgamento: a volta agendada ${x.id} de ${nome} fica guardada para depois do veredito.`);
          break;
        }
      }
      const agora = Date.now();
      const j = {
        id: crypto.randomBytes(3).toString('hex'), jid, alvo: p.id, fone, ids, nome, pedidoPor: pedidoPor || 'alguém', pedidoPorIds,
        pedido: String(pedido).slice(0, 800), em: agora, prazo: agora + JULG_PRAZO_MIN * 60e3, falas: [], volta, defensor: null, status: 'aberto',
      };
      julgamentos.push(j);
      salvarJulg();
      log(`Julgamento ${j.id} aberto: ${nome} (${fone}), ban pedido por ${j.pedidoPor}; veredito às ${horaBR(j.prazo)}.`);
      textos.push(`⚖️ Julgamento de @${digitos(p.id)}: ${quemPediu} pediu o ban. Antes de banir eu ouço a defesa: até as ${horaBR(j.prazo)} (${JULG_PRAZO_MIN} min) ${nome} pode se defender aqui (me marcando ou respondendo esta mensagem) ou no meu privado, ou pedir pra alguém do grupo defender. Quem pediu o ban não decide: no fim eu dou o veredito.`);
      // No privado do julgado também, para ele não perder o prazo.
      const destino = jidNormalizedUser(p.phoneNumber || p.id);
      enviarPrivado(destino, `Pediram teu ban no *${meta.subject}* (${j.pedidoPor}). Antes de decidir eu ouço tua defesa: manda aqui (ou no grupo, me marcando) teu argumento até as ${horaBR(j.prazo)}. Se quiser, diz quem do grupo te defende.`)
        .then(() => log(`Julgamento ${j.id}: avisei ${nome} no privado.`), (e) => log(`Julgamento ${j.id}: não deu para avisar ${nome} no privado (${e.message}).`));
    }
    return { texto: textos.join('\n'), consumidas };
  }

  /**
   * Fala num julgamento aberto (no grupo ou no privado): guarda o argumento com o papel de quem falou e, se o
   * julgado pediu um defensor, estica o prazo uma vez e chama o defensor no grupo. Devolve { texto, avisoGrupo }.
   */
  async function falarNoJulgamento(f, { jid = null, idsAutor, autor, onde }) {
    const abertos = julgAbertos(jid);
    const j = abertos.find((x) => x.id === String(f.julgamento_id || '').trim()) || (abertos.length === 1 ? abertos[0] : null);
    if (!j) return {};
    const papel = papelNoJulgamento(j, idsAutor);
    const argumento = String(f.argumento || '').trim();
    if (argumento) {
      j.falas.push({ por: autor, papel, texto: argumento.slice(0, 600), onde, em: Date.now() });
      while (j.falas.length > 40) j.falas.shift();
      log(`Julgamento ${j.id} (${j.nome}): ${autor} (${papel}, ${onde}): "${argumento.slice(0, 80)}".`);
    }
    let avisoGrupo = '';
    const pedido = String(f.defensor || '').trim();
    if (pedido && papel === 'julgado' && !j.defensor) {
      const meta = await metadadosGrupo(j.jid).catch(() => null);
      const alvo = normalizar(pedido.replace(/^@/, ''));
      const p = (meta?.participants || []).find((x) => {
        const ids = [x.id, x.lid, x.phoneNumber].filter(Boolean);
        return ids.some((i) => digitos(jidNormalizedUser(i)) === digitos(pedido)) || (alvo && normalizar(nomeDaPessoa(...ids) || '').includes(alvo));
      });
      if (p) {
        const ids = [p.id, p.lid, p.phoneNumber].filter(Boolean).map((i) => digitos(jidNormalizedUser(i)));
        j.defensor = { nome: nomeDaPessoa(p.id, p.lid, p.phoneNumber) || pedido, ids };
        j.prazo = Math.max(j.prazo, Date.now() + JULG_EXTRA_MIN * 60e3);
        avisoGrupo = `⚖️ @${digitos(p.id)}, ${j.nome} pediu tua defesa: manda o argumento até as ${horaBR(j.prazo)} (aqui me marcando ou no meu privado).`;
        log(`Julgamento ${j.id}: ${j.nome} pediu a defesa de ${j.defensor.nome}; veredito às ${horaBR(j.prazo)}.`);
      }
    }
    salvarJulg();
    if (!argumento && !avisoGrupo) return { texto: `Qual é o argumento? O veredito de ${j.nome} sai às ${horaBR(j.prazo)}.`, j };
    const lado = papel === 'quem pediu o ban' ? 'na acusação' : papel === 'outro membro' ? 'no julgamento' : 'na defesa';
    return { texto: argumento ? `Anotado ${lado}. Veredito às ${horaBR(j.prazo)}.` : '', avisoGrupo, j };
  }

  /** Prazo acabou: o Claude julga e o bot cumpre (remove ou não) e avisa o grupo numa frase. */
  const decidindo = new Set();
  async function darVeredito(j) {
    decidindo.add(j.id);
    try {
      const meta = await sock.groupMetadata(j.jid);
      const enviar = async (texto) => guardarEnviada(await sock.sendMessage(j.jid, { text: marcaServico('Julgamento', texto), mentions: mencoesDoTexto(texto, meta) }));
      const presente = (meta.participants || []).find((p) => [p.id, p.lid, p.phoneNumber].filter(Boolean).some((i) => [j.fone, ...j.ids].includes(digitos(jidNormalizedUser(i)))));
      if (!presente) {
        fecharJulgamento(j, 'encerrado', 'saiu do grupo antes do veredito');
        await enviar(`${j.nome} saiu antes do veredito; julgamento encerrado.`);
        return;
      }
      const conversa = mensagensEntre(j.jid, [], Math.floor(j.em / 1000) - 120, Math.floor(Date.now() / 1000)).slice(-80)
        .map((x) => `[${horaBR(x.em * 1000)}] ${x.nome}: ${x.citada ? `(respondendo ${x.citada.nome}: "${x.citada.texto.slice(0, 80)}") ` : ''}${x.texto.slice(0, 300)}`);
      const falas = j.falas.map((f) => `[${horaBR(f.em)}] ${f.por} (${f.papel}${f.onde === 'privado' ? ', no privado do bot' : ''}): ${f.texto}`);
      let v;
      try {
        v = await naFilaDoClaude(() => julgarBanimento({ grupo: meta.subject, julgado: j.nome, pedidoPor: j.pedidoPor, pedido: j.pedido, falas, conversa }));
      } catch (e) {
        // Sem veredito, ninguém sai: tenta de novo em 1 min (3 vezes) e, se não der, absolve.
        j.tentativas = (j.tentativas || 0) + 1;
        log(`Julgamento ${j.id}: o Claude não deu o veredito (${e.message}); tentativa ${j.tentativas}.`);
        if (j.tentativas < 3) { j.prazo = Date.now() + 60e3; salvarJulg(); return; }
        v = { banir: false, frase: `Absolvido: não consegui julgar, ${j.nome} fica.`, motivo: 'sem veredito do Claude' };
      }
      const frase = String(v.frase || '').trim().replace(/\s+/g, ' ');
      if (!v.banir) {
        fecharJulgamento(j, 'absolvido', v.motivo);
        await enviar(/^absolvid/i.test(frase) ? frase : `Absolvido: ${j.nome} fica.`);
        return;
      }
      // Condenado: o status muda antes de remover (a remoção não fecha este julgamento como "removido por outro").
      fecharJulgamento(j, 'condenado', v.motivo);
      let voltaId = null;
      if (j.volta && j.volta.minutos < BAN_MAX_MIN) {
        voltaId = agendar({
          jid: j.jid, quando: Date.now() + j.volta.minutos * 60e3, mensagem: j.volta.mensagem, pedidoPor: j.pedidoPor,
          descricao: descreverAcao(j.volta.admin, meta), admin: { ...j.volta.admin, historico_desde: Date.now() },
        });
      }
      try {
        const r = await executarAdmin({ acao: 'remover', pessoas: [digitos(jidNormalizedUser(presente.id))], texto: '', tempo: '', mandar_historico: false, historico_completo: false },
          { jid: j.jid, ctx: null, imagens: [], outrosMarcados: [], pedidoPor: `${j.pedidoPor} (condenado no julgamento)` });
        log(`Julgamento ${j.id}: ${j.nome} removido (${r.detalhe}).`);
        // O banimento lembra do julgamento: a defesa já ouvida conta como contestação negada (contestar de novo só com argumento novo).
        const ban = banAtivo(j.jid, j.fone);
        if (ban) {
          ban.julgamento = j.id;
          const defesa = j.falas.filter((f) => f.papel !== 'quem pediu o ban').map((f) => `${f.por}: ${f.texto}`).join(' / ');
          if (defesa) ban.contestacoes.push({ por: 'defesa no julgamento', motivo: defesa.slice(0, 500), aceita: false, em: Date.now() });
          salvarBans();
        }
        const volta = ban ? ` Volta às ${horaBR(voltaDoBan(ban))}.` : '';
        await enviar([`${/^condenad/i.test(frase) ? frase : `Condenado: ${j.nome} sai.`}${volta}`, r.resumoParcial].filter(Boolean).join('\n'));
      } catch (e) {
        if (voltaId) cancelarAgendada(voltaId);
        log(`Julgamento ${j.id}: condenado, mas não deu para remover ${j.nome} (${e.message}).`);
        await enviar(`Condenado, mas não consegui remover ${j.nome}: ${e.message}.`);
      }
    } finally {
      decidindo.delete(j.id);
    }
  }
  conferirJulgamentos = async () => {
    if (!conectado) return;
    for (const j of julgAbertos()) {
      if (Date.now() < j.prazo || decidindo.has(j.id)) continue;
      await darVeredito(j).catch((e) => log(`Julgamento ${j.id}: erro no veredito (${e.message}).`));
    }
  };

  // ---------- mensagens no PRIVADO do bot ----------
  // O bot só ouvia grupos (o messages.upsert pulava o que não era grupo), então quem mandava no privado
  // (ex: alguém banido querendo voltar) ficava sem resposta. Agora toda mensagem de gente no privado tem
  // resposta: o banido fica sabendo até quando está fora e pode contestar ali (mesmo julgamento e mesma volta
  // na hora da contestação do grupo, com aviso no grupo); quem não está banido conversa normal.
  const conversasPrivadas = new Map(); // chat -> [{ quem, texto, em }] (últimas 2 h, para o Claude ter o fio)
  const rodadaPrivado = new Map(); // chat -> nº da última mensagem (rajada: responde só a última)
  const respostasPrivado = new Map(); // chat -> horas das últimas respostas (trava contra loop com outro bot)
  const ehPrivado = (jid) => /@(s\.whatsapp\.net|lid)$/.test(jid || '');
  function lembrarPrivado(chat, quem, texto) {
    const l = (conversasPrivadas.get(chat) || []).filter((x) => Date.now() - x.em < 2 * 60 * 60e3);
    l.push({ quem, texto: String(texto).replace(/\s+/g, ' ').slice(0, 500), em: Date.now() });
    conversasPrivadas.set(chat, l.slice(-14));
  }
  async function enviarPrivado(destino, texto) {
    const msg = await sock.sendMessage(destino, { text: texto });
    if (msg?.key?.id) enviadas.set(msg.key.id, msg.message); // para reenviar se o aparelho pedir (retry)
    lembrarPrivado(destino, 'Bot', texto);
    return msg;
  }
  /** Banimento ativo de quem mandou no privado (pelo LID ou pelo número), o mais recente. */
  async function banDoPrivado(ids) {
    const todos = new Set();
    for (const i of ids) for (const x of await idsDaPessoa(i, null)) todos.add(digitos(x));
    return banimentos.filter((b) => b.ativo && Date.now() - b.em < 24 * 60 * 60e3 && (todos.has(b.fone) || b.ids.some((i) => todos.has(i)))).sort((a, b) => b.em - a.em)[0] || null;
  }
  const voltaDoBan = (b) => pendentes(b.jid).find((a) => a.id === b.agendaId)?.quando || b.volta;
  const nomeDoGrupo = async (jid) => (await metadadosGrupo(jid).catch(() => null))?.subject || 'grupo';
  function banParaPrompt(b) {
    const cont = b.contestacoes.length
      ? b.contestacoes.map((c) => `${c.por} contestou às ${horaBR(c.em)} ("${c.motivo.slice(0, 150)}"): ${c.aceita ? 'aceita' : 'NEGADA'}`).join('; ')
      : 'sem contestação';
    return `removido às ${horaBR(b.em)} a pedido de ${b.pedidoPor} | volta às ${horaBR(voltaDoBan(b))} | ${cont}`;
  }
  const avisoDeBan = (b, grupo) => `Você tá fora do *${grupo}* até as ${horaBR(voltaDoBan(b))} (no máximo ${BAN_MAX_MIN} min), aí volta sozinho. Achou injusto? Me manda aqui o motivo que eu avalio a contestação.`;
  /** Avisa no privado quem o bot acabou de remover (uma vez por banimento), para ninguém ficar sem saber. */
  async function avisarBanido(b) {
    if (!b.ativo || b.avisado) return;
    b.avisado = true;
    salvarBans();
    // Sem o número de telefone, o banimento guarda o LID (14+ dígitos): manda por ele.
    const destino = `${b.fone}@${b.fone.length >= 14 ? 'lid' : 's.whatsapp.net'}`;
    try {
      await enviarPrivado(destino, avisoDeBan(b, await nomeDoGrupo(b.jid)));
      log(`Banimento ${b.id}: avisei ${b.nome} no privado (volta e como contestar).`);
    } catch (e) {
      log(`Banimento ${b.id}: não deu para avisar ${b.nome} no privado (${e.message}).`);
    }
  }

  async function responderPrivado(m) {
    const chat = m.key.remoteJid;
    const texto = resumo(conteudo(m)).trim();
    if (!texto) return; // reação, aviso do sistema, enquete...
    jaRespondidas.add(m.key.id);
    const autor = m.pushName || nomeDaPessoa(chat, m.key.remoteJidAlt) || digitos(chat);
    lembrarPrivado(chat, autor, texto);
    // Rajada ("oi" / "por que me tirou" / "volta eu"): espera um pouco e responde tudo de uma vez.
    const rodada = (rodadaPrivado.get(chat) || 0) + 1;
    rodadaPrivado.set(chat, rodada);
    await new Promise((ok) => setTimeout(ok, 4000));
    if (rodadaPrivado.get(chat) !== rodada) return;
    const recentes = (respostasPrivado.get(chat) || []).filter((t) => Date.now() - t < 10 * 60e3);
    if (recentes.length >= 15) { log(`Privado de ${autor} ignorado: respostas demais em 10 min.`); return; }

    const ban = await banDoPrivado([chat, m.key.remoteJidAlt].filter(Boolean));
    const grupo = ban ? await nomeDoGrupo(ban.jid) : '';
    // Julgamentos abertos em que a pessoa pode falar: é o julgado, ou está no grupo do julgamento.
    const idsAutor = new Set();
    for (const i of [chat, m.key.remoteJidAlt].filter(Boolean)) for (const x of await idsDaPessoa(i, null)) idsAutor.add(digitos(x));
    const julgs = [];
    for (const j of julgAbertos()) {
      const papel = papelNoJulgamento(j, [...idsAutor]);
      const membro = papel !== 'outro membro' || ((await metadadosGrupo(j.jid).catch(() => null))?.participants || [])
        .some((p) => [p.id, p.lid, p.phoneNumber].filter(Boolean).some((i) => idsAutor.has(digitos(jidNormalizedUser(i)))));
      if (membro) julgs.push({ j, papel, grupo: await nomeDoGrupo(j.jid) });
    }
    const julgado = julgs.find((x) => x.papel === 'julgado');
    const julgamentosTxt = julgs.map(({ j, papel, grupo: g }) => `${j.id} | ${g} | ${j.nome} | ${j.pedidoPor} | veredito às ${horaBR(j.prazo)} | ${papel}`).join('\n');
    const conversa = (conversasPrivadas.get(chat) || []).slice(0, -1).map((x) => `[${horaBR(x.em)}] ${x.quem}: ${x.texto}`);
    log(`Privado de ${autor}${ban ? ` (banido: ${ban.id}, volta às ${horaBR(voltaDoBan(ban))})` : ''}${julgado ? ` (em julgamento: ${julgado.j.id})` : ''}: "${texto.slice(0, 80)}"`);
    await sock.sendPresenceUpdate('composing', chat).catch(() => {});
    let v;
    try {
      if (!ia) throw new Error('claude CLI não encontrado');
      v = await naFilaDoClaude(() => responderNoPrivado({ autor: ban?.nome || julgado?.j.nome || autor, mensagem: texto, conversa, banimento: ban ? banParaPrompt(ban) : '', grupo, julgamentos: julgamentosTxt }));
    } catch (e) {
      log(`Privado de ${autor}: o Claude não respondeu (${e.message}).`);
      // O julgado não perde a defesa por falha do Claude: a mensagem vai inteira como argumento.
      v = julgado
        ? { responder: true, texto: '', contestacao: { fazer: false }, defesa: { fazer: true, julgamento_id: julgado.j.id, argumento: texto, defensor: '' } }
        : { responder: true, texto: ban ? avisoDeBan(ban, grupo) : 'Deu ruim aqui pra responder agora, tenta de novo daqui a pouco.', contestacao: { fazer: false } };
    }
    if (!ban && !julgado && v.responder === false) { log(`Privado de ${autor}: não respondi (spam/automática).`); return; }
    let resposta = String(v.texto || '').trim() || (ban ? avisoDeBan(ban, grupo) : '');

    // Defesa (ou acusação) num julgamento aberto, mandada no privado: anota e, se pediu defensor, chama no grupo.
    if (v.defesa?.fazer && julgs.length) {
      try {
        const r = await falarNoJulgamento(v.defesa, { idsAutor: [...idsAutor], autor: julgado?.j.nome || autor, onde: 'privado' });
        if (r.texto) resposta = r.texto;
        if (r.avisoGrupo) {
          guardarEnviada(await sock.sendMessage(r.j.jid, { text: marcaServico('Julgamento', r.avisoGrupo), mentions: mencoesDoTexto(r.avisoGrupo, await metadadosGrupo(r.j.jid).catch(() => null)) }));
          resposta = [resposta, `Chamei ${r.j.defensor.nome} no grupo pra te defender (até as ${horaBR(r.j.prazo)}).`].filter(Boolean).join('\n');
        }
      } catch (e) {
        log(`Julgamento: fala de ${autor} no privado não deu (${e.message}).`);
      }
    }

    // Contestação pelo próprio banido: mesmo julgamento do grupo; se aceitar, volta na hora e o grupo fica sabendo.
    if (ban && v.contestacao?.fazer) {
      const motivo = String(v.contestacao.motivo || '').trim();
      try {
        const r = await contestarBanimento({ ...v.contestacao, banimento_id: ban.id }, { jid: ban.jid, m, autor: ban.nome, texto: v.texto, doBanido: ban });
        resposta = r.texto || resposta;
        if (r.julgada) {
          const noGrupo = r.aceita
            ? `${ban.nome} contestou no privado ("${motivo.slice(0, 200)}"): aceita, de volta.`
            : `${ban.nome} contestou no privado ("${motivo.slice(0, 200)}"): negada, volta às ${horaBR(voltaDoBan(ban))}.`;
          guardarEnviada(await sock.sendMessage(ban.jid, { text: marcaServico('Contestação', noGrupo) }));
        }
      } catch (e) {
        log(`Contestação de ${ban.nome} no privado não deu (${e.message}).`);
        resposta = `Não consegui avaliar a contestação agora (${e.message}). Tenta de novo daqui a pouco.`;
      }
    }
    if (!resposta) return;
    await enviarPrivado(chat, resposta);
    respostasPrivado.set(chat, [...recentes, Date.now()]);
    log(`Respondi no privado ${autor}: "${resposta.slice(0, 80)}"`);
  }

  async function mandarHistorico(jid, destino, desde, meta, ate = 0, saiuEm = 0) {
    // As mensagens guardadas têm a hora em SEGUNDOS (messageTimestamp); saídas e pedidos, em ms.
    const saiu = saiuEm || saidas[`${jid}|${digitos(destino)}`];
    const voltou = saidas[`${jid}|${digitos(destino)}|volta`];
    // Já voltou depois da última saída (pediram o histórico depois): vai só até a volta.
    if (!ate && saiu && voltou > saiu) ate = voltou;
    const inicio = Math.floor((saiu || desde || 0) / 1000);
    const fim = ate ? Math.floor(ate / 1000) : Infinity;
    const ultimas = mensagensEntre(jid, [digitos(destino)], inicio, fim).slice(-300);
    const desdeTxt = inicio ? dataHora(inicio) : '';
    const pdf = await gerarPdfConversa({
      titulo: meta?.subject || 'Grupo',
      subtitulo: `O que rolou enquanto você estava fora${desdeTxt ? ` (desde ${desdeTxt})` : ''}: ${ultimas.length} mensagem(ns)`,
      mensagens: ultimas,
    }, { navegador: local.navegador });
    await sock.sendMessage(destino, {
      document: pdf, mimetype: 'application/pdf', fileName: nomeDoArquivo(meta, 'o que você perdeu'),
      caption: `📜 O que rolou no grupo *${meta?.subject || ''}* enquanto você estava fora${desdeTxt ? ` (desde ${desdeTxt})` : ''}: ${ultimas.length ? `${ultimas.length} mensagem(ns)` : 'ninguém mandou nada'}.`,
    });
    return ultimas.length;
  }

  // ---------- histórico automático na volta ----------
  // Grupos com o "histórico na volta" ligado ({ grupo: { completo, desde } }): quem tinha saído ou sido
  // removido e volta (adicionado ou pelo link) recebe no privado o que rolou enquanto estava fora.
  const ARQ_NA_VOLTA = path.join(DIR, '.historico-na-volta.json');
  let historicoNaVolta = {};
  try { historicoNaVolta = JSON.parse(fs.readFileSync(ARQ_NA_VOLTA, 'utf8')); } catch { /* nenhum */ }
  const salvarNaVolta = () => { try { fs.writeFileSync(ARQ_NA_VOLTA, JSON.stringify(historicoNaVolta)); } catch { /* tenta na próxima */ } };
  // Quem já vai receber (ou já recebeu) o histórico desta volta ("grupo|número" → { em, por }), para o
  // envio automático e o "adicionar com mandar_historico" não mandarem o mesmo PDF duas vezes.
  const historicoDaVolta = new Map();
  const marcarHistoricoDaVolta = (jid, ids, por) => {
    for (const i of ids.filter(Boolean)) historicoDaVolta.set(`${jid}|${digitos(jidNormalizedUser(i))}`, { em: Date.now(), por });
  };
  const historicoDaVoltaJa = (jid, ids, depoisDe, por = null) => ids.filter(Boolean).some((i) => {
    const r = historicoDaVolta.get(`${jid}|${digitos(jidNormalizedUser(i))}`);
    return r && r.em > depoisDe && (!por || r.por === por);
  });
  /** A pessoa voltou ao grupo: manda o histórico do último período fora (ou de todos), se ela tinha saído. */
  async function mandarHistoricoNaVolta(jid, idsDoAviso) {
    const config = historicoNaVolta[jid];
    if (!config) return;
    const meta = await metadadosGrupo(jid).catch(() => null);
    const ids = [...new Set((await Promise.all(idsDoAviso.map((i) => idsDaPessoa(i, meta)))).flat())];
    const telefone = ids.find((i) => i.endsWith('@s.whatsapp.net'));
    const nome = nomeDaPessoa(...ids) || `+${digitos(jidNormalizedUser(telefone || ids[0]))}`;
    const lista = periodosFora(jid, ids);
    const ultimo = lista[lista.length - 1];
    // Nunca saiu (primeira vez no grupo), ou esta volta não fecha nenhuma saída registrada: nada a mandar.
    if (!ultimo?.voltou || Date.now() - ultimo.voltou > 10 * 60e3) {
      log(`Histórico na volta: ${nome} entrou, mas não tenho saída registrada antes desta volta; não mando nada.`);
      return;
    }
    // O próprio bot adicionou com mandar_historico (agora ou agendado): ele já manda, não duplica.
    if (historicoDaVoltaJa(jid, ids, ultimo.saiu)) {
      log(`Histórico na volta: ${nome} já recebe o histórico pelo "adicionar"; não duplico.`);
      return;
    }
    marcarHistoricoDaVolta(jid, ids, 'auto');
    const destino = jidNormalizedUser(telefone || ids[0]);
    let texto;
    if (config.completo) {
      const r = await mandarHistoricoCompleto(jid, destino, ids, meta);
      log(`Histórico na volta: mandei o histórico completo para ${destino}: ${r.mensagens} mensagem(ns) de ${r.periodos} período(s) fora.`);
      texto = `${nome} voltou. Histórico mandado no privado: ${r.mensagens} mensagens, ${r.periodos} períodos.`;
    } else {
      const n = await mandarHistorico(jid, destino, 0, meta, ultimo.voltou, ultimo.saiu);
      log(`Histórico na volta: mandei ${n} mensagem(ns) do histórico para ${destino}.`);
      texto = `${nome} voltou. Histórico mandado no privado: ${n} mensagens.`;
    }
    guardarEnviada(await sock.sendMessage(jid, { text: marcaServico('Histórico', texto) }));
  }

  /**
   * Histórico de TODAS as vezes que a pessoa ficou fora (cada saída/remoção até a volta), num PDF só, em
   * ordem, com um cabeçalho por período. `recado` vai junto no privado. Devolve { mensagens, periodos, vazios }.
   */
  async function mandarHistoricoCompleto(jid, destino, ids, meta, recado = '') {
    const lista = periodosFora(jid, ids);
    if (!lista.length) throw new Error(`não tenho registro de nenhuma saída de ${nomeDaPessoa(destino) || 'a pessoa'}`);
    const meus = ids.map((i) => digitos(jidNormalizedUser(i)));
    const itens = [];
    let total = 0;
    let vazios = 0;
    lista.forEach((p, i) => {
      const msgs = mensagensEntre(jid, meus, Math.floor(p.saiu / 1000), Math.ceil(p.ate / 1000));
      total += msgs.length;
      if (!msgs.length) vazios++;
      const volta = p.voltou ? `voltou ${dataHora(p.voltou / 1000)}` : p.ate < Date.now() - 5000 ? 'volta não registrada' : 'ainda fora';
      itens.push({ separador: `${i + 1}ª vez fora: saiu ${dataHora(p.saiu / 1000)}, ${volta} (${msgs.length ? `${msgs.length} mensagem(ns)` : 'nada registrado nesse período'})` });
      itens.push(...msgs.slice(-500));
    });
    const pdf = await gerarPdfConversa({
      titulo: meta?.subject || 'Grupo',
      subtitulo: `Tudo o que rolou nas ${lista.length} vez(es) que você ficou fora: ${total} mensagem(ns)`,
      mensagens: itens,
    }, { navegador: local.navegador });
    const quando = lista.map((p) => `${dataHora(p.saiu / 1000)} → ${p.voltou ? dataHora(p.voltou / 1000) : '?'}`).join(', ');
    await sock.sendMessage(destino, {
      document: pdf, mimetype: 'application/pdf', fileName: nomeDoArquivo(meta, 'tudo o que você perdeu'),
      caption: [String(recado || '').trim(), `📜 Tudo o que rolou no grupo *${meta?.subject || ''}* nas ${lista.length} vez(es) que você ficou fora (${quando}): ${total ? `${total} mensagem(ns)` : 'ninguém mandou nada'}.${vazios && total ? ` Em ${vazios} delas não tem nada registrado.` : ''}`].filter(Boolean).join('\n\n'),
    });
    return { mensagens: total, periodos: lista.length, vazios };
  }

  /** Mensagens do grupo entre `inicio` e `fim` (em segundos), no formato do PDF; `meus` = números de quem recebe. */
  function mensagensEntre(jid, meus, inicio, fim) {
    const eDestino = (...ids) => ids.filter(Boolean).some((i) => meus.includes(digitos(jidNormalizedUser(i))));
    const nomeDe = (key, nome) => (key?.fromMe ? 'Bot' : nome || nomeDaPessoa(key?.participant, key?.participantAlt) || 'alguém');
    const itens = [];
    for (const g of mensagensGuardadas.values()) {
      if (g.key.remoteJid !== jid || (g.em || 0) < inicio || (g.em || 0) > fim) continue;
      const c = conteudo(g);
      const texto = arrobasComNomes(semRotulo(resumo(c) || '').trim());
      if (!texto) continue;
      const ctx = contextoDa(c);
      const citadaG = ctx?.stanzaId ? mensagensGuardadas.get(ctx.stanzaId) : null;
      const textoCitado = ctx?.quotedMessage ? arrobasComNomes(semRotulo(resumo(ctx.quotedMessage) || '')) : '';
      const midia = c.imageMessage || c.videoMessage || c.stickerMessage;
      itens.push({
        em: g.em || 0,
        data: new Date((g.em || 0) * 1000),
        nome: nomeDe(g.key, g.nome),
        texto,
        // Quem recebe vê as próprias mensagens à direita, em verde, como no WhatsApp.
        minha: !g.key.fromMe && eDestino(g.key.participant, g.key.participantAlt),
        citada: textoCitado ? { nome: citadaG ? nomeDe(citadaG.key, citadaG.nome) : nomeDaPessoa(ctx.participant) || 'alguém', texto: textoCitado } : null,
        miniatura: midia?.jpegThumbnail || midia?.pngThumbnail || null,
      });
    }
    return itens.sort((a, b) => a.em - b.em);
  }
  const nomeDoArquivo = (meta, fim) => `${(meta?.subject || 'Grupo').replace(/[\\/:*?"<>|]+/g, ' ').trim()} - ${fim}.pdf`;

  const DURACAO = { desligar: 0, '24h': 86400, '7d': 7 * 86400, '90d': 90 * 86400 };

  /**
   * Apaga para todos os anexos que o BOT mandou repetidos no grupo nas últimas 6 h (mesmo arquivo, ou mesmo
   * link, até 15 min depois da primeira cópia): fica só a primeira. Áudio de voz (o do Gabreu) e figurinha
   * não contam, porque as regras mandam esses de novo de propósito.
   */
  async function apagarRepetidosDoBot(jid) {
    const desde = Math.floor(Date.now() / 1000) - 6 * 3600;
    const minhas = [...mensagensGuardadas.values()]
      .filter((g) => g.key.fromMe && g.key.remoteJid === jid && (g.em || 0) >= desde && shaDaMensagem(conteudo(g)))
      .sort((x, y) => (x.em || 0) - (y.em || 0));
    const primeiras = []; // { sha, chave, em }
    const repetidas = [];
    for (const g of minhas) {
      const sha = shaDaMensagem(conteudo(g));
      const igual = primeiras.find((p) => (p.sha === sha || (g.chave && p.chave === g.chave)) && (g.em || 0) - p.em <= 15 * 60);
      if (igual) repetidas.push(g);
      else primeiras.push({ sha, chave: g.chave, em: g.em || 0 });
    }
    if (!repetidas.length) throw new Error('não achei anexo repetido meu nas últimas horas');
    for (const g of repetidas) {
      await sock.sendMessage(jid, { delete: { remoteJid: jid, id: g.key.id, fromMe: true } });
      mensagensGuardadas.delete(g.key.id);
    }
    log(`Apaguei ${repetidas.length} anexo(s) repetido(s) do bot: ${repetidas.map((g) => g.key.id).join(', ')}.`);
    return { detalhe: `${repetidas.length} repetido(s) apagado(s)` };
  }
  /**
   * Executa a função de admin que o Claude pediu. Devolve { ok, detalhe }; lança erro com a explicação
   * se não deu (o bot não é admin, pessoa não achada...).
   */
  async function executarAdmin(a, { jid, ctx, imagens, outrosMarcados, pedidoPor = '' }) {
    if (a.acao === 'apagar_repetidos_do_bot') return apagarRepetidosDoBot(jid); // as do bot: não precisa ser admin
    // Histórico automático para quem volta: só manda PDF no privado, não precisa ser admin.
    if (a.acao === 'historico_na_volta_ligar') {
      historicoNaVolta[jid] = { completo: !!a.historico_completo, desde: Date.now() };
      salvarNaVolta();
      return {
        detalhe: `histórico na volta ligado${a.historico_completo ? ' (completo)' : ''}`,
        extra: `Ligado: quem sair ou for removido e voltar pro grupo recebe no privado ${a.historico_completo ? 'o histórico de todas as vezes que ficou fora' : 'o que rolou enquanto esteve fora (último período)'}. Quem entra pela primeira vez não recebe nada.`,
      };
    }
    if (a.acao === 'historico_na_volta_desligar') {
      delete historicoNaVolta[jid];
      salvarNaVolta();
      return { detalhe: 'histórico na volta desligado', extra: 'Desligado: quem voltar pro grupo não recebe mais o histórico sozinho.' };
    }
    const meta = await sock.groupMetadata(jid); // na hora: quem é admin e quem está no grupo agora
    const eu = (meta.participants || []).find((p) => [p.id, p.lid, p.phoneNumber].filter(Boolean).some((i) => meusIds().includes(jidNormalizedUser(i))));
    if (!eu?.admin) throw new Error('não sou admin do grupo');
    const participante = (n) => (meta.participants || []).find((x) =>
      [x.id, x.lid, x.phoneNumber, x.jid].filter(Boolean).some((j) => digitos(jidNormalizedUser(j)) === n));
    const comPessoas = ['remover', 'adicionar', 'promover_admin', 'tirar_admin'].includes(a.acao);
    let alvos = [];
    if (comPessoas) {
      const numeros = [...new Set((a.pessoas || []).map(digitos).filter((n) => n.length >= 8))];
      for (const n of numeros) {
        const p = participante(n);
        if (p && a.acao !== 'adicionar') { alvos.push(p.id); continue; }
        if (p) { alvos.push(p.phoneNumber || p.id); continue; }
        if (a.acao !== 'adicionar') continue;
        // Quem saiu do grupo só é conhecido pelo LID (o id que aparece no "@"): para adicionar
        // precisa do número de telefone, que o WhatsApp guarda no mapa LID → número.
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(`${n}@lid`).catch(() => null);
        alvos.push(pn ? jidNormalizedUser(pn) : `${n}@s.whatsapp.net`);
      }
      // Sem número: quem foi marcado na mensagem, ou o autor da mensagem respondida.
      if (!alvos.length && a.acao !== 'adicionar') alvos = outrosMarcados.length ? [...outrosMarcados] : ctx?.participant ? [ctx.participant] : [];
      alvos = alvos.filter((j) => !meusIds().includes(jidNormalizedUser(j)));
      if (!alvos.length) throw new Error('não achei quem é a pessoa no grupo');
      if (a.acao === 'adicionar' && a.mandar_historico) marcarHistoricoDaVolta(jid, alvos, 'adicionar');
      const r = await sock.groupParticipantsUpdate(jid, alvos, { remover: 'remove', adicionar: 'add', promover_admin: 'promote', tirar_admin: 'demote' }[a.acao]);
      groupCache.del(jid);
      let falhas = (r || []).filter((x) => String(x.status) !== '200');
      // O WhatsApp responde com o LID da pessoa e o alvo pode ser o número (ou o contrário): compara
      // os dois lados pelo número de telefone.
      const paraNumero = async (j) => {
        const n = jidNormalizedUser(j || '');
        if (!n.endsWith('@lid')) return digitos(n);
        const p = participante(digitos(n));
        if (p?.phoneNumber) return digitos(jidNormalizedUser(p.phoneNumber));
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(n).catch(() => null);
        return digitos(pn ? jidNormalizedUser(pn) : n);
      };
      const numAlvo = new Map();
      for (const j of alvos) numAlvo.set(j, await paraNumero(j));
      for (const x of falhas) x.numero = await paraNumero(x.jid);
      const mesmo = (x, j) => x.numero === numAlvo.get(j) || digitos(x.jid) === digitos(j);
      const deram = alvos.filter((j) => !falhas.some((x) => mesmo(x, j)));
      // Para dizer o nome de quem não deu: o alvo correspondente (é o id que se conhece).
      for (const x of falhas) x.alvo = alvos.find((j) => mesmo(x, j)) || x.jid;
      // Removido pelo bot = banimento (com a volta garantida em até 30 min); voltou = o banimento acaba.
      const avisos = [];
      if (a.acao === 'remover') {
        for (const j of deram) {
          const p = participante(digitos(jidNormalizedUser(j)));
          marcarSaida(jid, [j, p?.lid, p?.phoneNumber, p?.id]);
          try { avisos.push(await registrarBanimento(jid, j, p, meta, pedidoPor)); } catch (e) { log(`Banimento: não deu para registrar ${j} (${e.message}).`); }
        }
      }
      if (a.acao === 'adicionar') for (const j of deram) marcarVolta(jid, [j]);
      if (a.acao === 'adicionar') {
        const voltaram = [...deram, ...falhas.filter((x) => String(x.status) === '409').map((x) => x.alvo)];
        if (voltaram.length) encerrarBanimento(jid, voltaram.flatMap((j) => [digitos(j), numAlvo.get(j)]), 'voltou', true);
      }
      if (a.acao === 'adicionar' && a.mandar_historico) {
        // Quem "já está no grupo" (voltou pelo link antes da hora) também recebe o histórico pedido.
        const jaDentro = falhas.filter((x) => String(x.status) === '409').map((x) => x.alvo);
        for (const j of [...deram, ...jaDentro]) {
          try {
            const ids = await idsDaPessoa(j, meta);
            // Voltou pelo link antes da hora e o envio automático já mandou o histórico: não duplica.
            const ultimo = periodosFora(jid, ids).pop();
            if (jaDentro.includes(j) && ultimo && historicoDaVoltaJa(jid, ids, ultimo.saiu, 'auto')) {
              log(`Admin: ${j} já recebeu o histórico quando voltou; não mando de novo.`);
              continue;
            }
            marcarHistoricoDaVolta(jid, ids, 'adicionar');
            if (a.historico_completo) {
              const r = await mandarHistoricoCompleto(jid, jidNormalizedUser(j), ids, meta, a.texto);
              log(`Admin: mandei o histórico completo para ${j}: ${r.mensagens} mensagem(ns) de ${r.periodos} período(s) fora.`);
            } else log(`Admin: mandei ${await mandarHistorico(jid, jidNormalizedUser(j), a.historico_desde, meta)} mensagem(ns) do histórico para ${j}.`);
          } catch (e) { log(`Admin: não deu para mandar o histórico para ${j} (${e.message}).`); }
        }
      }
      // Privacidade da pessoa não deixa adicionar direto (403): manda o link do grupo no privado dela.
      if (a.acao === 'adicionar') {
        const bloqueados = falhas.filter((x) => String(x.status) === '403');
        if (bloqueados.length) {
          const link = `https://chat.whatsapp.com/${await sock.groupInviteCode(jid)}`;
          for (const x of bloqueados) {
            const destino = x.alvo;
            try {
              await sock.sendMessage(destino, { text: `Te chamaram de volta pro grupo *${meta.subject}*. Entra por aqui: ${link}` });
              log(`Admin: não deu para adicionar ${destino} direto (privacidade); mandei o link no privado.`);
            } catch (e) { log(`Admin: não deu nem para mandar o link para ${destino} (${e.message}).`); }
          }
          falhas = falhas.filter((x) => String(x.status) !== '403');
          if (!falhas.length) return { detalhe: `convite mandado no privado (${bloqueados.length})`, parcial: 'A privacidade não deixa adicionar direto, então mandei o link do grupo no privado.' };
        }
      }
      const motivo = (status) => {
        const st = String(status);
        return st === '403' && a.acao === 'adicionar' ? 'a privacidade da pessoa não deixa adicionar direto (manda o link do grupo pra ela)'
          : st === '409' && a.acao === 'adicionar' ? 'já está no grupo'
          : st === '409' || st === '404' ? 'não está no grupo'
          : st === '406' || st === '401' ? 'o WhatsApp não deixa (dono do grupo não pode ser removido nem rebaixado)'
          : `o WhatsApp recusou (código ${st})`;
      };
      const nomeDoAlvo = (j) => nomeDaPessoa(j, `${digitos(j)}@lid`, `${digitos(j)}@s.whatsapp.net`) || `+${digitos(j)}`;
      if (falhas.length === alvos.length) {
        throw new Error(alvos.length === 1 ? motivo(falhas[0]?.status) : falhas.map((x) => `${nomeDoAlvo(x.alvo)} ${motivo(x.status)}`).join('; '));
      }
      // Deu para uns e não para outros: o bot diz exatamente quem (o texto do Claude supunha que deu para todos).
      const verbo = { remover: 'Removido(s)', adicionar: 'Adicionado(s)', promover_admin: 'Agora admin', tirar_admin: 'Sem admin' }[a.acao];
      const resumoParcial = falhas.length
        ? `${verbo}: ${deram.map(nomeDoAlvo).join(', ')}.\nNão deu: ${falhas.map((x) => `${nomeDoAlvo(x.alvo)} (${motivo(x.status)})`).join(', ')}.`
        : '';
      return { detalhe: `${a.acao} ${alvos.length - falhas.length}/${alvos.length}`, resumoParcial, aviso: avisos.filter(Boolean).join('\n') };
    }
    if (a.acao === 'mandar_historico') {
      // Só manda o histórico no privado (a pessoa já está no grupo): da última saída até a volta.
      const numeros = [...new Set((a.pessoas || []).map(digitos).filter((n) => n.length >= 8))];
      let destinos = numeros.map((n) => { const p = participante(n); return p ? p.phoneNumber || p.id : `${n}@lid`; });
      if (!destinos.length) destinos = outrosMarcados.length ? [...outrosMarcados] : ctx?.participant ? [ctx.participant] : [];
      destinos = destinos.map(jidNormalizedUser).filter((j) => !meusIds().includes(j));
      if (!destinos.length) throw new Error('não achei para quem mandar o histórico');
      const feitos = [];
      // "Todo o histórico, de todas as vezes que ele tava fora": um PDF com cada período (saída → volta).
      if (a.historico_completo) {
        for (const d of destinos) {
          const ids = await idsDaPessoa(d, meta);
          const destino = jidNormalizedUser(ids.find((i) => i.endsWith('@s.whatsapp.net')) || d);
          const r = await mandarHistoricoCompleto(jid, destino, ids, meta, a.texto);
          log(`Admin: mandei o histórico completo para ${destino}: ${r.mensagens} mensagem(ns) de ${r.periodos} período(s) fora.`);
          feitos.push(`${nomeDaPessoa(d) || `+${digitos(d)}`} (${r.mensagens} mensagens, ${r.periodos} períodos)`);
        }
        return { detalhe: `histórico completo: ${feitos.join(', ')}`, extra: `Histórico mandado no privado: ${feitos.join(', ')}.` };
      }
      for (const d of destinos) {
        const p = participante(digitos(d));
        const ids = [d, p?.id, p?.lid, p?.phoneNumber].filter(Boolean).map(jidNormalizedUser);
        // A saída pode ter sido marcada pelo LID ou pelo número: usa a que existir.
        const chave = ids.find((i) => saidas[`${jid}|${digitos(i)}`]) || d;
        if (!saidas[`${jid}|${digitos(chave)}`]) throw new Error(`não tenho registro de quando ${nomeDaPessoa(d) || 'a pessoa'} saiu`);
        const n = await mandarHistorico(jid, chave, 0, meta);
        log(`Admin: mandei ${n} mensagem(ns) do histórico para ${chave}.`);
        feitos.push(`${nomeDaPessoa(d) || `+${digitos(d)}`} (${n} mensagens)`);
      }
      return { detalhe: `histórico: ${feitos.join(', ')}`, extra: `Histórico mandado no privado: ${feitos.join(', ')}.` };
    }
    switch (a.acao) {
      case 'mudar_nome':
        if (!a.texto?.trim()) throw new Error('faltou o nome novo');
        await sock.groupUpdateSubject(jid, a.texto.trim().slice(0, 100)); break;
      case 'mudar_descricao': await sock.groupUpdateDescription(jid, a.texto?.trim() || undefined); break;
      case 'mudar_foto':
        if (!imagens.length) throw new Error('manda (ou responde) a imagem junto');
        await sock.updateProfilePicture(jid, imagens[0]); break;
      case 'so_admins_mandam': await sock.groupSettingUpdate(jid, 'announcement'); break;
      case 'todos_mandam': await sock.groupSettingUpdate(jid, 'not_announcement'); break;
      case 'so_admins_editam_dados': await sock.groupSettingUpdate(jid, 'locked'); break;
      case 'todos_editam_dados': await sock.groupSettingUpdate(jid, 'unlocked'); break;
      case 'so_admins_adicionam': await sock.groupMemberAddMode(jid, 'admin_add'); break;
      case 'todos_adicionam': await sock.groupMemberAddMode(jid, 'all_member_add'); break;
      case 'aprovar_entrada_ligar': await sock.groupJoinApprovalMode(jid, 'on'); break;
      case 'aprovar_entrada_desligar': await sock.groupJoinApprovalMode(jid, 'off'); break;
      case 'link_convite': return { detalhe: 'link', extra: `https://chat.whatsapp.com/${await sock.groupInviteCode(jid)}` };
      case 'trocar_link': return { detalhe: 'link trocado', extra: `Link novo: https://chat.whatsapp.com/${await sock.groupRevokeInvite(jid)}` };
      case 'apagar_mensagem': {
        if (!ctx?.stanzaId) throw new Error('responde a mensagem que é para apagar');
        const minha = !!(ctx.participant && meusIds().includes(jidNormalizedUser(ctx.participant)));
        await sock.sendMessage(jid, { delete: { remoteJid: jid, id: ctx.stanzaId, fromMe: minha, ...(minha ? {} : { participant: ctx.participant }) } });
        break;
      }
      case 'mensagens_temporarias': {
        if (!(a.tempo in DURACAO)) throw new Error('faltou dizer o tempo (24h, 7 dias ou 90 dias)');
        await sock.groupToggleEphemeral(jid, DURACAO[a.tempo]); break;
      }
      default: throw new Error(`não conheço a função "${a.acao}"`);
    }
    groupCache.del(jid);
    return { detalhe: a.acao };
  }

  // ---------- enquetes (com ação opcional quando aprovadas) ----------
  /** O que a ação faz, em português, para avisar no grupo ("removo Nicolas"). */
  function descreverAcao(a, meta) {
    const nomes = (a.pessoas || []).map((n) => {
      const p = (meta?.participants || []).find((x) => [x.id, x.lid, x.phoneNumber].filter(Boolean).some((j) => digitos(jidNormalizedUser(j)) === digitos(n)));
      return (p && nomeDaPessoa(p.id, p.lid, p.phoneNumber)) || nomeDaPessoa(`${digitos(n)}@lid`, `${digitos(n)}@s.whatsapp.net`) || `+${digitos(n)}`;
    }).join(', ');
    return {
      remover: `removo ${nomes}`, adicionar: `adiciono ${nomes}`, promover_admin: `coloco ${nomes} de admin`, tirar_admin: `tiro o admin de ${nomes}`,
      mudar_nome: `mudo o nome do grupo para "${a.texto}"`, mudar_descricao: 'mudo a descrição do grupo',
      so_admins_mandam: 'fecho o grupo (só admin manda mensagem)', todos_mandam: 'abro o grupo (todo mundo manda mensagem)',
      so_admins_editam_dados: 'deixo só admin editar os dados do grupo', todos_editam_dados: 'deixo todo mundo editar os dados do grupo',
      so_admins_adicionam: 'deixo só admin adicionar gente', todos_adicionam: 'deixo todo mundo adicionar gente',
      aprovar_entrada_ligar: 'ligo a aprovação para entrar', aprovar_entrada_desligar: 'desligo a aprovação para entrar',
      trocar_link: 'troco o link do grupo', apagar_repetidos_do_bot: 'apago os anexos que mandei repetidos', mandar_historico: `mando o histórico${a.historico_completo ? ' de todas as vezes que ficou fora' : ''} no privado de ${nomes}`,
      historico_na_volta_ligar: 'passo a mandar o histórico no privado de quem voltar pro grupo', historico_na_volta_desligar: 'paro de mandar o histórico sozinho para quem voltar',
      mensagens_temporarias: `ponho mensagens temporárias (${a.tempo})`,
    }[a.acao] || `faço "${a.acao}"`;
  }

  /** Manda a enquete no grupo e registra. Devolve o texto que explica a regra (ou ''). */
  async function criarEnquete(e, jid, autor) {
    const opcoes = [...new Set((e.opcoes || []).map((o) => String(o).trim().slice(0, 100)).filter(Boolean))].slice(0, 12);
    if (opcoes.length < 2) throw new Error('enquete precisa de pelo menos 2 opções');
    const acao = e.acao?.acao && e.acao.acao !== 'nenhuma' ? e.acao : null;
    const meta = await sock.groupMetadata(jid);
    const membros = (meta.participants || []).filter((p) => ![p.id, p.lid, p.phoneNumber].filter(Boolean).some((i) => meusIds().includes(jidNormalizedUser(i)))).length;
    if (acao) {
      const eu = (meta.participants || []).find((p) => [p.id, p.lid, p.phoneNumber].filter(Boolean).some((i) => meusIds().includes(jidNormalizedUser(i))));
      if (!eu?.admin) throw new Error('não sou admin do grupo, então não conseguiria cumprir o resultado');
    }
    const opcaoAprova = acao ? (opcoes.find((o) => normalizar(o) === normalizar(e.opcao_aprova)) || opcoes[0]) : '';
    // Enquete com ação: sempre aprova quando metade + 1 dos membros votar a favor; senão expira em 6 h.
    const regra = acao ? 'maioria_do_grupo' : 'maioria_dos_votos';
    const limite = Math.floor(membros / 2) + 1;
    const horas = acao ? 6 : Math.min(24 * 7, Math.max(0.05, Number(e.horas) || 24));
    const segredo = novoSegredo();
    const enviada = guardarEnviada(await sock.sendMessage(jid, { poll: { name: String(e.pergunta || 'Enquete').slice(0, 255), values: opcoes, selectableCount: e.varias_escolhas ? 0 : 1, messageSecret: segredo } }));
    registrarEnquete({
      id: enviada.key.id, jid, pergunta: e.pergunta, opcoes, segredo, criadores: meusIds(),
      acao, opcaoAprova, regra, limite, membros, expiraEm: Date.now() + horas * 3600e3, pedidoPor: autor,
    });
    const prazo = horas >= 1 ? `${Math.round(horas)} h` : `${Math.round(horas * 60)} min`;
    log(`Enquete criada por ${autor}: "${e.pergunta}" [${opcoes.join(' | ')}]${acao ? ` → ${acao.acao} se aprovar (${regra}, ${limite}/${membros})` : ''}, prazo ${prazo}.`);
    if (!acao) return `Fica aberta por ${prazo}.`;
    return regra === 'maioria_do_grupo'
      ? `Se ${limite} dos ${membros} membros votarem "${opcaoAprova}", eu ${descreverAcao(acao, meta)}. Prazo: ${prazo}.`
      : `Em ${prazo}, se "${opcaoAprova}" for a mais votada, eu ${descreverAcao(acao, meta)}.`;
  }

  /** Confere uma enquete: executa a ação se aprovou, ou encerra no fim do prazo. */
  async function avaliarEnquete(e, fimDoPrazo = false) {
    if (!e || e.encerrada) return;
    const { c, pessoas } = contagem(e);
    const citada = { key: { remoteJid: e.jid, id: e.id, fromMe: true }, message: { pollCreationMessage: { name: e.pergunta } } };
    const placar = e.opcoes.map((o) => `${o}: ${c[o] || 0}`).join(' | ');
    const enviar = async (texto) => guardarEnviada(await sock.sendMessage(e.jid, { text: marcaServico('Enquete', texto) }, { quoted: citada }));
    if (!e.acao) {
      if (!fimDoPrazo) return;
      const max = Math.max(...e.opcoes.map((o) => c[o] || 0));
      const vencedoras = e.opcoes.filter((o) => (c[o] || 0) === max);
      encerrar(e.id, placar);
      await enviar(pessoas ? `Enquete encerrada (${pessoas} votaram). ${vencedoras.length > 1 ? `Empate: ${vencedoras.join(' e ')}` : `Ganhou: ${vencedoras[0]}`}.\n${placar}` : 'Enquete encerrada sem nenhum voto.');
      return;
    }
    const aFavor = c[e.opcaoAprova] || 0;
    const outras = Math.max(0, ...e.opcoes.filter((o) => o !== e.opcaoAprova).map((o) => c[o] || 0));
    // Com ação: aprova assim que metade + 1 dos membros votar a favor; senão espera o prazo (6 h) e
    // expira sem fazer nada (não encerra antes: dá para mudar o voto). Enquetes antigas sem essa regra:
    // decide quando o resultado não tem mais como virar.
    const restantes = Math.max(0, (e.membros || 0) - pessoas);
    const aprovou = e.regra === 'maioria_do_grupo'
      ? aFavor >= e.limite
      : aFavor > outras + restantes || (fimDoPrazo && aFavor > outras);
    if (!aprovou && !fimDoPrazo) return;
    encerrar(e.id, `${aprovou ? 'aprovada' : 'rejeitada'} (${placar})`);
    if (!aprovou) {
      await enviar(`Enquete encerrada e não aprovada${e.regra === 'maioria_do_grupo' ? ` (precisava de ${e.limite} votos em "${e.opcaoAprova}")` : ''}. Não vou fazer nada.\n${placar}`);
      log(`Enquete "${e.pergunta}" não aprovada (${placar}).`);
      return;
    }
    try {
      const oque = descreverAcao(e.acao, await metadadosGrupo(e.jid).catch(() => null)); // antes: a pessoa ainda está no grupo
      const r = await executarAdmin(e.acao, { jid: e.jid, ctx: null, imagens: [], outrosMarcados: [], pedidoPor: `enquete "${e.pergunta}"` });
      log(`Enquete "${e.pergunta}" aprovada (${placar}): ${e.acao.acao} feito (${r.detalhe}).`);
      await enviar([`Enquete aprovada (${aFavor} votos em "${e.opcaoAprova}"). Como combinado, ${oque}: feito.`, r.resumoParcial, r.parcial, r.extra, r.aviso].filter(Boolean).join('\n'));
    } catch (err) {
      log(`Enquete "${e.pergunta}" aprovada, mas a ação falhou (${err.message}).`);
      await enviar(`Enquete aprovada, mas não consegui: ${err.message}.`);
    }
  }
  // A cada minuto: encerra as vencidas e decide as que já não têm como virar (inclusive as que ganharam
  // votos enquanto o bot estava desligado ou antes desta regra existir).
  avaliarEnquetes = () => Promise.all(enquetesAbertas().map((e) => avaliarEnquete(e, Date.now() >= e.expiraEm).catch((err) => log('Erro ao conferir enquete:', err.message))));

  // Executa as ações com timer que chegaram na hora.
  rodarAgendadas = async () => {
    for (const a of vencidas()) {
      // Só mandar o histórico do grupo no privado de alguém ({ historico: { para, desde, ate } }).
      if (a.historico) {
        try {
          const n = await mandarHistorico(a.jid, a.historico.para, a.historico.desde, await metadadosGrupo(a.jid).catch(() => null), a.historico.ate);
          log(`Agendado (de ${a.pedidoPor}): mandei ${n} mensagem(ns) do histórico para ${a.historico.para}.`);
        } catch (e) { log(`Agendado (de ${a.pedidoPor}): histórico para ${a.historico.para} não deu (${e.message}).`); }
        continue;
      }
      const enviar = async (texto) => guardarEnviada(await sock.sendMessage(a.jid, { text: marcaServico('Agendado', texto), mentions: mencoesDoTexto(texto, await metadadosGrupo(a.jid).catch(() => null)) }));
      try {
        let texto = a.mensagem || '';
        // Remoção agendada por quem não é o dono do bot: na hora marcada abre o julgamento (não remove direto).
        if (a.admin?.acao === 'remover' && !a.semJulgamento) {
          const r = await abrirJulgamentos(a.admin, { jid: a.jid, pedidoPor: a.pedidoPor, pedidoPorIds: a.pedidoPorIds || [], pedido: `${a.pedidoPor} agendou: ${a.descricao}${a.mensagem ? ` ("${a.mensagem.slice(0, 200)}")` : ''}` });
          log(`Agendado (de ${a.pedidoPor}): remoção virou julgamento.`);
          const aviso = [texto, r.texto].filter(Boolean).join('\n');
          guardarEnviada(await sock.sendMessage(a.jid, { text: marcaServico('Julgamento', aviso), mentions: mencoesDoTexto(aviso, await metadadosGrupo(a.jid).catch(() => null)) }));
          continue;
        }
        if (a.admin) {
          const r = await executarAdmin(a.admin, { jid: a.jid, ctx: null, imagens: [], outrosMarcados: [], pedidoPor: a.pedidoPor });
          log(`Agendado (de ${a.pedidoPor}): ${a.admin.acao} feito (${r.detalhe}).`);
          texto = [texto || (r.resumoParcial ? 'Na hora marcada:' : `Na hora marcada: ${a.descricao}: feito.`), r.resumoParcial, r.parcial, r.extra, r.aviso].filter(Boolean).join('\n');
        } else log(`Agendado (de ${a.pedidoPor}): mensagem enviada.`);
        await enviar(texto);
      } catch (e) {
        log(`Agendado (de ${a.pedidoPor}): ${a.admin?.acao || 'mensagem'} não deu (${e.message}).`);
        await enviar(`Na hora marcada não deu (${a.descricao}): ${e.message}.`).catch(() => {});
      }
    }
  };

  async function tratarVoto(m) {
    const e = registrarVoto(m);
    if (!e) return;
    if (e.erro) { log(`Enquete "${e.pergunta}": ${e.erro} (${m.pushName || m.key.participant}).`); return; }
    const { c } = contagem(e);
    log(`Voto de ${m.pushName || nomeDaPessoa(m.key.participant) || 'alguém'} na enquete "${e.pergunta}": ${e.opcoes.map((o) => `${o} ${c[o] || 0}`).join(', ')}.`);
    await avaliarEnquete(e);
  }

  /** Acha os "@número" do texto que são participantes do grupo e devolve os JIDs para marcar. */
  function mencoesDoTexto(texto, meta) {
    const numeros = [...new Set((String(texto || '').match(/@(\d{6,})/g) || []).map((t) => t.slice(1)))];
    if (!numeros.length) return [];
    const participantes = meta?.participants || [];
    const jids = [];
    for (const n of numeros) {
      const p = participantes.find((x) =>
        [x.id, x.lid, x.phoneNumber, x.jid].filter(Boolean).some((j) => digitos(jidNormalizedUser(j)) === n));
      if (p) jids.push(p.id);
    }
    return jids;
  }

  // Gerador falhou 3 vezes: mensagem amigável no grupo (o erro técnico fica só no bot.log).
  function falhaAmigavel(oque) {
    const frases = [
      `A placa de vídeo pediu arrego aqui: tentei 3 vezes e a ${oque} não saiu. Tenta de novo daqui a pouco.`,
      `Tentei 3 vezes e a ${oque} empacou no forno. Me dá um minutinho e pede de novo.`,
      `Deu ruim aqui no PC e a ${oque} não saiu, mesmo tentando 3 vezes. Pede de novo daqui a pouco que eu tento.`,
    ];
    return frases[Math.floor(Math.random() * frases.length)];
  }

  // Serviço (baixar, fazer figurinha, criar regra...) leva uma marca no topo; resposta comum não.
  function marcaServico(nome, texto) {
    const corpo = semRotulo(texto).trim(); // o Claude às vezes copia o rótulo do histórico: não repete
    return `🤖 *Serviço: ${nome}*${corpo ? `\n${corpo}` : ''}`;
  }

  // Recorte "parte": acha o alvo na foto (Sonnet com grade) e recorta pelo contorno dele
  // (MobileSAM + BiRefNet, local). "sem_fundo": só tira o fundo da imagem toda.
  async function recortarSePedido(buffer, f) {
    if (f.recorte === 'sem_fundo') return contornar(buffer);
    if (f.recorte !== 'parte' || !f.alvo) return buffer;
    const area = await acharArea(buffer, f.alvo);
    log(`Recorte de "${f.alvo}": ${area.motivo} (x ${(area.x * 100).toFixed(0)}%, y ${(area.y * 100).toFixed(0)}%, ${(area.w * 100).toFixed(0)}x${(area.h * 100).toFixed(0)}%).`);
    return contornar(buffer, area);
  }

  async function montarFigurinha(f, imagens, animado = null) {
    const textos = { cima: f.texto_cima || '', baixo: f.texto_baixo || '' };
    const recorte = f.recorte === 'quadrado' ? 'quadrado' : 'inteira';
    if (f.origem === 'imagem') {
      // GIF / vídeo / figurinha animada → figurinha animada (texto por cima de todos os quadros).
      if (animado) return figurinhaAnimada(animado.buffer, { ext: animado.ext, camada: await camadaDeTexto(textos), filtro: filtroFfmpeg(f.efeitos) });
      if (!imagens.length) throw new Error('não veio imagem junto; manda a imagem (ou responde ela) pedindo a figurinha');
      return figurinhaDeImagem(await aplicarEfeitos(await recortarSePedido(imagens[0], f), f.efeitos), { ...textos, recorte });
    }
    if (f.origem === 'web') {
      if (!f.url) throw new Error('não achei imagem para usar');
      const { buffer, mime } = await baixarMidiaDaWeb(f.url);
      if (mime.startsWith('video/') || await ehAnimada(buffer)) {
        return figurinhaAnimada(buffer, { ext: mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : 'mp4', camada: await camadaDeTexto(textos), filtro: filtroFfmpeg(f.efeitos) });
      }
      return figurinhaDeImagem(await aplicarEfeitos(await recortarSePedido(buffer, f), f.efeitos), { ...textos, recorte });
    }
    if (f.origem === 'meme') return figurinhaDeMeme({ id: f.meme_id, ...textos });
    if (f.origem === 'gerada') {
      if (!geradorOk || !temGerador()) throw new Error('o gerador de imagem está desligado');
      if (!f.prompt) throw new Error('faltou descrever a figurinha');
      return figurinhaDeImagem(await gerarImagem(f.prompt, { formato: 'quadrado' }), { ...textos, recorte: 'inteira' });
    }
    return figurinhaDeTexto(f.texto || [textos.cima, textos.baixo].filter(Boolean).join(' '), { cor: f.cor });
  }

  // ---------- link de rede social → baixa e manda ----------
  let filaDownloads = Promise.resolve(); // um download por vez
  let ultimoLink = 0;

  function linksDeRede(texto) {
    const urls = (texto.match(/https?:\/\/[^\s<>"]+/gi) || [])
      .map((u) => u.replace(/[).,!?]+$/, '').replace(/^http:/i, 'https:'))
      .filter(ehSiteDeVideo);
    return [...new Set(urls)].slice(0, 2);
  }

  function baixarLinks(m, jid) {
    if (!CONFIG.links.ativo || !temDownloaderDeVideo()) return false;
    const urls = linksDeRede(textoDa(m));
    if (!urls.length) return false;
    if (Date.now() - ultimoLink < CONFIG.links.intervaloSeg * 1000) return false;
    ultimoLink = Date.now();
    jaRespondidas.add(m.key.id);
    const autor = m.pushName || digitos(m.key.participant || '');

    filaDownloads = filaDownloads.then(async () => {
      for (const url of urls) {
        await sock.sendPresenceUpdate('recording', jid).catch(() => {});
        try {
          const anexo = await prepararAnexo({ url, tipo: 'video', nome: '' }, marcaServico('Download', new URL(url).hostname.replace(/^www\./, '')));
          guardarEnviada(await sock.sendMessage(jid, anexo, { quoted: m }));
          log(`Link de ${autor} baixado e enviado: ${url}`);
        } catch (e) {
          log(`Não deu para baixar o link de ${autor} (${e.message}): ${url}`);
          guardarEnviada(await sock.sendMessage(jid, { text: `Não consegui baixar esse link: ${e.message}` }, { quoted: m }));
        } finally {
          await sock.sendPresenceUpdate('paused', jid).catch(() => {});
        }
      }
    }).catch((e) => log('Erro ao baixar links:', e.stack || e));
    return true;
  }

  // ---------- regras criadas pelo grupo ----------
  function tipoDaMensagem(c) {
    if (c.stickerMessage) return 'figurinha';
    if (c.imageMessage) return 'imagem';
    if (c.audioMessage) return 'audio';
    if (c.videoMessage) return 'video';
    if (c.conversation || c.extendedTextMessage) return 'texto';
    return null;
  }

  // Impressão do arquivo da figurinha (a mesma figurinha mandada de novo tem o mesmo sha256).
  function shaFigurinha(s) {
    const h = s?.fileSha256;
    if (!h) return null;
    if (typeof h === 'string') return h;
    return Buffer.from(h instanceof Uint8Array ? h : Object.values(h)).toString('base64');
  }

  async function aplicarRegras(m, jid, meta) {
    const c = conteudo(m);
    const tipo = tipoDaMensagem(c);
    if (!tipo) return false;
    const autor = m.pushName || digitos(m.key.participant || '');
    const texto = textoDa(m);
    const disparadas = regras.disparadas({
      jid, tipo, texto, autorNome: autor, figurinha: shaFigurinha(c.stickerMessage),
      autorIds: [m.key.participant, m.key.participantAlt].filter(Boolean).map(jidNormalizedUser),
    });
    if (!disparadas.length) return false;
    jaRespondidas.add(m.key.id);

    for (const regra of disparadas.slice(0, 2)) {
      log(`Regra ${regra.id} disparada por ${autor}: ${regra.descricao}`);
      const executar = async () => {
        const { tipo: acao, conteudo: arg } = regra.acao;
        if (acao === 'apagar') {
          await sock.sendMessage(jid, { delete: { remoteJid: jid, id: m.key.id, fromMe: false, participant: m.key.participant } });
          log(`Regra ${regra.id}: apaguei a mensagem de ${autor}.`);
          return;
        }
        const imagens = c.imageMessage || c.stickerMessage ? [await baixar(m)] : [];
        if (acao === 'texto') {
          guardarEnviada(await sock.sendMessage(jid, { text: arg }, { quoted: m }));
          registrar(jid, 'Bot', arg);
        } else if (acao === 'audio_gabreu') {
          guardarEnviada(await sock.sendMessage(jid, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: m }));
        } else if (acao === 'figurinha_padrao') {
          const fig = respostas[tipo === 'imagem' ? 'imagem' : 'figurinha'].buffer || respostas.figurinha.buffer;
          if (fig) guardarEnviada(await sock.sendMessage(jid, { sticker: fig }, { quoted: m }));
        } else if (acao === 'meme' && ia) {
          const v = await memeDeRegra({ grupo: meta.subject, autor, mensagem: texto, instrucao: arg, imagens, catalogo: await catalogoParaPrompt() });
          const meme = await figurinhaDeMeme({ id: v.meme_id, cima: v.texto_cima, baixo: v.texto_baixo });
          guardarEnviada(await sock.sendMessage(jid, { sticker: meme }, { quoted: m }));
        } else if (acao === 'ia' && ia) {
          await sock.sendPresenceUpdate('composing', jid).catch(() => {});
          const hist = historicoDoGrupo(jid, CONFIG.mencao.historico, m.key.id);
          const resposta = await respostaDeRegra({ grupo: meta.subject, historico: hist, autor, mensagem: texto, instrucao: arg, imagens });
          await sock.sendPresenceUpdate('paused', jid).catch(() => {});
          guardarEnviada(await sock.sendMessage(jid, { text: resposta }, { quoted: m }));
          registrar(jid, 'Bot', resposta);
        }
      };
      const precisaClaude = ['ia', 'meme'].includes(regra.acao.tipo);
      if (precisaClaude) filaClaude = filaClaude.then(executar).catch((e) => log(`Erro na regra ${regra.id}:`, e.message));
      else await executar().catch((e) => log(`Erro na regra ${regra.id}:`, e.message));
    }
    return true;
  }

  // Contexto do grupo: sai das mensagens salvas (em disco, inclusive as antigas buscadas no celular),
  // em ordem de horário. Aqui em memória ficam só as notas internas do bot (ex: prompt de imagem que falhou).
  const notasInternas = new Map(); // grupo -> [{ em, nome, texto }]
  function registrar(jid, nome, texto) {
    if (!texto || !String(nome).startsWith('Bot (nota')) return; // o resto já está nas mensagens salvas
    const lista = notasInternas.get(jid) || [];
    lista.push({ em: Date.now() / 1000, nome, texto });
    while (lista.length > 20) lista.shift();
    notasInternas.set(jid, lista);
  }

  const dataHora = (s) => {
    const d = new Date(s * 1000);
    const dia = (x) => x.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const hora = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    return dia(d) === dia(new Date()) ? hora : `${dia(d).slice(0, 5)} ${hora}`;
  };

  /** As últimas `quantas` mensagens do grupo (fora a `semId`), mais antigas primeiro. */
  function historicoDoGrupo(jid, quantas, semId = null) {
    const nomeDe = (g) => (g.key.fromMe ? 'Bot' : g.nome || nomeDaPessoa(g.key.participant, g.key.participantAlt) || 'alguém');
    const itens = [];
    for (const g of mensagensGuardadas.values()) {
      if (g.key.remoteJid !== jid || g.key.id === semId) continue;
      const texto = resumo(conteudo(g));
      if (texto) itens.push({ em: g.em || 0, nome: nomeDe(g), texto: semMeuArroba(semRotulo(texto)) });
    }
    itens.push(...(notasInternas.get(jid) || []));
    return itens
      .sort((a, b) => a.em - b.em)
      .slice(-quantas)
      .map((x) => `[${dataHora(x.em)}] ${x.nome}: ${x.texto.replace(/\s+/g, ' ').slice(0, 500)}`);
  }

  // Pedidos do tipo "lê aí", "resume a conversa", "o que o fulano falou?" liberam o histórico longo.
  // (testado no texto sem acentos, porque o \b do regex não entende letra acentuada)
  const PEDE_LEITURA = /\b(le|ler|leia|leu|resum\w*|o que (o|a)?\s*\w*\s*(falou|disse|mandou|quis dizer)|que (ele|ela|eles|elas) (falou|disse|falaram|disseram)|conversa|historico|mensagens? (de )?(cima|antes|anterior\w*)|la em cima|acima|contexto|do que (voces|vcs|eles|elas) (estao|tao) falando)\b/i;

  function historicoPara(jid, pedido, idAtual = null) {
    const leituraPedida = PEDE_LEITURA.test(normalizar(pedido));
    // a própria mensagem vai separada
    return { hist: historicoDoGrupo(jid, leituraPedida ? CONFIG.mencao.historicoLeitura : CONFIG.mencao.historico, idAtual), leituraPedida };
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Guarda o segredo de cada mensagem: é com ele que se abre uma edição dela depois.
    for (const m of messages) {
      if (!isJidGroup(m.key.remoteJid || '')) continue;
      guardarSegredo(m);
      if (!m.key.fromMe && !m.message?.pollUpdateMessage) guardarMensagem(m, m.pushName); // as do bot entram pelo guardarEnviada
    }
    if (type !== 'notify') return; // 'append' = histórico sincronizado
    for (const m of messages) {
      try {
        const jid = m.key.remoteJid;
        if (!isJidGroup(jid)) {
          // Privado (chat direto com o bot): ninguém fica sem resposta (roda à parte: espera a rajada acabar).
          const recente = Date.now() / 1000 - Number(m.messageTimestamp || 0) <= CONFIG.idadeMaxSeg;
          if (ehPrivado(jid) && !m.key.fromMe && recente && !jaRespondidas.has(m.key.id) && CONFIG.mencao.ativo) {
            responderPrivado(m).catch((e) => log('Erro ao responder no privado:', e.stack || e));
          }
          continue;
        }
        // Voto numa enquete do bot: conta e, se aprovou, executa a ação.
        if (m.message?.pollUpdateMessage) { await tratarVoto(m); continue; }
        const edicao = edicaoDe(m);
        if (edicao) {
          if (edicao.message) await tratarEdicao({ ...m.key, id: edicao.id }, edicao.message, m.pushName, 'mensagem');
          continue;
        }
        registrar(jid, m.key.fromMe ? 'Bot' : m.pushName || digitos(m.key.participant || ''), resumo(conteudo(m)), m.key.id);
        lembrarPessoa(jid, m);
        if (!m.key.fromMe && resumo(conteudo(m))) contadorMsgs.set(jid, (contadorMsgs.get(jid) || 0) + 1);
        if (m.key.fromMe || jaRespondidas.has(m.key.id)) continue;

        const idade = Date.now() / 1000 - Number(m.messageTimestamp || 0);
        if (idade > CONFIG.idadeMaxSeg) continue;

        const meta = await metadadosGrupo(jid);

        if (CONFIG.mencao.ativo && ia && meMarcaram(m)) {
          await responderMarcacao(m, jid, meta);
          continue;
        }
        // Sem @: em segundo plano, vê se foi claramente com o bot (não segura as outras mensagens).
        if (CONFIG.mencao.ativo && ia) talvezFalaramComigo(m, jid, meta);

        if (baixarLinks(m, jid)) continue;
        if (await aplicarRegras(m, jid, meta)) continue;

        if (normalizar(meta.subject) !== normalizar(CONFIG.grupo)) continue;
        await responderInterrogacao(m, jid);
        await responderFigurinha(m, jid);
      } catch (err) {
        log('Erro ao processar mensagem:', err.stack || err);
      }
    }
  });

  // ---------- mensagem editada que passou a marcar o bot ----------
  // A edição chega de dois jeitos (conforme a versão do WhatsApp/Baileys): como mensagem nova com um
  // protocolMessage MESSAGE_EDIT dentro (às vezes embrulhado em editedMessage), e como messages.update.
  // Os dois passam por aqui; o primeiro que chegar responde.
  const edicoesVistas = new Set();

  /** Se a mensagem é uma edição, devolve { id original, conteúdo novo }. */
  function edicaoDe(msg) {
    // Formato novo: edição criptografada (o Baileys não abre; o edicoes.mjs abre).
    const cifrada = decifrarEdicao(msg, (id) => {
      // a original pode ter chegado antes do último reinício: o segredo também está nas mensagens salvas
      const g = mensagensGuardadas.get(id);
      const segredo = g?.message?.messageContextInfo?.messageSecret;
      return segredo ? { segredo: typeof segredo === 'string' ? Buffer.from(segredo, 'base64') : Buffer.from(segredo), autores: [g.key.participant, g.key.participantAlt].filter(Boolean).map(jidNormalizedUser) } : null;
    });
    if (cifrada?.message) return cifrada;
    if (cifrada?.erro) {
      log(`Edição de ${msg.pushName || 'alguém'} não lida: ${cifrada.erro}.`);
      return { id: cifrada.id, message: null };
    }
    const raw = msg.message || {};
    const p = raw.protocolMessage || raw.editedMessage?.message?.protocolMessage || conteudo(msg).protocolMessage;
    if (p?.editedMessage && p.key?.id) return { id: p.key.id, message: p.editedMessage };
    return null;
  }

  /** Conteúdo editado + o que só a original tem (citação, mídia da legenda). */
  function juntarEdicao(originalMsg, editada) {
    if (!originalMsg) return editada;
    const orig = conteudo({ message: originalMsg });
    const novoTexto = editada.conversation ?? editada.extendedTextMessage?.text
      ?? editada.imageMessage?.caption ?? editada.videoMessage?.caption;
    const novoCtx = contextoDa(editada) || {};
    const ctxOrig = contextoDa(orig) || {};
    const ctx = { ...ctxOrig, ...novoCtx };
    // citação da original, se a edição não trouxe
    for (const k of ['stanzaId', 'participant', 'quotedMessage', 'remoteJid']) if (!novoCtx[k] && ctxOrig[k]) ctx[k] = ctxOrig[k];
    if (novoCtx.mentionedJid?.length) ctx.mentionedJid = novoCtx.mentionedJid;
    // mídia com legenda: mantém a mídia, troca a legenda
    for (const tipo of ['imageMessage', 'videoMessage']) {
      if (orig[tipo]) return { [tipo]: { ...orig[tipo], caption: novoTexto ?? orig[tipo].caption, contextInfo: ctx } };
    }
    if (novoTexto == null) return editada;
    return { extendedTextMessage: { ...(editada.extendedTextMessage || {}), text: novoTexto, contextInfo: ctx } };
  }

  async function tratarEdicao(key, editada, pushName, origem) {
    const jid = key.remoteJid;
    if (key.fromMe || !isJidGroup(jid) || !CONFIG.mencao.ativo || !ia) return;
    const autorId = jidNormalizedUser(key.participant || '');
    const nome = pushName || conhecidos.get(jid)?.get(digitos(autorId)) || digitos(autorId);
    // A edição traz só o conteúdo novo (texto, @). A quem a mensagem respondia (e a mídia, se era
    // legenda) fica na ORIGINAL: junta as duas, para o bot ter a mensagem respondida e o fio.
    const original = mensagensGuardadas.get(key.id);
    const message = juntarEdicao(original?.message, editada);
    if (original) mensagensGuardadas.set(key.id, { ...original, message });
    const m = { key, message, pushName: nome, messageTimestamp: Date.now() / 1000 };
    const texto = textoDa(m);
    const chave = `${key.id}|${texto}`;
    if (edicoesVistas.has(chave)) return; // a mesma edição pelo outro caminho
    edicoesVistas.add(chave);
    if (edicoesVistas.size > 300) edicoesVistas.delete(edicoesVistas.values().next().value);
    const marcou = meMarcaram(m);
    log(`Edição de ${nome} (${origem}): "${texto.slice(0, 80)}" → ${marcou ? 'marca o bot' : 'não marca o bot'}`);
    if (!marcou) return;
    if (jaRespondidas.has(key.id)) {
      log(`A mensagem editada de ${nome} já foi (ou está sendo) respondida.`);
      return;
    }
    registrar(jid, nome, resumo(conteudo(m)));
    await responderMarcacao(m, jid, await metadadosGrupo(jid));
  }

  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      try {
        const editada = update?.message?.editedMessage?.message;
        if (editada) await tratarEdicao(key, editada, null, 'update');
      } catch (err) {
        log('Erro ao processar mensagem editada:', err.stack || err);
      }
    }
  });
}

process.on('unhandledRejection', (err) => log('unhandledRejection:', err?.stack || err));
iniciar().catch((err) => {
  log('Falha ao iniciar:', err.stack || err);
  process.exit(1);
});
