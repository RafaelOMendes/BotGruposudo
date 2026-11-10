// Ações com timer ("adiciona o Nicolas de volta em 10 min", "me lembra em 1 hora"): ficam em
// .agendadas.json até a hora chegar, então reiniciar o bot não perde nenhuma.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARQ = path.join(path.dirname(fileURLToPath(import.meta.url)), '.agendadas.json');
let agendadas = [];
try { agendadas = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { /* nenhuma ainda */ }
const salvar = () => { try { fs.writeFileSync(ARQ, JSON.stringify(agendadas, null, 1)); } catch { /* tenta na próxima */ } };

/** Agenda { jid, quando (ms), admin (ou null), mensagem, pedidoPor, descricao }. Devolve o id. */
export function agendar(a) {
  const id = crypto.randomBytes(4).toString('hex');
  agendadas.push({ ...a, id, criadaEm: Date.now() });
  salvar();
  return id;
}

/** Tira da lista e devolve as que já passaram da hora. */
export function vencidas(agora = Date.now()) {
  const prontas = agendadas.filter((a) => a.quando <= agora);
  if (!prontas.length) return [];
  agendadas = agendadas.filter((a) => a.quando > agora);
  salvar();
  return prontas;
}

export const pendentes = (jid) => agendadas.filter((a) => !jid || a.jid === jid);

export function cancelar(id) {
  const antes = agendadas.length;
  agendadas = agendadas.filter((a) => a.id !== id);
  salvar();
  return agendadas.length < antes;
}
