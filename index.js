// Bot do Gabreu: quando o Gabriel Lassen manda "?" no grupo Gruposudo,
// responde com o áudio em audio/gabreu.ogg (como mensagem de voz).

const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const CONFIG = {
  grupo: process.env.BOT_GRUPO || 'Gruposudo',
  remetente: process.env.BOT_REMETENTE || 'Gabriel Lassen',
  // Opcional: número do Gabriel (só dígitos, ex: 5511999999999) — mais confiável que o nome.
  numero: process.env.BOT_NUMERO || '',
  gatilho: '?',
  audio: path.join(__dirname, 'audio', 'gabreu.ogg'),
  chrome: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};

const LOG_FILE = path.join(__dirname, 'bot.log');
function log(...args) {
  const line = `[${new Date().toLocaleString('pt-BR')}] ${args.join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

const normalizar = (s) =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    executablePath: CONFIG.chrome,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

const audio = MessageMedia.fromFilePath(CONFIG.audio);

client.on('qr', (qr) => {
  log('Escaneie o QR code abaixo no WhatsApp (Aparelhos conectados):');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => log('Autenticado.'));
client.on('auth_failure', (m) => log('Falha na autenticação:', m));
client.on('ready', () => log(`Bot pronto. Ouvindo "${CONFIG.gatilho}" de ${CONFIG.remetente} em ${CONFIG.grupo}.`));
client.on('disconnected', (motivo) => {
  log('Desconectado:', motivo, '— reiniciando em 10s.');
  setTimeout(() => process.exit(1), 10_000); // o start.cmd reinicia
});

// msg.getChat()/getContact() da whatsapp-web.js quebraram com o WhatsApp Web atual
// ("r: r" em getChatModel). Então lemos os dados direto das coleções da página.
async function infoDaPagina(chatId, autorId) {
  return client.pupPage.evaluate((chatId, autorId) => {
    const { Chat, Contact } = window.require('WAWebCollections');
    const chat = Chat.get(chatId);
    const contato = autorId ? Contact.get(autorId) : null;
    return {
      grupo: chat?.formattedTitle || chat?.name || chat?.groupMetadata?.subject || '',
      nomes: contato ? [contato.name, contato.pushname, contato.verifiedName, contato.shortName] : [],
      numero: contato?.phoneNumber?.user || contato?.id?.user || '',
    };
  }, chatId, autorId);
}

function bateNome(nomes) {
  const alvo = normalizar(CONFIG.remetente);
  return nomes.some((n) => n && (normalizar(n) === alvo || normalizar(n).startsWith(alvo)));
}

async function ehGatilho(msg) {
  if ((msg.body || '').trim() !== CONFIG.gatilho) return false;
  if (!msg.from.endsWith('@g.us') || msg.fromMe) return false;

  const info = await infoDaPagina(msg.from, msg.author);
  if (normalizar(info.grupo) !== normalizar(CONFIG.grupo)) return false;

  const nomes = [...info.nomes, msg._data?.notifyName];
  if (CONFIG.numero) return info.numero === CONFIG.numero || (msg.author || '').startsWith(CONFIG.numero);
  return bateNome(nomes);
}

// sendSeen da whatsapp-web.js quebra no WhatsApp Web atual ("must include an id property"),
// então fica desligado. Se mesmo assim falhar, tenta variações mais simples.
async function responder(chatId, msgId) {
  const tentativas = [
    { nome: 'voz citando', opts: { sendAudioAsVoice: true, quotedMessageId: msgId, ignoreQuoteErrors: true } },
    { nome: 'voz', opts: { sendAudioAsVoice: true } },
    { nome: 'áudio', opts: {} },
  ];
  for (const t of tentativas) {
    try {
      await client.sendMessage(chatId, audio, { sendSeen: false, ...t.opts });
      log(`Áudio enviado em resposta ao "?" do Gabriel (${t.nome}).`);
      return;
    } catch (err) {
      log(`Falhou enviando (${t.nome}):`, err.message);
    }
  }
  throw new Error('Nenhuma forma de envio funcionou.');
}

client.on('message', async (msg) => {
  try {
    if (await ehGatilho(msg)) await responder(msg.from, msg.id._serialized);
  } catch (err) {
    log('Erro ao processar mensagem:', err.stack || err);
  }
});

// Ao ligar: se o último "?" do Gabriel no grupo ainda não teve resposta minha, responde.
async function responderPendente() {
  const pendente = await client.pupPage.evaluate((grupo, gatilho) => {
    const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const { Chat } = window.require('WAWebCollections');
    const chat = Chat.getModelsArray().find(
      (c) => c.id?.server === 'g.us' && norm(c.formattedTitle || c.name) === norm(grupo)
    );
    if (!chat) return null;
    const msgs = chat.msgs.getModelsArray().slice(-30);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.id.fromMe) return null; // já falei depois
      if ((m.body || '').trim() === gatilho) {
        const autor = m.author?._serialized || m.id.participant?._serialized;
        return { chatId: chat.id._serialized, msgId: m.id._serialized, autor, notifyName: m.notifyName, t: m.t };
      }
    }
    return null;
  }, CONFIG.grupo, CONFIG.gatilho);

  if (!pendente) return;
  if (Date.now() / 1000 - pendente.t > 6 * 3600) return; // ignora "?" com mais de 6h
  const info = await infoDaPagina(pendente.chatId, pendente.autor);
  const ok = CONFIG.numero
    ? info.numero === CONFIG.numero
    : bateNome([...info.nomes, pendente.notifyName]);
  if (ok) {
    log('Encontrei um "?" pendente do Gabriel, respondendo...');
    await responder(pendente.chatId, pendente.msgId);
  }
}

client.on('ready', () => {
  setTimeout(() => responderPendente().catch((e) => log('Erro no pendente:', e.stack || e)), 5000);
});

process.on('unhandledRejection', (err) => log('unhandledRejection:', err?.stack || err));

client.initialize().catch((err) => {
  if (/already running/i.test(err.message)) {
    log('Já existe outra instância do bot rodando; saindo.');
    process.exit(2); // start.cmd não reinicia com código 2
  }
  log('Falha ao iniciar:', err.stack || err);
  process.exit(1);
});
