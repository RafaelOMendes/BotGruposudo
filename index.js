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

async function ehDoGabriel(msg) {
  const contato = await msg.getContact();
  if (CONFIG.numero) return contato.number === CONFIG.numero;
  const alvo = normalizar(CONFIG.remetente);
  return [contato.name, contato.pushname, contato.shortName]
    .some((n) => normalizar(n) === alvo || normalizar(n).startsWith(alvo));
}

client.on('message', async (msg) => {
  try {
    if (msg.body.trim() !== CONFIG.gatilho) return;

    const chat = await msg.getChat();
    if (!chat.isGroup || normalizar(chat.name) !== normalizar(CONFIG.grupo)) return;
    if (!(await ehDoGabriel(msg))) return;

    await chat.sendMessage(audio, { sendAudioAsVoice: true, quotedMessageId: msg.id._serialized });
    log('Áudio enviado em resposta ao "?" do Gabriel.');
  } catch (err) {
    log('Erro ao processar mensagem:', err.stack || err);
  }
});

process.on('unhandledRejection', (err) => log('unhandledRejection:', err?.stack || err));

client.initialize();
