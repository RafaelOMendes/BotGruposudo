// Google Classroom pela API oficial, só leitura (turmas e atividades), com o login feito uma vez em
// `node classroom.mjs --login`. O token fica em .classroom_token.json (fora do git).
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
];
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
  if (!j.access_token) throw new Error(`Classroom recusou o token: ${j.error || r.status} ${j.error_description || ''}`.trim());
  return j.access_token;
}

async function get(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Classroom ${r.status}: ${j.error?.message || 'erro'}`);
  return j;
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

/** Login uma vez: abre o navegador, recebe o código numa porta local e salva o token. */
async function login({ clientId, clientSecret }) {
  const servidor = http.createServer();
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  const redirect = `http://127.0.0.1:${servidor.address().port}`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: ESCOPOS.join(' '),
    access_type: 'offline', prompt: 'consent',
  });
  console.log('Abrindo o navegador para entrar no Google. Se não abrir, cole este link:\n' + url);
  exec(`start "" "${url}"`);
  const codigo = await new Promise((ok, falha) => {
    servidor.on('request', (req, res) => {
      const p = new URL(req.url, redirect).searchParams;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(p.get('code') ? '<h2>Pronto! Pode fechar esta aba.</h2>' : `<h2>Não deu: ${p.get('error') || 'sem código'}</h2>`);
      if (p.get('code')) ok(p.get('code'));
      else if (p.get('error')) falha(new Error(p.get('error')));
    });
  });
  servidor.close();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: codigo, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  if (!j.refresh_token) throw new Error(`Google não devolveu o token: ${JSON.stringify(j)}`);
  fs.writeFileSync(TOKEN, JSON.stringify({ refresh_token: j.refresh_token }));
  console.log('Classroom conectado. Token salvo em .classroom_token.json.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--login')) {
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).entregas?.classroom || {};
  if (!cfg.clientId || !cfg.clientSecret) {
    console.error('Falta entregas.classroom.clientId e clientSecret no config.json.');
    process.exit(1);
  }
  login(cfg)
    .then(() => buscarClassroom(cfg, { dias: 30 }))
    .then((itens) => console.log(`Achei ${itens.length} atividade(s) com prazo nos próximos 30 dias.`))
    .catch((e) => { console.error('Erro:', e.message); process.exit(1); });
}
