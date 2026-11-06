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
import { avaliarNonsense, iniciarIA, interpretarMencao, memeDeRegra, respostaDeRegra } from './ia.mjs';
import { catalogoParaPrompt, figurinhaDeMeme } from './memes.mjs';
import { Regras } from './regras.mjs';
import { ehSiteDeVideo, iniciarDownloads, prepararAnexo, temDownloaderDeVideo } from './web.mjs';

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
    historico: local.mencao?.historico ?? 20,
  },
};

// ---------- log ----------
const LOG_FILE = path.join(DIR, 'bot.log');
function log(...args) {
  const line = `[${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] ${args.join(' ')}`;
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
const regras = new Regras(DIR); // regras criadas pelo grupo (regras.json)
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
      for (const [tipo, r] of Object.entries(respostas)) if (!r.buffer) log(`Figurinha de resposta não encontrada em ${r.arquivo}; resposta a ${tipo} desligada.`);
      log(`Figurinhas de ${CONFIG.figurinha.remetente}: ${ia ? 'IA decide se é non-sense' : `claude CLI não encontrado, responde com chance ${CONFIG.figurinha.chanceSemIA}`}.`);
      const ids = [sock.user?.id, sock.user?.lid].filter(Boolean).map((j) => '…' + jidNormalizedUser(j).split('@')[0].slice(-4) + '@' + j.split('@')[1]);
      log(`Downloads: yt-dlp ${downloads.ytdlp ? 'ok' : 'não encontrado (vídeos de sites viram link)'}, ffmpeg ${downloads.ffmpeg ? 'ok' : 'não encontrado (GIF vira figurinha)'}, cookies ${downloads.cookies ? 'ok' : 'sem (Instagram/Reddit privados podem falhar)'}.`);
      log(`Marcações (@) da conta ${ids.join(' / ')}: ${CONFIG.mencao.ativo && ia ? 'o Claude responde' : 'desligadas'}.`);
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
    if (!tipo || !respostas[tipo].buffer) return;
    if (!ehDe(m, CONFIG.figurinha)) return;

    const quem = `${m.pushName || CONFIG.figurinha.remetente} (${m.key.participant})`;
    if (Date.now() - ultimaFigurinha < CONFIG.figurinha.intervaloSeg * 1000) {
      log(`${tipo} de ${quem}, mas ainda no intervalo mínimo; ignorada.`);
      return;
    }

    let veredito;
    if (ia) {
      const buffer = await baixar(m);
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
        guardarEnviada(await sock.sendMessage(jid, { sticker: meme }, { quoted: m }));
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
    const texto = textoDa(m);
    return eu.some((id) => texto.includes('@' + digitos(id)));
  }

  async function baixar(msg) {
    return downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  }

  let filaClaude = Promise.resolve(); // uma pergunta por vez para o claude
  const ultimaMencao = new Map(); // autor -> timestamp

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
    if (c.imageMessage || c.stickerMessage) imagens.push(await baixar(m));

    let citada = '';
    if (ctx?.quotedMessage) {
      const q = ctx.quotedMessage;
      const quemCitado = ctx.participant && meusIds().includes(jidNormalizedUser(ctx.participant)) ? 'você (o bot)' : 'alguém do grupo';
      citada = `${quemCitado}: ${resumo(q) || '[mensagem]'}`;
      if (q.imageMessage || q.stickerMessage) {
        try {
          imagens.push(await baixar({ key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: q }));
        } catch (e) {
          log('Não deu para baixar a imagem citada:', e.message);
        }
      }
    }

    const hist = (historicos.get(jid) || []).slice(0, -1); // a própria mensagem vai separada
    log(`${autor} marcou o bot: "${pedido.slice(0, 80)}"${imagens.length ? ` (+${imagens.length} imagem)` : ''}`);

    // Pessoas marcadas na mensagem (fora o bot): viram os IDs do remetente se a pessoa criar uma regra.
    const outrosMarcados = (ctx?.mentionedJid || []).map(jidNormalizedUser).filter((j) => !meusIds().includes(j));

    const tarefa = async () => {
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      let resposta;
      let anexos = [];
      try {
        const v = await interpretarMencao({
          grupo: meta.subject, historico: hist, autor, pedido, citada, imagens, regras: regras.resumo(jid),
          temVideo: temDownloaderDeVideo(),
        });
        resposta = v.texto;
        if (v.acao === 'responder' && Array.isArray(v.anexos)) anexos = v.anexos.filter((a) => a?.url).slice(0, 3);
        if (v.acao === 'criar_regra') {
          const remetente = { nome: v.regra_remetente || '', ids: v.regra_remetente ? outrosMarcados : [] };
          const r = regras.criar(jid, v, remetente, autor);
          if (r.ok) log(`Regra ${r.regra.id} criada por ${autor}: ${r.regra.descricao}`);
          else {
            log(`Regra recusada (${r.erro}) pedida por ${autor}.`);
            resposta = `Não criei essa regra: ${r.erro}.`;
          }
        } else if (v.acao === 'apagar_regra') {
          const ok = regras.apagar(jid, v.regra_apagar_id);
          log(`Regra ${v.regra_apagar_id} ${ok ? 'apagada' : 'não encontrada'} (pedido de ${autor}).`);
          if (!ok) resposta = `Não achei a regra "${v.regra_apagar_id}".`;
        }

        // Baixa o que o Claude pediu para mandar (com as travas de segurança do web.mjs).
        const prontos = [];
        const falhas = [];
        for (const a of anexos) {
          try {
            prontos.push(await prepararAnexo(a, ''));
            log(`Baixei ${a.tipo}: ${a.url}`);
          } catch (e) {
            log(`Não deu para baixar ${a.tipo} (${e.message}): ${a.url}`);
            falhas.push(`${a.url} (${e.message})`);
          }
        }
        anexos = prontos;
        if (falhas.length) resposta = `${resposta || ''}\n\nNão consegui baixar:\n${falhas.map((f) => '- ' + f).join('\n')}`.trim();
      } catch (e) {
        log('Erro ao perguntar ao claude:', e.message);
        resposta = 'Travei aqui, tenta de novo daqui a pouco.';
        anexos = [];
      } finally {
        await sock.sendPresenceUpdate('paused', jid).catch(() => {});
      }
      if (!resposta && !anexos.length) return;

      // Se o primeiro anexo aceita legenda, o texto vai nele; senão vai antes, numa mensagem própria.
      if (anexos.length && 'caption' in anexos[0] && resposta && resposta.length <= 1000) anexos[0].caption = resposta;
      else if (resposta) guardarEnviada(await sock.sendMessage(jid, { text: resposta }, { quoted: m }));
      for (const [i, anexo] of anexos.entries()) {
        guardarEnviada(await sock.sendMessage(jid, anexo, i === 0 ? { quoted: m } : {}));
      }
      registrar(jid, 'Bot', resposta || '[anexo]');
      log(`Respondi ${autor}: "${(resposta || '').slice(0, 80).replace(/\n/g, ' ')}"${anexos.length ? ` + ${anexos.length} anexo(s)` : ''}`);
    };
    filaClaude = filaClaude.then(tarefa).catch((e) => log('Erro ao responder marcação:', e.stack || e));
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
          const anexo = await prepararAnexo({ url, tipo: 'video', nome: '' }, '');
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
          const hist = (historicos.get(jid) || []).slice(0, -1);
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

  // Histórico curto por grupo (só em memória), usado como contexto para o Claude.
  const historicos = new Map();
  function registrar(jid, nome, texto) {
    if (!texto) return;
    const lista = historicos.get(jid) || [];
    lista.push(`${nome}: ${texto.replace(/\s+/g, ' ').slice(0, 500)}`);
    while (lista.length > CONFIG.mencao.historico + 1) lista.shift();
    historicos.set(jid, lista);
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // 'append' = histórico sincronizado
    for (const m of messages) {
      try {
        const jid = m.key.remoteJid;
        if (!isJidGroup(jid)) continue;
        registrar(jid, m.key.fromMe ? 'Bot' : m.pushName || digitos(m.key.participant || ''), resumo(conteudo(m)));
        if (m.key.fromMe || jaRespondidas.has(m.key.id)) continue;

        const idade = Date.now() / 1000 - Number(m.messageTimestamp || 0);
        if (idade > CONFIG.idadeMaxSeg) continue;

        const meta = await metadadosGrupo(jid);

        if (CONFIG.mencao.ativo && ia && meMarcaram(m)) {
          await responderMarcacao(m, jid, meta);
          continue;
        }

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
}

process.on('unhandledRejection', (err) => log('unhandledRejection:', err?.stack || err));
iniciar().catch((err) => {
  log('Falha ao iniciar:', err.stack || err);
  process.exit(1);
});
