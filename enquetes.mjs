// Enquetes criadas pelo bot, com ação opcional quando aprovadas (ex: remover alguém se a maioria
// do grupo votar "Sim"). Os votos chegam criptografados (pollUpdateMessage) e esta versão do Baileys
// não os abre sozinha: a chave sai do messageSecret da enquete, que o bot mesmo gera e guarda aqui.
// Tudo fica em .enquetes.json, então reiniciar o bot não perde enquete nem voto.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptPollVote, jidNormalizedUser } from 'baileys';

const ARQ = path.join(path.dirname(fileURLToPath(import.meta.url)), '.enquetes.json');
let enquetes = {};
try { enquetes = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { /* nenhuma ainda */ }
const salvar = () => { try { fs.writeFileSync(ARQ, JSON.stringify(enquetes, null, 1)); } catch { /* tenta na próxima */ } };

const hash = (opcao) => crypto.createHash('sha256').update(Buffer.from(opcao)).digest('hex');

/** Segredo novo para a enquete (vai no sock.sendMessage({ poll: { messageSecret } })). */
export const novoSegredo = () => crypto.randomBytes(32);

/**
 * Registra a enquete que o bot acabou de mandar.
 * @param {object} e { id, jid, pergunta, opcoes, segredo (Buffer), criadores (jids do bot),
 *   acao (admin ou null), opcaoAprova, regra ('maioria_do_grupo'|'maioria_dos_votos'), limite, expiraEm, pedidoPor }
 */
export function registrarEnquete(e) {
  enquetes[e.id] = { ...e, segredo: Buffer.from(e.segredo).toString('base64'), votos: {}, encerrada: false, criadaEm: Date.now() };
  salvar();
}

export const enquete = (id) => enquetes[id] || null;
export const enquetesAbertas = () => Object.values(enquetes).filter((e) => !e.encerrada);

export function encerrar(id, resultado) {
  if (!enquetes[id]) return;
  enquetes[id].encerrada = true;
  enquetes[id].resultado = resultado;
  salvar();
  // Guarda só as últimas 50 encerradas.
  const velhas = Object.values(enquetes).filter((e) => e.encerrada).sort((a, b) => a.criadaEm - b.criadaEm);
  for (const e of velhas.slice(0, Math.max(0, velhas.length - 50))) delete enquetes[e.id];
}

/**
 * Se `m` é um voto numa enquete do bot, decifra e guarda o voto (o último de cada pessoa vale).
 * Devolve a enquete atualizada, ou null se não é voto numa enquete conhecida.
 */
export function registrarVoto(m) {
  const pu = m.message?.pollUpdateMessage;
  if (!pu?.vote) return null;
  const e = enquetes[pu.pollCreationMessageKey?.id];
  if (!e || e.encerrada) return null;
  const segredo = Buffer.from(e.segredo, 'base64');
  // O voto é cifrado com os ids (LID ou número) de quem criou e de quem votou: tenta as combinações.
  const votantes = [m.key.participant, m.key.participantAlt].filter(Boolean).map(jidNormalizedUser);
  let voto = null;
  for (const criador of e.criadores) {
    for (const v of votantes) {
      try {
        voto = decryptPollVote(pu.vote, { pollEncKey: segredo, pollCreatorJid: criador, pollMsgId: e.id, voterJid: v });
        break;
      } catch { /* próxima combinação */ }
    }
    if (voto) break;
  }
  if (!voto) return { ...e, erro: 'não deu para abrir o voto' };
  const porHash = Object.fromEntries(e.opcoes.map((o) => [hash(o), o]));
  const escolhas = (voto.selectedOptions || []).map((h) => porHash[Buffer.from(h).toString('hex')]).filter(Boolean);
  // Um voto por pessoa, guardado pelo id dela (LID e número apontam para a mesma pessoa).
  const chave = votantes[0];
  e.votos[chave] = { escolhas, em: Date.now(), ids: votantes };
  salvar();
  return e;
}

/** Contagem: { opcao: nº de votos }, mais o total de pessoas que votaram. */
export function contagem(e) {
  const c = Object.fromEntries(e.opcoes.map((o) => [o, 0]));
  let pessoas = 0;
  for (const { escolhas } of Object.values(e.votos)) {
    if (escolhas.length) pessoas++;
    for (const o of escolhas) c[o] = (c[o] || 0) + 1;
  }
  return { c, pessoas };
}
