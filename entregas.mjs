// Avisos de entregas da faculdade no grupo (Moodle pelo link do calendário + Google Classroom).
//
// Horários (Brasília):
//  - 12:00 → tudo que vence hoje e ainda não passou;
//  - 20:00 → o que vence AMANHÃ antes das 22:10 (aviso com um dia de antecedência);
//  - 22:00 → o que vence hoje a partir das 22:10.
// O Claude decide se cada atividade vale nota ou é importante; as que não forem ficam de fora.
// Se o PC estava desligado no horário, o aviso sai em até 1 hora depois.
//
// Teste sem mandar nada: node entregas.mjs --teste 12 [--data 2026-11-09]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buscarClassroom, classroomConectado } from './classroom.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ESTADO = path.join(DIR, '.entregas-estado.json');

// Brasil sem horário de verão desde 2019: Brasília = UTC-3 o ano todo.
const FUSO_MS = -3 * 3600e3;
const local = (d) => new Date(d.getTime() + FUSO_MS);
const diaDe = (d) => local(d).toISOString().slice(0, 10);              // "2026-11-09"
const horaDe = (d) => local(d).toISOString().slice(11, 16);            // "23:59"
const minutosDe = (d) => { const l = local(d); return l.getUTCHours() * 60 + l.getUTCMinutes(); };
const somarDias = (dia, n) => new Date(Date.parse(dia + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

export const HORARIOS = [
  { id: '12', minutos: 12 * 60 },
  { id: '20', minutos: 20 * 60 },
  { id: '22', minutos: 22 * 60 },
];
const LIMITE_22 = 22 * 60 + 10; // entrega antes das 22:10 → avisa às 20h do dia anterior em vez das 22h
const ATRASO_MAX_MIN = 60;

const CHAMADOS = ['Gurizada', 'Malandragem', 'Rapaziada', 'Galera', 'Moçada', 'Turma', 'Povo', 'Pessoal'];

// ---------- leitura do calendário (iCal) ----------
function lerIcs(texto) {
  const linhas = texto.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const eventos = [];
  let atual = null;
  for (const linha of linhas) {
    if (linha === 'BEGIN:VEVENT') atual = {};
    else if (linha === 'END:VEVENT') { if (atual) eventos.push(atual); atual = null; }
    else if (atual) {
      const i = linha.indexOf(':');
      if (i < 0) continue;
      const [nome, ...params] = linha.slice(0, i).split(';');
      atual[nome] = { valor: linha.slice(i + 1), params: params.join(';') };
    }
  }
  return eventos;
}

const desescapar = (s = '') => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

function dataIcs({ valor, params }) {
  const m = valor.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, a, me, d, h, mi, s, z] = m;
  if (!h) return new Date(Date.UTC(a, me - 1, d, 23, 59) - FUSO_MS); // dia inteiro → até 23:59
  const utc = Date.UTC(a, me - 1, d, h, mi, s);
  return new Date(z ? utc : utc - FUSO_MS); // sem "Z" (TZID=...): trata como horário de Brasília
}

async function buscarIcs(url, fonte) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${fonte} respondeu ${r.status}`);
  const texto = await r.text();
  if (!texto.includes('BEGIN:VCALENDAR')) throw new Error(`${fonte} não devolveu um calendário (link expirou?)`);
  return lerIcs(texto).map((e) => {
    const prazo = dataIcs(e.DTEND || e.DTSTART || { valor: '' });
    return prazo && {
      id: `${fonte.toLowerCase()}-${e.UID?.valor || e.SUMMARY?.valor}`,
      fonte,
      titulo: desescapar(e.SUMMARY?.valor),
      disciplina: desescapar(e.CATEGORIES?.valor),
      descricao: desescapar(e.DESCRIPTION?.valor),
      prazo,
      pontos: null,
      versao: e['LAST-MODIFIED']?.valor || '',
    };
  }).filter(Boolean);
}

/** Junta as atividades de todas as fontes configuradas. Fonte com erro não derruba as outras. */
export async function buscarAtividades(cfg, log = console.log, { diasClassroom = 3 } = {}) {
  const fontes = [];
  if (cfg.moodle) fontes.push(['Moodle', () => buscarIcs(cfg.moodle, 'Moodle')]);
  for (const [i, c] of (cfg.calendarios || []).entries()) fontes.push([c.nome || `Calendário ${i + 1}`, () => buscarIcs(c.url, c.nome || 'Calendário')]);
  if (cfg.classroom?.clientId && classroomConectado()) fontes.push(['Classroom', () => buscarClassroom(cfg.classroom, { dias: diasClassroom })]);
  const todas = [];
  for (const [nome, buscar] of fontes) {
    try { todas.push(...(await buscar())); } catch (e) { log(`Entregas: não deu para ler ${nome} (${e.message}).`); }
  }
  return todas;
}

// ---------- perguntas no grupo ("tem trabalho semana que vem?") ----------
export const PERGUNTA_ENTREGA = /\b(trabalh\w*|entreg\w*|prazos?|provas?|atividades?|tarefas?|question[aá]rios?|avalia[cç][aã]o|avalia[cç][oõ]es|moodle|classroom|deadline|vence\w*|li[cç][aã]o|exerc[ií]cios?|semin[aá]rios?|relat[oó]rios?|aulas?|mat[eé]rias?|disciplinas?|cadeiras?|facul\w*|notas?|pontos)\b/i;

const cacheLista = { em: 0, texto: '' };
const diaSemana = (d) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit' }).format(d);

/** Lista das entregas dos próximos `dias` dias, para o Claude responder perguntas. Cache de 10 min. */
export async function listaParaPergunta(cfg, { dias = 21, log = console.log } = {}) {
  if (Date.now() - cacheLista.em < 10 * 60e3) return cacheLista.texto;
  const agora = new Date();
  const fim = agora.getTime() + dias * 864e5;
  const itens = (await buscarAtividades(cfg, log, { diasClassroom: dias }))
    .filter((a) => a.prazo > agora && a.prazo.getTime() <= fim)
    .sort((a, b) => a.prazo - b.prazo);
  const texto = itens.length
    ? itens.map((a) => [
      `- ${diaSemana(a.prazo)} às ${horaDe(a.prazo)} | ${a.fonte} | ${a.disciplina || 'disciplina não informada'} | ${a.titulo}`,
      a.pontos != null ? ` | vale ${a.pontos} pontos` : '',
      a.descricao ? ` | descrição: ${a.descricao.replace(/\s+/g, ' ').slice(0, 220)}` : '',
    ].join('')).join('\n')
    : `(nenhuma entrega com prazo nos próximos ${dias} dias)`;
  cacheLista.em = Date.now();
  cacheLista.texto = texto;
  return texto;
}

// ---------- quem entra em cada horário ----------
export function selecionar(atividades, horario, agora = new Date()) {
  const hoje = diaDe(agora);
  const amanha = somarDias(hoje, 1);
  return atividades.filter((a) => {
    if (a.prazo <= agora) return false;
    const dia = diaDe(a.prazo);
    const min = minutosDe(a.prazo);
    if (horario === '12') return dia === hoje;
    if (horario === '20') return dia === amanha && min < LIMITE_22;
    if (horario === '22') return dia === hoje && min >= LIMITE_22;
    return false;
  });
}

// ---------- estado (o que já foi avisado e o que a IA já decidiu) ----------
function lerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch { return { enviados: {}, decisoes: {} }; }
}
function salvarEstado(e) {
  // Guarda só os últimos 14 dias.
  const corte = somarDias(diaDe(new Date()), -14);
  for (const k of Object.keys(e.enviados)) if (k.slice(0, 10) < corte) delete e.enviados[k];
  for (const [k, v] of Object.entries(e.decisoes)) if ((v.dia || '') < corte) delete e.decisoes[k];
  fs.writeFileSync(ESTADO, JSON.stringify(e, null, 2));
}

/** Pede ao Claude só as atividades que mudaram desde a última vez. */
async function decidir(itens, avaliar, estado) {
  const chave = (a) => `${a.id}|${a.versao}|${a.prazo.toISOString()}`;
  const novos = itens.filter((a) => !estado.decisoes[chave(a)]);
  if (novos.length) {
    const respostas = await avaliar(novos.map((a) => ({ ...a, prazo: `${diaDe(a.prazo)} ${horaDe(a.prazo)} (Brasília)` })));
    for (const a of novos) {
      const r = respostas.find((x) => x.id === a.id);
      if (r) estado.decisoes[chave(a)] = { ...r, dia: diaDe(a.prazo) };
    }
  }
  return itens.map((a) => ({ ...a, decisao: estado.decisoes[chave(a)] })).filter((a) => a.decisao);
}

// ---------- texto ----------
export function montarMensagem(itens, agora = new Date()) {
  const hoje = diaDe(agora);
  const chamados = [...CHAMADOS].sort(() => Math.random() - 0.5);
  return itens
    .sort((a, b) => a.prazo - b.prazo)
    .map((a, i) => {
      const d = a.decisao;
      const quando = diaDe(a.prazo) === hoje ? 'hoje' : 'amanhã';
      const vale = d.nota ? `vale *${d.nota}*` : 'não sei quanto vale, mas parece importante';
      const disciplina = d.disciplina ? ` da disciplina *${d.disciplina}*` : '';
      const nome = d.nome || a.titulo;
      // "trabalho *Questionário 3*" fica estranho: só põe "trabalho" quando o nome não diz o que é.
      const tipo = /^(trabalho|question|prova|lista|relat|projeto|atividade|tarefa|exerc|semin|apresenta|avalia|teste|resenha|artigo|entrega)/i.test(nome) ? '' : 'trabalho ';
      return `${chamados[i % chamados.length]}, ${tipo}*${nome}*${disciplina} pra entregar ${quando} até ${horaDe(a.prazo)} (${a.fonte}), ${vale}.`;
    })
    .join('\n\n');
}

/** Monta o aviso de um horário. Devolve "" se não houver nada que valha a pena avisar. */
export async function avisoDoHorario({ cfg, horario, avaliar, agora = new Date(), log = console.log, estado = lerEstado() }) {
  const candidatas = selecionar(await buscarAtividades(cfg, log), horario, agora);
  if (!candidatas.length) return { texto: '', candidatas: [], estado };
  const decididas = await decidir(candidatas, avaliar, estado);
  for (const a of decididas) log(`Entregas: ${a.decisao.avisar ? 'AVISAR' : 'pular'} "${a.titulo}" (${a.decisao.nota || 'sem nota'}) — ${a.decisao.motivo}`);
  return { texto: montarMensagem(decididas.filter((a) => a.decisao.avisar), agora), candidatas: decididas, estado };
}

/**
 * Liga o relógio dos avisos. `enviar(texto)` manda no grupo e devolve false se ainda não deu (ex: desconectado).
 * `avaliar` é a função da IA (avaliarEntregas). `fila` serializa com as outras chamadas ao Claude.
 */
export function iniciarAvisos({ cfg, enviar, avaliar, fila = (f) => f(), log = console.log }) {
  let ocupado = false;
  const tique = async () => {
    if (ocupado) return;
    const agora = new Date();
    const min = minutosDe(agora);
    const horario = HORARIOS.find((h) => min >= h.minutos && min < h.minutos + ATRASO_MAX_MIN);
    if (!horario) return;
    const estado = lerEstado();
    const chave = `${diaDe(agora)}-${horario.id}`;
    if (estado.enviados[chave]) return;
    ocupado = true;
    try {
      const { texto } = await fila(() => avisoDoHorario({ cfg, horario: horario.id, avaliar, agora, log, estado }));
      if (texto && !(await enviar(texto))) return; // tenta de novo no próximo tique
      estado.enviados[chave] = texto ? 'enviado' : 'nada';
      salvarEstado(estado);
      log(`Entregas ${horario.id}h: ${texto ? 'aviso enviado' : 'nada para avisar'}.`);
    } catch (e) {
      log(`Entregas ${horario.id}h: erro (${e.message}); tento de novo em 1 min.`);
    } finally {
      ocupado = false;
    }
  };
  const timer = setInterval(tique, 60_000);
  setTimeout(tique, 15_000); // primeira olhada logo depois de ligar
  return () => clearInterval(timer);
}

// ---------- teste pela linha de comando ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--teste')) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const horario = arg('--teste') || '12';
  const data = arg('--data');
  const h = HORARIOS.find((x) => x.id === horario) || HORARIOS[0];
  const agora = data
    ? new Date(Date.parse(`${data}T00:00:00Z`) - FUSO_MS + h.minutos * 60e3)
    : new Date();
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).entregas || {};
  const { iniciarIA, avaliarEntregas } = await import('./ia.mjs');
  await iniciarIA(cfg.claude || 'claude');
  const todas = await buscarAtividades(cfg);
  console.log(`${todas.length} atividade(s) nas fontes:`);
  for (const a of todas) console.log(`  ${diaDe(a.prazo)} ${horaDe(a.prazo)} [${a.fonte}] ${a.titulo}`);
  console.log(`\nSimulando o aviso das ${horario}h em ${diaDe(agora)}:`);
  const { texto, candidatas } = await avisoDoHorario({ cfg, horario, avaliar: avaliarEntregas, agora, estado: { enviados: {}, decisoes: {} } });
  console.log(candidatas.length ? `\n${texto || '(nenhuma vale aviso)'}` : '(nenhuma atividade nesse horário)');
}
