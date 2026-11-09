// Edições de mensagem no formato novo do WhatsApp (secretEncryptedMessage, MESSAGE_EDIT), que o Baileys
// ainda não decifra. A chave sai do "messageSecret" da mensagem ORIGINAL (que chega junto com ela), igual
// aos votos de enquete: HKDF-SHA256(segredo, id original + autor original + quem editou + caso de uso)
// e o conteúdo novo vem em AES-256-GCM.
import crypto from 'node:crypto';
import { jidNormalizedUser, proto } from 'baileys';

const segredos = new Map(); // id da mensagem -> { segredo, autores: [jid...] }
const MAX = 2000;

/** Guarda o segredo de cada mensagem recebida (só existe em memória; reiniciar esquece). */
export function guardarSegredo(m) {
  const segredo = m.message?.messageContextInfo?.messageSecret;
  if (!segredo?.length || !m.key?.id) return;
  const autores = [m.key.participant, m.key.participantAlt].filter(Boolean).map(jidNormalizedUser);
  segredos.set(m.key.id, { segredo: Buffer.from(segredo), autores });
  if (segredos.size > MAX) segredos.delete(segredos.keys().next().value);
}

function chave(segredo, info) {
  const k0 = crypto.createHmac('sha256', Buffer.alloc(32)).update(segredo).digest();
  return crypto.createHmac('sha256', k0).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
}

function abrirGcm(chave32, iv, dados, aad) {
  const tag = dados.subarray(dados.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', chave32, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(dados.subarray(0, dados.length - 16)), d.final()]);
}

/**
 * Se a mensagem é uma edição criptografada, devolve { id original, message: conteúdo novo }.
 * Devolve { id, erro } quando é edição mas não deu para abrir (ex: original chegou antes do bot ligar).
 */
export function decifrarEdicao(m, buscarOriginal = null) {
  const s = m.message?.secretEncryptedMessage;
  if (!s || Number(s.secretEncType) !== proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT) return null;
  const id = s.targetMessageKey?.id;
  if (!id) return null;
  const original = segredos.get(id) || buscarOriginal?.(id);
  if (!original) return { id, erro: 'não vi a mensagem original (chegou antes do bot ligar?)' };
  const editores = [m.key.participant, m.key.participantAlt].filter(Boolean).map(jidNormalizedUser);
  const payload = Buffer.from(s.encPayload);
  const iv = Buffer.from(s.encIv);
  // O WhatsApp pode usar o JID de telefone ou o LID de cada um: testa as combinações (o GCM confirma a certa).
  for (const autor of original.autores) {
    for (const editor of editores.length ? editores : original.autores) {
      for (const uso of ['Message Edit', 'Edit']) {
        const k = chave(original.segredo, `${id}${autor}${editor}${uso}`);
        for (const aad of [null, Buffer.from(`${id}\u0000${editor}`)]) {
          try {
            const msg = proto.Message.decode(abrirGcm(k, iv, payload, aad));
            const p = msg.protocolMessage;
            return { id, message: p?.editedMessage || msg };
          } catch { /* combinação errada: tenta a próxima */ }
        }
      }
    }
  }
  return { id, erro: 'não consegui decifrar a edição' };
}

// Só para teste: cifra do mesmo jeito (prova que decifrar faz o caminho inverso).
export function _cifrarParaTeste({ id, autor, editor, segredo, message }) {
  const k = chave(segredo, `${id}${autor}${editor}Message Edit`);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const dados = Buffer.concat([c.update(proto.Message.encode(message).finish()), c.final(), c.getAuthTag()]);
  return { encPayload: dados, encIv: iv };
}
