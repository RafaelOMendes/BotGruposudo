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
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidNormalizedUser,
  useMultiFileAuthState,
} from 'baileys';
import { avaliarNonsense, configurarModelos, iniciarIA, interpretarMencao, memeDeRegra, respostaDeRegra } from './ia.mjs';
import { catalogoParaPrompt, figurinhaDeImagem, figurinhaDeMeme, figurinhaDeTexto } from './memes.mjs';
import { Regras } from './regras.mjs';
import { configurarGerador, desligarGerador, disponivel as temGerador, gerarImagem } from './gerador.mjs';
import { baixarImagemDaWeb, ehSiteDeVideo, iniciarDownloads, prepararAnexo, temDownloaderDeVideo } from './web.mjs';

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
    pasta: local.gerador?.pasta || 'D:/IA/ComfyUI_windows_portable',
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
    historico: local.mencao?.historico ?? 8,
    // Quando pedem para ler/resumir a conversa ("lê aí", "o que o fulano falou?"), vai até este tanto.
    historicoLeitura: local.mencao?.historicoLeitura ?? 60,
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
      log(`Modelos: ${Object.entries(modelos).map(([t, m]) => `${t}=${m.modelo.replace('claude-', '')}/${m.esforco}`).join(', ')}.`);
      log(`Gerador de imagem (ComfyUI): ${geradorOk ? `pronto em ${CONFIG.gerador.pasta}` : 'desligado/não instalado'}.`);
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
    // Respondeu (função "responder" do WhatsApp) uma mensagem do bot: conta como falar com ele.
    if (ctx?.stanzaId && ctx?.participant && eu.includes(jidNormalizedUser(ctx.participant))) return true;
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

    const { hist, leituraPedida } = historicoPara(jid, pedido);
    log(`${autor} marcou o bot: "${pedido.slice(0, 80)}"${imagens.length ? ` (+${imagens.length} imagem)` : ''}${leituraPedida ? ` (lendo ${hist.length} mensagens)` : ''}`);

    // Pessoas marcadas na mensagem (fora o bot): viram os IDs do remetente se a pessoa criar uma regra.
    const outrosMarcados = (ctx?.mentionedJid || []).map(jidNormalizedUser).filter((j) => !meusIds().includes(j));

    const respondeuBot = !!(ctx?.participant && meusIds().includes(jidNormalizedUser(ctx.participant)));

    const tarefa = async () => {
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      let resposta;
      let anexos = [];
      let figurinhaPronta = null;
      let servico = null; // quando o bot fez um serviço (não só respondeu), a mensagem leva uma marca
      try {
        const v = await interpretarMencao({
          grupo: meta.subject, historico: hist, leituraPedida, autor, pedido, citada, imagens, regras: regras.resumo(jid),
          temVideo: temDownloaderDeVideo(), respondeuBot, catalogo: await catalogoParaPrompt(), temGerador: !!geradorOk && temGerador(),
          pessoas: pessoasParaPrompt(jid),
        });
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

        // Imagem gerada pela IA local (ComfyUI).
        if (v.acao === 'responder' && v.imagem_gerada?.fazer && v.imagem_gerada.prompt) {
          if (!geradorOk || !temGerador()) resposta = 'O gerador de imagem tá desligado agora.';
          else {
            try {
              await sock.sendPresenceUpdate('composing', jid).catch(() => {});
              const png = await gerarImagem(v.imagem_gerada.prompt, { formato: v.imagem_gerada.formato });
              anexos.push({ url: '', gerada: png });
              servico = 'Imagem gerada';
              log(`Imagem gerada para ${autor}: "${v.imagem_gerada.prompt.slice(0, 80)}"`);
            } catch (e) {
              log(`Não deu para gerar a imagem (${e.message}).`);
              resposta = `Não consegui gerar a imagem: ${e.message}.`;
            }
          }
        }

        // Figurinha pedida (de imagem mandada, da web, de meme, só texto ou gerada pela IA).
        if (v.acao === 'responder' && v.figurinha?.fazer) {
          try {
            figurinhaPronta = await montarFigurinha(v.figurinha, imagens);
            servico = 'Figurinha';
            log(`Figurinha (${v.figurinha.origem}) feita para ${autor}.`);
          } catch (e) {
            log(`Não deu para fazer a figurinha (${e.message}).`);
            resposta = `Não consegui fazer a figurinha: ${e.message}.`;
          }
        }

        // Baixa o que o Claude pediu para mandar (com as travas de segurança do web.mjs).
        const prontos = [];
        const falhas = [];
        for (const a of anexos) {
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
      } else if (resposta) guardarEnviada(await sock.sendMessage(jid, { text: resposta, mentions }, { quoted: m }));
      for (const [i, anexo] of anexos.entries()) {
        guardarEnviada(await sock.sendMessage(jid, anexo, i === 0 ? { quoted: m } : {}));
      }
      if (figurinhaPronta) guardarEnviada(await sock.sendMessage(jid, { sticker: figurinhaPronta }, { quoted: m }));
      registrar(jid, 'Bot', resposta || '[anexo]');
      log(`Respondi ${autor}: "${(resposta || '').slice(0, 80).replace(/\n/g, ' ')}"${anexos.length ? ` + ${anexos.length} anexo(s)` : ''}${figurinhaPronta ? ' + figurinha' : ''}`);
    };
    filaClaude = filaClaude.then(tarefa).catch((e) => log('Erro ao responder marcação:', e.stack || e));
  }

  // ---------- marcar pessoas ----------
  // Nomes vistos no grupo (nome de perfil), para o Claude saber como marcar cada um.
  const conhecidos = new Map(); // grupo -> Map(id -> nome)
  function lembrarPessoa(jid, m) {
    if (m.key.fromMe || !m.pushName) return;
    const mapa = conhecidos.get(jid) || new Map();
    for (const id of [m.key.participant, m.key.participantAlt].filter(Boolean)) mapa.set(digitos(jidNormalizedUser(id)), m.pushName);
    conhecidos.set(jid, mapa);
  }
  function pessoasParaPrompt(jid) {
    return [...(conhecidos.get(jid) || new Map())].map(([id, nome]) => `${nome} = @${id}`).join('\n');
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

  // Serviço (baixar, fazer figurinha, criar regra...) leva uma marca no topo; resposta comum não.
  function marcaServico(nome, texto) {
    const corpo = String(texto || '').trim();
    return `🤖 *Serviço: ${nome}*${corpo ? `\n${corpo}` : ''}`;
  }

  async function montarFigurinha(f, imagens) {
    const textos = { cima: f.texto_cima || '', baixo: f.texto_baixo || '' };
    if (f.origem === 'imagem') {
      if (!imagens.length) throw new Error('não veio imagem junto; manda a imagem (ou responde ela) pedindo a figurinha');
      return figurinhaDeImagem(imagens[0], { ...textos, recorte: f.recorte });
    }
    if (f.origem === 'web') {
      if (!f.url) throw new Error('não achei imagem para usar');
      return figurinhaDeImagem(await baixarImagemDaWeb(f.url), { ...textos, recorte: f.recorte });
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
          const hist = (historicos.get(jid) || []).slice(0, -1).slice(-CONFIG.mencao.historico);
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
  const horaBrasil = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  function registrar(jid, nome, texto) {
    if (!texto) return;
    const lista = historicos.get(jid) || [];
    lista.push(`[${horaBrasil()}] ${nome}: ${texto.replace(/\s+/g, ' ').slice(0, 500)}`);
    while (lista.length > CONFIG.mencao.historicoLeitura + 1) lista.shift();
    historicos.set(jid, lista);
  }

  // Pedidos do tipo "lê aí", "resume a conversa", "o que o fulano falou?" liberam o histórico longo.
  // (testado no texto sem acentos, porque o \b do regex não entende letra acentuada)
  const PEDE_LEITURA = /\b(le|ler|leia|leu|resum\w*|o que (o|a)?\s*\w*\s*(falou|disse|mandou|quis dizer)|que (ele|ela|eles|elas) (falou|disse|falaram|disseram)|conversa|historico|mensagens? (de )?(cima|antes|anterior\w*)|la em cima|acima|contexto|do que (voces|vcs|eles|elas) (estao|tao) falando)\b/i;

  function historicoPara(jid, pedido) {
    const tudo = (historicos.get(jid) || []).slice(0, -1); // a própria mensagem vai separada
    const leituraPedida = PEDE_LEITURA.test(normalizar(pedido));
    return { hist: leituraPedida ? tudo : tudo.slice(-CONFIG.mencao.historico), leituraPedida };
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // 'append' = histórico sincronizado
    for (const m of messages) {
      try {
        const jid = m.key.remoteJid;
        if (!isJidGroup(jid)) continue;
        registrar(jid, m.key.fromMe ? 'Bot' : m.pushName || digitos(m.key.participant || ''), resumo(conteudo(m)));
        lembrarPessoa(jid, m);
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
