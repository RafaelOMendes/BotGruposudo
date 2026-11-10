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
import { acharArea, agoraBrasil, avaliarEntregas, avaliarNonsense, configurarModelos, falaramComOBot, iniciarIA, interpretarMencao, memeDeRegra, respostaDeRegra } from './ia.mjs';
import { iniciarAvisos, listaParaPergunta, PERGUNTA_ENTREGA } from './entregas.mjs';
import { vigiarLogin, manterMateriais, indiceMateriais, idsDeLinkClassroom, PASTA_MATERIAIS, PERGUNTA_AULA } from './classroom.mjs';
import { contornar } from './contorno.mjs';
import { aplicarEfeitos, camadaDeTexto, catalogoParaPrompt, filtroFfmpeg, figurinhaDeImagem, figurinhaDeMeme, figurinhaDeTexto } from './memes.mjs';
import { Regras } from './regras.mjs';
import { configurarGerador, desligarGerador, disponivel as temGerador, gerarImagem } from './gerador.mjs';
import { gerarPdf } from './pdf.mjs';
import { decifrarEdicao, guardarSegredo } from './edicoes.mjs';
import { contagem, encerrar, enquetesAbertas, novoSegredo, registrarEnquete, registrarVoto } from './enquetes.mjs';
import { agendar, pendentes, vencidas } from './agenda.mjs';
import { baixarImagemDaWeb, baixarMidiaDaWeb, ehAnimada, ehSiteDeVideo, figurinhaAnimada, figurinhaParaMidia, iniciarDownloads, prepararAnexo, temDownloaderDeVideo } from './web.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

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
setInterval(() => rodarAgendadas?.(), 15_000).unref?.();
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
  function citacaoComNomes(q) {
    const meus = new Set(meusIds().map(digitos));
    const nome = (d) => (meus.has(d) ? sock.user?.name || 'Bot' : nomeDaPessoa(`${d}@lid`, `${d}@s.whatsapp.net`));
    const trocar = (t) => t.replace(/@(\d{6,})/g, (tudo, d) => (nome(d) ? `@${nome(d)}` : tudo));
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
  sock.ev.on('group-participants.update', (u) => groupCache.del(u.id));

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

  async function responderMarcacao(m, jid, meta) {
    const autorId = m.key.participant || jid;
    const autor = m.pushName || digitos(autorId);
    if (Date.now() - (ultimaMencao.get(autorId) || 0) < CONFIG.mencao.intervaloSeg * 1000) {
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
        animacao: animado ? (animado.ext === 'webp' ? 'uma figurinha animada' : animado.gif ? 'um GIF' : 'um vídeo') : '',
        temVideo: temDownloaderDeVideo(), respondeuBot, catalogo: await catalogoParaPrompt(), temGerador: !!geradorOk && temGerador(),
        pessoas: pessoasParaPrompt(jid, meta),
      });
    };

    // 2) O resto (gerar imagem, baixar, enviar) roda fora da fila: enquanto uma imagem gera,
    //    o bot continua respondendo as outras marcações.
    const tarefa = async (v, erroClaude) => {
      let resposta;
      let anexos = [];
      let figurinhaPronta = null;
      let servico = null; // quando o bot fez um serviço (não só respondeu), a mensagem leva uma marca
      // Gerar imagem leva ~1 a 2 min: avisa na hora para ninguém achar que travou.
      const avisarGerando = async () => {
        guardarEnviada(await sock.sendMessage(jid, { text: marcaServico('Gerando imagem', 'Começou aqui, leva uns 1 a 2 minutos.') }, { quoted: m }));
      };
      try {
        if (erroClaude) throw erroClaude;
        resposta = v.texto;
        if (v.usouModeloMaior) log(`Pedido de ${autor} era complexo: refeito no ${modelos.complexo.modelo}.`);
        if (v.acao === 'responder' && Array.isArray(v.anexos)) anexos = v.anexos.filter((a) => a?.url).slice(0, 3);
        if (v.acao === 'criar_regra') {
          const remetente = { nome: v.regra_remetente || '', ids: v.regra_remetente ? outrosMarcados : [] };
          const r = regras.criar(jid, v, remetente, autor);
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

        // Função de admin (remover, adicionar, promover, nome, link...): só confirma depois de conseguir.
        if (v.acao === 'responder' && v.admin?.acao && v.admin.acao !== 'nenhuma') {
          try {
            const r = await executarAdmin(v.admin, { jid, ctx, imagens, outrosMarcados });
            log(`Admin: ${v.admin.acao}${v.admin.pessoas?.length ? ` (${v.admin.pessoas.join(', ')})` : ''} pedido por ${autor}: feito (${r.detalhe}).`);
            servico = 'Admin';
            resposta = [resposta, r.parcial, r.extra].filter(Boolean).join('\n');
          } catch (e) {
            log(`Admin: ${v.admin.acao} pedido por ${autor} não deu (${e.message}).`);
            resposta = `Não consegui: ${e.message}.`;
          }
        }

        // Ações com timer ("adiciona o Nicolas de volta em 10 min", "me lembra em 1 hora").
        if (v.acao === 'responder' && Array.isArray(v.agendadas) && v.agendadas.length) {
          const meta2 = await metadadosGrupo(jid).catch(() => meta);
          const feitas = [];
          for (const a of v.agendadas.slice(0, 5)) {
            const minutos = Math.min(7 * 24 * 60, Math.max(0.25, Number(a.minutos) || 0));
            const admin = a.admin?.acao && a.admin.acao !== 'nenhuma' ? a.admin : null;
            if (!admin && !a.mensagem?.trim()) continue;
            // Mesma ação para a mesma pessoa já agendada perto dessa hora (ex: duas pessoas pediram): não repete.
            if (admin && pendentes(jid).some((p) => p.admin?.acao === admin.acao && Math.abs(p.quando - (Date.now() + minutos * 60e3)) < 5 * 60e3
              && (p.admin.pessoas || []).join() === (admin.pessoas || []).join())) { feitas.push(`${descreverAcao(admin, meta2)} (já estava agendado)`); continue; }
            const quando = Date.now() + minutos * 60e3;
            const descricao = admin ? descreverAcao(admin, meta2) : 'aviso';
            // historico_desde: se for "adicionar e mandar o histórico", conta a partir do pedido.
            agendar({ jid, quando, admin: admin ? { ...admin, historico_desde: Date.now() } : null, mensagem: a.mensagem || '', pedidoPor: autor, descricao });
            const hora = new Date(quando).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            feitas.push(`${descricao} às ${hora}`);
            log(`Agendado por ${autor} para ${hora} (em ${minutos} min): ${admin ? admin.acao + (admin.pessoas?.length ? ` (${admin.pessoas.join(', ')})` : '') : ''}${a.mensagem ? ` mensagem "${a.mensagem.slice(0, 60)}"` : ''}.`);
          }
          if (feitas.length) {
            servico = servico ? `${servico} + Agendado` : 'Agendado';
            resposta = [resposta, `⏰ ${feitas.join('; ')}.`].filter(Boolean).join('\n');
          }
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
        const prontos = [];
        const falhas = [];
        for (const a of anexos) {
          if (a.pronto) { prontos.push(a.pronto); continue; }
          if (a.gerada) { prontos.push({ image: a.gerada, caption: '' }); continue; }
          try {
            prontos.push(await prepararAnexo(a, ''));
            log(`Baixei ${a.tipo}: ${a.url}`);
          } catch (e) {
            log(`Não deu para baixar ${a.tipo} (${e.message}): ${a.url}`);
            falhas.push(`${a.url} (${e.message})`);
          }
        }
        anexos = prontos;
        if (anexos.length && !servico) servico = 'Download';
        if (falhas.length) resposta = `${resposta || ''}\n\nNão consegui baixar:\n${falhas.map((f) => '- ' + f).join('\n')}`.trim();
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
        ultimaId = guardarEnviada(await sock.sendMessage(jid, anexo, i === 0 ? { quoted: m } : {}))?.key?.id || ultimaId;
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
      .catch((e) => log('Erro ao responder marcação:', e.stack || e));
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
    for (const [id, nome] of conhecidos.get(jid) || new Map()) linhas.set(id, { nome, admin: '' });
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
  function marcarSaida(jid, ids) {
    for (const i of ids.filter(Boolean)) saidas[`${jid}|${digitos(jidNormalizedUser(i))}`] = Date.now();
    try { fs.writeFileSync(ARQ_SAIDAS, JSON.stringify(saidas)); } catch { /* tenta na próxima */ }
  }
  /** Manda no privado as mensagens do grupo desde que a pessoa saiu (ou desde `desde`). */
  async function mandarHistorico(jid, destino, desde, meta) {
    // As mensagens guardadas têm a hora em SEGUNDOS (messageTimestamp); saídas e pedidos, em ms.
    const inicio = Math.floor((saidas[`${jid}|${digitos(destino)}`] || desde || 0) / 1000);
    const itens = [];
    for (const g of mensagensGuardadas.values()) {
      if (g.key.remoteJid !== jid || (g.em || 0) < inicio) continue;
      const texto = resumo(conteudo(g));
      if (texto) itens.push({ em: g.em || 0, nome: g.key.fromMe ? 'Bot' : g.nome || nomeDaPessoa(g.key.participant, g.key.participantAlt) || 'alguém', texto: semRotulo(texto) });
    }
    itens.sort((a, b) => a.em - b.em);
    const ultimas = itens.slice(-150).map((x) => `[${dataHora(x.em)}] ${x.nome}: ${x.texto.replace(/\s+/g, ' ').slice(0, 500)}`);
    const cabeca = `📜 O que rolou no grupo *${meta?.subject || ''}* enquanto você estava fora${inicio ? ` (desde ${dataHora(inicio)})` : ''}:`;
    if (!ultimas.length) { await sock.sendMessage(destino, { text: `${cabeca}\nNinguém mandou nada.` }); return 0; }
    let bloco = cabeca;
    for (const l of ultimas) {
      if (`${bloco}\n${l}`.length > 3500) { await sock.sendMessage(destino, { text: bloco }); bloco = ''; }
      bloco = bloco ? `${bloco}\n${l}` : l;
    }
    if (bloco) await sock.sendMessage(destino, { text: bloco });
    return ultimas.length;
  }

  const DURACAO = { desligar: 0, '24h': 86400, '7d': 7 * 86400, '90d': 90 * 86400 };
  /**
   * Executa a função de admin que o Claude pediu. Devolve { ok, detalhe }; lança erro com a explicação
   * se não deu (o bot não é admin, pessoa não achada...).
   */
  async function executarAdmin(a, { jid, ctx, imagens, outrosMarcados }) {
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
      const r = await sock.groupParticipantsUpdate(jid, alvos, { remover: 'remove', adicionar: 'add', promover_admin: 'promote', tirar_admin: 'demote' }[a.acao]);
      groupCache.del(jid);
      let falhas = (r || []).filter((x) => String(x.status) !== '200');
      const deram = alvos.filter((j) => !falhas.some((x) => digitos(x.jid) === digitos(j)));
      if (a.acao === 'remover') {
        for (const j of deram) {
          const p = participante(digitos(jidNormalizedUser(j)));
          marcarSaida(jid, [j, p?.lid, p?.phoneNumber, p?.id]);
        }
      }
      if (a.acao === 'adicionar' && a.mandar_historico) {
        for (const j of deram) {
          try { log(`Admin: mandei ${await mandarHistorico(jid, jidNormalizedUser(j), a.historico_desde, meta)} mensagem(ns) do histórico para ${j}.`); }
          catch (e) { log(`Admin: não deu para mandar o histórico para ${j} (${e.message}).`); }
        }
      }
      // Privacidade da pessoa não deixa adicionar direto (403): manda o link do grupo no privado dela.
      if (a.acao === 'adicionar') {
        const bloqueados = falhas.filter((x) => String(x.status) === '403');
        if (bloqueados.length) {
          const link = `https://chat.whatsapp.com/${await sock.groupInviteCode(jid)}`;
          for (const x of bloqueados) {
            const destino = alvos.find((j) => digitos(j) === digitos(x.jid)) || x.jid;
            try {
              await sock.sendMessage(destino, { text: `Te chamaram de volta pro grupo *${meta.subject}*. Entra por aqui: ${link}` });
              log(`Admin: não deu para adicionar ${destino} direto (privacidade); mandei o link no privado.`);
            } catch (e) { log(`Admin: não deu nem para mandar o link para ${destino} (${e.message}).`); }
          }
          falhas = falhas.filter((x) => String(x.status) !== '403');
          if (!falhas.length) return { detalhe: `convite mandado no privado (${bloqueados.length})`, parcial: 'A privacidade não deixa adicionar direto, então mandei o link do grupo no privado.' };
        }
      }
      if (falhas.length === alvos.length) {
        const st = String(falhas[0]?.status);
        throw new Error(st === '403' && a.acao === 'adicionar' ? 'a privacidade da pessoa não deixa adicionar direto (manda o link do grupo pra ela)'
          : st === '409' ? (a.acao === 'adicionar' ? 'a pessoa já está no grupo' : 'a pessoa não está no grupo')
          : st === '406' || st === '401' ? 'o WhatsApp não deixa (dono do grupo não pode ser removido nem rebaixado)'
          : `o WhatsApp recusou (código ${st})`);
      }
      return { detalhe: `${a.acao} ${alvos.length - falhas.length}/${alvos.length}`, parcial: falhas.length ? `(${falhas.length} não deu)` : '' };
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
      trocar_link: 'troco o link do grupo', mensagens_temporarias: `ponho mensagens temporárias (${a.tempo})`,
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
      const r = await executarAdmin(e.acao, { jid: e.jid, ctx: null, imagens: [], outrosMarcados: [] });
      log(`Enquete "${e.pergunta}" aprovada (${placar}): ${e.acao.acao} feito (${r.detalhe}).`);
      await enviar([`Enquete aprovada (${aFavor} votos em "${e.opcaoAprova}"). Como combinado, ${oque}: feito.`, r.parcial, r.extra].filter(Boolean).join('\n'));
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
      const enviar = async (texto) => guardarEnviada(await sock.sendMessage(a.jid, { text: marcaServico('Agendado', texto), mentions: mencoesDoTexto(texto, await metadadosGrupo(a.jid).catch(() => null)) }));
      try {
        let texto = a.mensagem || '';
        if (a.admin) {
          const r = await executarAdmin(a.admin, { jid: a.jid, ctx: null, imagens: [], outrosMarcados: [] });
          log(`Agendado (de ${a.pedidoPor}): ${a.admin.acao} feito (${r.detalhe}).`);
          texto = [texto || `Na hora marcada: ${a.descricao}: feito.`, r.parcial, r.extra].filter(Boolean).join('\n');
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

  async function aplicarRegras(m, jid, meta) {
    const c = conteudo(m);
    const tipo = tipoDaMensagem(c);
    if (!tipo) return false;
    const autor = m.pushName || digitos(m.key.participant || '');
    const texto = textoDa(m);
    const disparadas = regras.disparadas({
      jid, tipo, texto, autorNome: autor,
      autorIds: [m.key.participant, m.key.participantAlt].filter(Boolean).map(jidNormalizedUser),
    });
    if (!disparadas.length) return false;
    jaRespondidas.add(m.key.id);

    for (const regra of disparadas.slice(0, 2)) {
      log(`Regra ${regra.id} disparada por ${autor}: ${regra.descricao}`);
      const executar = async () => {
        const { tipo: acao, conteudo: arg } = regra.acao;
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
        if (!isJidGroup(jid)) continue;
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
