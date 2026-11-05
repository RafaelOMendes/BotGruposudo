// Bot do Gabreu, no grupo configurado:
//  1. Gabriel manda uma mensagem só de interrogações ("?", "??", "????"...) → responde com o
//     áudio em audio/gabreu.ogg (mensagem de voz).
//  2. Nicolas manda figurinha ou imagem → o Claude (via `claude -p`, sem chave de API) decide se é non-sense; se for, responde
//     com a figurinha em figurinhas/manda-figurinha.webp.
//
// Usa Baileys (protocolo do WhatsApp direto, sem navegador). Os pedidos de reenvio que o
// iPhone faz quando não consegue descriptografar ("Aguardando mensagem") são atendidos via getMessage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import NodeCache from '@cacheable/node-cache';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidNormalizedUser,
  useMultiFileAuthState,
} from 'baileys';
import { ehNonsense, iniciarIA } from './ia.mjs';

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
    arquivo: path.join(DIR, local.figurinha?.arquivo || 'figurinhas/manda-figurinha.webp'),
    // Intervalo mínimo entre respostas (evita spam e gasto com a IA).
    intervaloSeg: local.figurinha?.intervaloSeg ?? 60,
    // Se o `claude` não estiver disponível: chance de responder mesmo assim (1 = sempre, 0 = nunca).
    chanceSemIA: local.figurinha?.chanceSemIA ?? 1,
  },
  // Caminho do Claude Code CLI (já logado). Padrão: `claude` no PATH.
  claude: process.env.CLAUDE_CLI_PATH || local.claude || 'claude',
};

// ---------- log ----------
const LOG_FILE = path.join(DIR, 'bot.log');
function log(...args) {
  const line = `[${new Date().toLocaleString('pt-BR')}] ${args.join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}
const logger = pino({ level: 'silent' });

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

const textoDa = (m) =>
  m.message?.conversation ||
  m.message?.extendedTextMessage?.text ||
  m.message?.ephemeralMessage?.message?.conversation ||
  m.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
  '';

const audio = fs.readFileSync(CONFIG.audio);
const figurinha = fs.existsSync(CONFIG.figurinha.arquivo) ? fs.readFileSync(CONFIG.figurinha.arquivo) : null;
const ia = await iniciarIA(CONFIG.claude);

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
  if (!msg?.key?.id) return;
  enviadas.set(msg.key.id, msg.message);
  if (enviadas.size > 200) enviadas.delete(enviadas.keys().next().value);
}

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

// ---------- conexão ----------
async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DIR, '.baileys_auth'));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.windows('Bot do Gabreu'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    msgRetryCounterCache,
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
    getMessage: async (key) => enviadas.get(key.id),
  });

  sock.ev.on('creds.update', saveCreds);

  async function metadadosGrupo(jid) {
    let meta = groupCache.get(jid);
    if (!meta) {
      meta = await sock.groupMetadata(jid);
      groupCache.set(jid, meta);
    }
    return meta;
  }
  sock.ev.on('groups.update', (updates) => updates.forEach((u) => groupCache.del(u.id)));
  sock.ev.on('group-participants.update', (u) => groupCache.del(u.id));

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      log('Escaneie o QR code abaixo no WhatsApp (Aparelhos conectados > Conectar aparelho):');
      qrcode.generate(qr, { small: true });
      mostrarQr(qr).catch((e) => log('Erro ao gerar imagem do QR:', e.message));
    }
    if (connection === 'open') {
      fecharQr();
      log(`Bot pronto. Ouvindo "?" de ${CONFIG.remetente} em ${CONFIG.grupo}.`);
      if (!figurinha) log(`Figurinha não encontrada em ${CONFIG.figurinha.arquivo}; resposta a figurinhas desligada.`);
      else log(`Figurinhas de ${CONFIG.figurinha.remetente}: ${ia ? 'IA decide se é non-sense' : `claude CLI não encontrado, responde com chance ${CONFIG.figurinha.chanceSemIA}`}.`);
    }
    if (connection === 'close') {
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
    if (!tipo || !figurinha) return;
    if (!ehDe(m, CONFIG.figurinha)) return;

    const quem = `${m.pushName || CONFIG.figurinha.remetente} (${m.key.participant})`;
    if (Date.now() - ultimaFigurinha < CONFIG.figurinha.intervaloSeg * 1000) {
      log(`${tipo} de ${quem}, mas ainda no intervalo mínimo; ignorada.`);
      return;
    }

    let veredito;
    if (ia) {
      const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      veredito = await ehNonsense(buffer);
    } else {
      veredito = { nonsense: Math.random() < CONFIG.figurinha.chanceSemIA, motivo: 'sem claude CLI' };
    }
    log(`${tipo} de ${quem}: ${veredito.nonsense ? 'NON-SENSE' : 'normal'} — ${veredito.motivo}`);
    if (!veredito.nonsense) return;

    ultimaFigurinha = Date.now();
    jaRespondidas.add(m.key.id);
    const enviada = await sock.sendMessage(jid, { sticker: figurinha }, { quoted: m });
    guardarEnviada(enviada);
    log(`Figurinha "manda figurinha" enviada em resposta a ${quem}.`);
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // 'append' = histórico sincronizado
    for (const m of messages) {
      try {
        const jid = m.key.remoteJid;
        if (m.key.fromMe || !isJidGroup(jid) || jaRespondidas.has(m.key.id)) continue;

        const idade = Date.now() / 1000 - Number(m.messageTimestamp || 0);
        if (idade > CONFIG.idadeMaxSeg) continue;

        const meta = await metadadosGrupo(jid);
        if (normalizar(meta.subject) !== normalizar(CONFIG.grupo)) continue;

        await responderInterrogacao(m, jid);
        await responderFigurinha(m, jid);
      } catch (err) {
        log('Erro ao processar mensagem:', err.stack || err);
      }
    }
  });
}

process.on('unhandledRejection', (err) => log('unhandledRejection:', err?.stack || err));
iniciar().catch((err) => {
  log('Falha ao iniciar:', err.stack || err);
  process.exit(1);
});
