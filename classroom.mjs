// Google Classroom pela API oficial, só leitura (turmas, atividades, avisos, materiais e os arquivos do
// Drive anexados), com o login feito uma vez em `node classroom.mjs --login`. O token fica em
// .classroom_token.json (fora do git). Os materiais viram texto em .classroom_materiais/ para o Claude
// procurar quando perguntam das aulas (`node classroom.mjs --sync` sincroniza na mão).
//
// Precisa de um "ID do cliente OAuth" do tipo "App para computador" do Google Cloud, salvo no
// config.json em entregas.classroom.clientId / clientSecret.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = path.join(DIR, '.classroom_token.json');
const ESCOPOS = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
  'https://www.googleapis.com/auth/classroom.topics.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];
// Perguntas sobre as aulas/matérias: o Claude procura nos materiais do Classroom.
export const PERGUNTA_AULA = /\b(aulas?|mat[eé]rias?|disciplinas?|cadeiras?|plano|ensino|ementa|cronograma|conte[uú]dos?|materia(l|is)|slides?|apostilas?|bibliografia|livros?|professor\w*|profs?|sor|classroom|class|quest(?:[oõ]es|[aã]o)|revis[aã]o|exerc[ií]cios?|listas?|pdf|facul\w*|semestre|unidades?|cap[ií]tulos?|lista de exerc\w*|pesos?|m[eé]dia|recupera[cç][aã]o|vale|p[1-4])\b/i;
// Onde ficam os materiais em texto: entregas.classroom.pastaMateriais no config.json (ex: no HD).
export const PASTA_MATERIAIS = (() => {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).entregas?.classroom?.pastaMateriais;
    if (p) return path.resolve(DIR, p);
  } catch { /* sem config: usa a pasta do bot */ }
  return path.join(DIR, '.classroom_materiais');
})();
const ESTADO_MATERIAIS = path.join(PASTA_MATERIAIS, '.estado.json');
const API = 'https://classroom.googleapis.com/v1';

export const classroomConectado = () => fs.existsSync(TOKEN);

async function tokenDeAcesso({ clientId, clientSecret }) {
  const { refresh_token } = JSON.parse(fs.readFileSync(TOKEN, 'utf8'));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!j.access_token) {
    const e = new Error(`Classroom recusou o token: ${j.error || r.status} ${j.error_description || ''}`.trim());
    e.loginVencido = j.error === 'invalid_grant'; // login expirou ou foi revogado: precisa entrar de novo
    throw e;
  }
  return j.access_token;
}

/** Escopos que o login atual ainda não tem (login antigo, de antes dos materiais). */
async function escoposFaltando({ clientId, clientSecret }) {
  const { refresh_token } = JSON.parse(fs.readFileSync(TOKEN, 'utf8'));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!j.access_token) return ESCOPOS;
  const tem = new Set(String(j.scope || '').split(/\s+/));
  // O Google devolve coursework.me.readonly com o nome antigo.
  if (tem.has('https://www.googleapis.com/auth/classroom.student-submissions.me.readonly')) tem.add('https://www.googleapis.com/auth/classroom.coursework.me.readonly');
  return ESCOPOS.filter((e) => !tem.has(e));
}

/**
 * Confere o login de tempos em tempos (e quando o bot liga). Se expirou, abre o navegador sozinho
 * para entrar de novo; no máximo uma vez a cada `intervaloAbrirH` horas, para não ficar abrindo aba.
 */
export function vigiarLogin(cfg, { log = console.log, intervaloH = 1, intervaloAbrirH = 6 } = {}) {
  let ultimaAbertura = 0;
  let emAndamento = false;
  const conferir = async () => {
    if (emAndamento || !classroomConectado()) return;
    try {
      await tokenDeAcesso(cfg);
      const faltam = await escoposFaltando(cfg);
      if (faltam.length) {
        const e = new Error(`faltam permissões: ${faltam.map((x) => x.split('/').pop()).join(', ')}`);
        e.loginVencido = true;
        throw e;
      }
    } catch (e) {
      if (!e.loginVencido) { log(`Classroom: não deu para conferir o login (${e.message}).`); return; }
      if (Date.now() - ultimaAbertura < intervaloAbrirH * 3600e3) return;
      ultimaAbertura = Date.now();
      emAndamento = true;
      log(`Classroom: precisa entrar de novo (${e.message}); abrindo o navegador (espera até 2 h).`);
      try {
        await login(cfg, { timeoutMs: 2 * 3600e3, log });
        log('Classroom: login renovado.');
      } catch (erro) {
        log(`Classroom: login não foi renovado (${erro.message}); tento de novo em ${intervaloAbrirH} h.`);
      } finally {
        emAndamento = false;
      }
    }
  };
  setTimeout(conferir, 20_000);
  const timer = setInterval(conferir, intervaloH * 3600e3);
  timer.unref?.();
  return conferir;
}

async function get(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Classroom ${r.status}: ${j.error?.message || 'erro'}`);
  return j;
}

/** Junta todas as páginas de uma listagem da API (campo `chave`). */
async function todasAsPaginas(url, chave, token) {
  const itens = [];
  let pagina = '';
  do {
    const j = await get(url + (url.includes('?') ? '&' : '?') + 'pageSize=100' + (pagina ? `&pageToken=${pagina}` : ''), token);
    itens.push(...(j[chave] || []));
    pagina = j.nextPageToken || '';
  } while (pagina);
  return itens;
}

/** Atividades com prazo entre agora-1d e agora+dias, no formato comum do entregas.mjs. */
export async function buscarClassroom(cfg, { dias = 3 } = {}) {
  const token = await tokenDeAcesso(cfg);
  const { courses = [] } = await get(`${API}/courses?studentId=me&courseStates=ACTIVE&pageSize=50`, token);
  const inicio = Date.now() - 24 * 3600e3;
  const fim = Date.now() + dias * 24 * 3600e3;
  const itens = [];
  for (const c of courses) {
    const { courseWork = [] } = await get(`${API}/courses/${c.id}/courseWork?courseWorkStates=PUBLISHED&orderBy=dueDate%20desc&pageSize=30`, token);
    for (const w of courseWork) {
      if (!w.dueDate) continue;
      const { year, month, day } = w.dueDate;
      // dueDate/dueTime vêm em UTC; campos zerados são omitidos pela API.
      const prazo = new Date(Date.UTC(year, month - 1, day, w.dueTime?.hours || 0, w.dueTime?.minutes || 0));
      if (prazo < inicio || prazo > fim) continue;
      itens.push({
        id: `classroom-${w.id}`,
        fonte: 'Classroom',
        titulo: w.title || '',
        disciplina: c.name || '',
        descricao: w.description || '',
        prazo,
        pontos: w.maxPoints ?? null,
        versao: w.updateTime || '',
      });
    }
  }
  return itens;
}

// ---------- materiais (avisos, atividades, materiais e arquivos do Drive) em texto ----------
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const LIMITE_ARQUIVO = 40 * 1024 * 1024;
const EXPORTAR = {
  'application/vnd.google-apps.document': ['text/plain', '.txt'],
  'application/vnd.google-apps.presentation': ['text/plain', '.txt'],
  'application/vnd.google-apps.spreadsheet': ['text/csv', '.csv'],
};
const EXTRAIR = /\.(pdf|docx|pptx|xlsx|odt|odp|ods|rtf)$/i;
const TEXTO_PURO = /^text\/|\/(json|csv|xml)$/;

const nomeSeguro = (s) => String(s || 'sem nome').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'sem nome';
const dataHoraBR = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function listarMateriais(materiais = []) {
  return materiais.map((m) => {
    if (m.driveFile) return `  - arquivo: ${m.driveFile.driveFile?.title || '?'} (${m.driveFile.driveFile?.alternateLink || ''})`;
    if (m.youtubeVideo) return `  - vídeo: ${m.youtubeVideo.title || ''} (${m.youtubeVideo.alternateLink || ''})`;
    if (m.link) return `  - link: ${m.link.title || ''} (${m.link.url})`;
    if (m.form) return `  - formulário: ${m.form.title || ''} (${m.form.formUrl})`;
    return '';
  }).filter(Boolean).join('\n');
}

async function textoDoArquivo(meta, token) {
  const baixar = async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Drive ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  const exp = EXPORTAR[meta.mimeType];
  if (exp) return { ext: exp[1], texto: (await baixar(`${DRIVE}/${meta.id}/export?mimeType=${encodeURIComponent(exp[0])}`)).toString('utf8') };
  if (Number(meta.size || 0) > LIMITE_ARQUIVO) return { pulado: 'arquivo grande demais' };
  if (TEXTO_PURO.test(meta.mimeType)) return { ext: '.txt', texto: (await baixar(`${DRIVE}/${meta.id}?alt=media`)).toString('utf8') };
  if (!EXTRAIR.test(meta.name)) return { pulado: `tipo não lido (${meta.mimeType})` };
  const buffer = await baixar(`${DRIVE}/${meta.id}?alt=media`);
  const { parseOffice } = await import('officeparser');
  const ast = await parseOffice(buffer, { ocr: false });
  return { ext: '.txt', texto: (await ast.to('text')).value };
}

/**
 * Baixa tudo do Classroom (turmas ativas) para .classroom_materiais/<turma>/: um _mural.md com cada
 * aviso, atividade e material (data, tema, texto, anexos) e um .txt por arquivo do Drive anexado.
 * Só baixa de novo o arquivo que mudou. Devolve um resumo.
 */
export async function sincronizarMateriais(cfg, { log = console.log, rapido = false } = {}) {
  const token = await tokenDeAcesso(cfg);
  fs.mkdirSync(PASTA_MATERIAIS, { recursive: true });
  let estado = {};
  try { estado = JSON.parse(fs.readFileSync(ESTADO_MATERIAIS, 'utf8')); } catch { /* primeira vez */ }
  const novoEstado = { arquivos: {}, em: new Date().toISOString() };
  const indice = [];
  let baixados = 0;
  const cursos = await todasAsPaginas(`${API}/courses?studentId=me&courseStates=ACTIVE`, 'courses', token);
  for (const c of cursos) {
    const turma = nomeSeguro(c.name);
    const pasta = path.join(PASTA_MATERIAIS, turma);
    fs.mkdirSync(pasta, { recursive: true });
    const tentar = async (url, chave) => {
      try { return await todasAsPaginas(url, chave, token); } catch (e) { log(`Classroom: ${c.name}: não deu para ler ${chave} (${e.message}).`); return []; }
    };
    const base = `${API}/courses/${c.id}`;
    const [topicos, avisos, atividades, materiais] = await Promise.all([
      tentar(`${base}/topics`, 'topic'),
      tentar(`${base}/announcements`, 'announcements'),
      tentar(`${base}/courseWork`, 'courseWork'),
      tentar(`${base}/courseWorkMaterials`, 'courseWorkMaterial'),
    ]);
    const tema = Object.fromEntries(topicos.map((t) => [t.topicId, t.name]));
    const posts = [
      ...avisos.map((a) => ({ tipo: 'Aviso', id: a.id, link: a.alternateLink, data: a.creationTime, editado: a.updateTime, texto: a.text, materials: a.materials })),
      ...atividades.map((w) => ({
        tipo: 'Atividade', id: w.id, link: w.alternateLink, data: w.creationTime, editado: w.updateTime, titulo: w.title, texto: w.description, materials: w.materials, topicId: w.topicId,
        extra: [w.dueDate ? `prazo: ${w.dueDate.day}/${w.dueDate.month}/${w.dueDate.year}` : '', w.maxPoints != null ? `vale ${w.maxPoints} pontos` : ''].filter(Boolean).join(', '),
      })),
      ...materiais.map((m) => ({ tipo: 'Material', id: m.id, link: m.alternateLink, data: m.creationTime, editado: m.updateTime, titulo: m.title, texto: m.description, materials: m.materials, topicId: m.topicId })),
    ].sort((a, b) => String(b.data).localeCompare(String(a.data)));

    const mural = [
      `# ${c.name}${c.section ? ` (${c.section})` : ''}`,
      [c.descriptionHeading, c.description, c.room ? `Sala: ${c.room}` : ''].filter(Boolean).join('\n'),
      `Temas: ${topicos.map((t) => t.name).join(' | ') || '(nenhum)'}`,
      ...posts.map((p) => [
        `## ${p.tipo}${p.titulo ? `: ${p.titulo}` : ''} (postado em ${dataHoraBR(p.data)}${p.editado && p.editado.slice(0, 16) !== String(p.data).slice(0, 16) ? `, editado em ${dataHoraBR(p.editado)}` : ''}${p.topicId && tema[p.topicId] ? `, tema: ${tema[p.topicId]}` : ''}${p.extra ? `, ${p.extra}` : ''})`,
        `id do post: ${p.id}${p.link ? ` | link: ${p.link}` : ''}`,
        p.texto || '',
        p.materials?.length ? `Anexos:\n${listarMateriais(p.materials)}` : '',
      ].filter(Boolean).join('\n')),
    ].filter(Boolean).join('\n\n');
    fs.writeFileSync(path.join(pasta, '_mural.md'), mural);
    const arquivosDaTurma = ['_mural.md'];

    const ids = new Map();
    for (const p of posts) for (const m of p.materials || []) if (m.driveFile?.driveFile?.id) ids.set(m.driveFile.driveFile.id, m.driveFile.driveFile.title);
    for (const [id, titulo] of ids) {
      try {
        const antes = estado.arquivos?.[id];
        // Rápida (na hora da pergunta): arquivo já conhecido não é conferido; só baixa anexo novo.
        // A completa, de 6 em 6 h, pega arquivo editado.
        if (rapido && antes && (antes.pulado || fs.existsSync(path.join(PASTA_MATERIAIS, antes.caminho)))) {
          novoEstado.arquivos[id] = antes;
          if (!antes.pulado) arquivosDaTurma.push(path.basename(antes.caminho));
          continue;
        }
        const meta = await get(`${DRIVE}/${id}?fields=id,name,mimeType,modifiedTime,size&supportsAllDrives=true`, token);
        if (antes?.pulado && antes.modificado === meta.modifiedTime) { novoEstado.arquivos[id] = antes; continue; } // imagem, zip...
        if (antes && antes.modificado === meta.modifiedTime && fs.existsSync(path.join(PASTA_MATERIAIS, antes.caminho))) {
          novoEstado.arquivos[id] = antes;
          arquivosDaTurma.push(path.basename(antes.caminho));
          continue;
        }
        const r = await textoDoArquivo(meta, token);
        if (r.pulado) { novoEstado.arquivos[id] = { modificado: meta.modifiedTime, pulado: r.pulado }; continue; }
        let nome = nomeSeguro(meta.name.replace(/\.[^.]+$/, '')) + r.ext;
        if (arquivosDaTurma.includes(nome)) nome = nome.replace(/(\.[^.]+)$/, ` (${id.slice(0, 6)})$1`);
        fs.writeFileSync(path.join(pasta, nome), `Arquivo do Classroom: ${meta.name}\nTurma: ${c.name}\n\n${r.texto}`);
        novoEstado.arquivos[id] = { modificado: meta.modifiedTime, caminho: path.join(turma, nome) };
        arquivosDaTurma.push(nome);
        baixados++;
      } catch (e) {
        // Fica marcado: a busca rápida não tenta (nem avisa) de novo; a completa tenta.
        novoEstado.arquivos[id] = { modificado: '', pulado: e.message };
        log(`Classroom: ${c.name}: não deu para ler "${titulo}" (${e.message}).`);
      }
    }
    indice.push(`${turma}/ → ${arquivosDaTurma.join(' | ')}`);
  }
  fs.writeFileSync(ESTADO_MATERIAIS, JSON.stringify(novoEstado));
  fs.writeFileSync(path.join(PASTA_MATERIAIS, '_indice.md'), indice.join('\n'));
  return { turmas: cursos.length, arquivos: Object.values(novoEstado.arquivos).filter((x) => !x.pulado).length, baixados };
}

/** Lista de turmas e arquivos já sincronizados (para o prompt), ou '' se nunca sincronizou. */
export function indiceMateriais() {
  try { return fs.readFileSync(path.join(PASTA_MATERIAIS, '_indice.md'), 'utf8'); } catch { return ''; }
}

/**
 * Sincroniza (completa) ao ligar e a cada `intervaloH` horas. Devolve sincronizar({ rapido }) para
 * buscar na hora: a rápida relê os murais e baixa só anexo novo (é a usada quando perguntam).
 */
export function manterMateriais(cfg, { log = console.log, intervaloH = 6 } = {}) {
  let emAndamento = null;
  const sincronizar = ({ rapido = false } = {}) => {
    if (!classroomConectado()) return Promise.resolve(null);
    emAndamento ??= sincronizarMateriais(cfg, { log, rapido })
      .then((r) => { log(`Classroom: materiais sincronizados${rapido ? ' (rápida, na hora da pergunta)' : ''} (${r.turmas} turma(s), ${r.arquivos} arquivo(s), ${r.baixados} novo(s)).`); return r; })
      .catch((e) => { log(`Classroom: não deu para sincronizar os materiais (${e.message}).`); return null; })
      .finally(() => { emAndamento = null; });
    return emAndamento;
  };
  setTimeout(sincronizar, 60_000);
  setInterval(sincronizar, intervaloH * 3600e3).unref?.();
  return sincronizar;
}

/** Login uma vez: abre o navegador, recebe o código numa porta local e salva o token. */
export async function login({ clientId, clientSecret }, { timeoutMs = 10 * 60e3, log = console.log } = {}) {
  const servidor = http.createServer();
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  const redirect = `http://127.0.0.1:${servidor.address().port}`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: ESCOPOS.join(' '),
    access_type: 'offline', prompt: 'consent',
  });
  log('Abrindo o navegador para entrar no Google (Classroom). Se não abrir, cole este link:\n' + url);
  // "start" com a URL entre aspas; o & da URL não pode ser interpretado pelo cmd.
  exec(`start "" "${url}"`);
  let timer;
  const codigo = await new Promise((ok, falha) => {
    timer = setTimeout(() => falha(new Error('ninguém fez o login a tempo')), timeoutMs);
    servidor.on('request', (req, res) => {
      const p = new URL(req.url, redirect).searchParams;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(p.get('code') ? '<h2>Pronto! Bot do Gruposudo conectado ao Classroom. Pode fechar esta aba.</h2>' : `<h2>Não deu: ${p.get('error') || 'sem código'}</h2>`);
      if (p.get('code')) ok(p.get('code'));
      else if (p.get('error')) falha(new Error(p.get('error')));
    });
  }).finally(() => { clearTimeout(timer); servidor.close(); });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: codigo, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  if (!j.refresh_token) throw new Error(`Google não devolveu o token: ${JSON.stringify(j)}`);
  fs.writeFileSync(TOKEN, JSON.stringify({ refresh_token: j.refresh_token }));
  log('Classroom conectado. Token salvo em .classroom_token.json.');
}

const direto = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direto && process.argv.includes('--sync')) {
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).entregas?.classroom || {};
  sincronizarMateriais(cfg)
    .then((r) => console.log(`Pronto: ${r.turmas} turma(s), ${r.arquivos} arquivo(s), ${r.baixados} baixado(s) agora. Pasta: ${PASTA_MATERIAIS}`))
    .catch((e) => { console.error('Erro:', e.message); process.exit(1); });
}
if (direto && process.argv.includes('--login')) {
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).entregas?.classroom || {};
  if (!cfg.clientId || !cfg.clientSecret) {
    console.error('Falta entregas.classroom.clientId e clientSecret no config.json.');
    process.exit(1);
  }
  login(cfg, { timeoutMs: 30 * 60e3 })
    .then(() => buscarClassroom(cfg, { dias: 30 }))
    .then((itens) => console.log(`Achei ${itens.length} atividade(s) com prazo nos próximos 30 dias.`))
    .then(() => sincronizarMateriais(cfg))
    .then((r) => console.log(`Materiais: ${r.turmas} turma(s), ${r.arquivos} arquivo(s) em ${PASTA_MATERIAIS}.`))
    .catch((e) => { console.error('Erro:', e.message); process.exit(1); });
}

/**
 * Link do Classroom (classroom.google.com/c/<turma>/m|a|p|sa/<post>) → ids numéricos.
 * Os pedaços do link são os ids em base64.
 */
export function idsDeLinkClassroom(texto) {
  const dec = (b) => { const t = Buffer.from(b, 'base64').toString('utf8'); return /^\d+$/.test(t) ? t : b; };
  return [...String(texto || '').matchAll(/classroom\.google\.com\/(?:u\/\d+\/)?c\/([A-Za-z0-9_-]+)(?:\/(?:m|a|p|sa)\/([A-Za-z0-9_-]+))?/g)]
    .map((m) => ({ turma: dec(m[1]), post: m[2] ? dec(m[2]) : '' }));
}
