// Gera PDF a partir de HTML escrito pelo Claude (questões resolvidas, resumos, listas...), usando o
// Chrome/Edge instalado em modo headless. Sem dependência nova.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATOS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
];

export const navegadorPdf = (preferido) => [preferido, ...CANDIDATOS].find((c) => c && fs.existsSync(c)) || null;

const escapar = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Tira o que não é texto formatado: scripts, iframes, links externos, handlers on*. */
function limpar(html) {
  return String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[\s\S]*?(<\/\s*\1\s*>|\/?>)/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(src|href)\s*=\s*("|')\s*(?!data:|#)[^"']*\2/gi, '');
}

function pagina(titulo, corpo) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapar(titulo)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #111; }
  h1 { font-size: 18pt; margin: 0 0 4mm; border-bottom: 2px solid #333; padding-bottom: 2mm; }
  h2 { font-size: 13.5pt; margin: 6mm 0 2mm; }
  h3 { font-size: 12pt; margin: 4mm 0 1.5mm; }
  p, li { margin: 1.2mm 0; }
  ol, ul { padding-left: 6mm; }
  .questao { break-inside: avoid; break-after: avoid; margin: 4.5mm 0 0.8mm; }
  .resposta { margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: 2mm 0; break-inside: avoid; }
  th, td { border: 1px solid #999; padding: 1.5mm 2mm; text-align: left; vertical-align: top; }
  th { background: #eee; }
  code, pre { font-family: Consolas, monospace; font-size: 9.5pt; background: #f3f3f3; }
  pre { padding: 2mm; white-space: pre-wrap; }
</style></head><body><h1>${escapar(titulo)}</h1>${limpar(corpo)}</body></html>`;
}

/** Devolve o PDF (Buffer). */
export function gerarPdf({ titulo = 'Documento', html }, { navegador } = {}) {
  return imprimir(pagina(titulo, html), navegador);
}

async function imprimir(htmlCompleto, navegador) {
  const exe = navegadorPdf(navegador);
  if (!exe) throw new Error('não achei Chrome nem Edge para gerar o PDF');
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-pdf-'));
  try {
    const entrada = path.join(pasta, 'doc.html');
    const saida = path.join(pasta, 'doc.pdf');
    fs.writeFileSync(entrada, htmlCompleto);
    await new Promise((ok, falha) => {
      execFile(exe, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
        `--user-data-dir=${path.join(pasta, 'perfil')}`,
        '--no-pdf-header-footer', `--print-to-pdf=${saida}`, pathToFileURL(entrada).href,
      ], { timeout: 90_000, windowsHide: true }, (e) => (e && !fs.existsSync(saida) ? falha(e) : ok()));
    });
    const pdf = fs.readFileSync(saida);
    if (pdf.length < 500) throw new Error('PDF saiu vazio');
    return pdf;
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

// ---------- conversa no visual do WhatsApp ----------
const CORES_NOMES = ['#1f7aec', '#d6336c', '#2b8a3e', '#e8590c', '#7048e8', '#0c8599', '#c2255c', '#5c940d', '#ae3ec9', '#d9480f'];
const corDoNome = (nome) => CORES_NOMES[[...String(nome)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % CORES_NOMES.length];
const quebrar = (t) => escapar(t).replace(/\n/g, '<br>').replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/_([^_\n]+)_/g, '<i>$1</i>');

/**
 * PDF de uma conversa, parecendo o WhatsApp: balões, nomes coloridos, hora, separador de dia,
 * mensagem citada dentro do balão e miniatura de foto/figurinha.
 * @param {object} c { titulo, subtitulo, mensagens: [{ data: Date, nome, texto, minha, citada?: { nome, texto }, miniatura?: Buffer }] }
 */
export function gerarPdfConversa({ titulo, subtitulo = '', mensagens }, { navegador } = {}) {
  const dia = (d) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = (d) => d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  let ultimoDia = '';
  let ultimoNome = '';
  const corpo = mensagens.map((m) => {
    let html = '';
    const d = dia(m.data);
    if (d !== ultimoDia) { html += `<div class="dia"><span>${escapar(d)}</span></div>`; ultimoDia = d; ultimoNome = ''; }
    const seguida = m.nome === ultimoNome; // mensagens seguidas da mesma pessoa: sem repetir o nome
    ultimoNome = m.nome;
    const nome = !m.minha && !seguida ? `<div class="nome" style="color:${corDoNome(m.nome)}">${escapar(m.nome)}</div>` : '';
    const citada = m.citada ? `<div class="citada" style="border-color:${corDoNome(m.citada.nome)}"><div class="nome" style="color:${corDoNome(m.citada.nome)}">${escapar(m.citada.nome)}</div>${quebrar(String(m.citada.texto).slice(0, 220))}</div>` : '';
    const mini = m.miniatura?.length ? `<img class="mini" src="data:image/jpeg;base64,${Buffer.from(m.miniatura).toString('base64')}">` : '';
    return `${html}<div class="linha ${m.minha ? 'minha' : ''} ${seguida ? 'seguida' : ''}"><div class="balao">${nome}${citada}${mini}<span class="texto">${quebrar(m.texto)}</span><span class="hora">${hora(m.data)}</span></div></div>`;
  }).join('');
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapar(titulo)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #efeae2; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: "Segoe UI", Arial, sans-serif; font-size: 10.5pt; color: #111b21; padding: 0 0 10mm; }
  .topo { background: #008069; color: #fff; padding: 6mm 12mm 5mm; }
  .topo h1 { margin: 0; font-size: 15pt; font-weight: 600; }
  .topo p { margin: 1mm 0 0; font-size: 9.5pt; opacity: .85; }
  .conversa { padding: 4mm 12mm; }
  .dia { text-align: center; margin: 4mm 0 3mm; break-after: avoid; }
  .dia span { background: #fff; color: #54656f; font-size: 8.5pt; padding: 1.2mm 3mm; border-radius: 2mm; box-shadow: 0 .3mm .4mm rgba(0,0,0,.12); text-transform: capitalize; }
  .linha { display: flex; margin-top: 2.2mm; break-inside: avoid; }
  .linha.seguida { margin-top: .8mm; }
  .linha.minha { justify-content: flex-end; }
  .balao { position: relative; max-width: 72%; background: #fff; border-radius: 2.2mm; padding: 1.6mm 2.6mm 1.4mm; box-shadow: 0 .3mm .4mm rgba(0,0,0,.13); }
  .minha .balao { background: #d9fdd3; }
  .linha:not(.seguida):not(.minha) .balao { border-top-left-radius: 0; }
  .minha:not(.seguida) .balao { border-top-right-radius: 0; }
  .nome { font-size: 9pt; font-weight: 600; margin-bottom: .5mm; }
  .texto { white-space: normal; word-wrap: break-word; }
  .hora { float: right; font-size: 7.5pt; color: #667781; margin: 1.6mm 0 -0.6mm 3mm; }
  .citada { background: rgba(0,0,0,.05); border-left: 1mm solid; border-radius: 1.2mm; padding: 1mm 2mm; margin: .4mm 0 1.2mm; font-size: 9pt; color: #54656f; }
  .citada .nome { font-size: 8.5pt; margin: 0; }
  .mini { display: block; max-width: 45mm; max-height: 45mm; border-radius: 1.5mm; margin: .6mm 0 1mm; }
</style></head><body>
<div class="topo"><h1>${escapar(titulo)}</h1>${subtitulo ? `<p>${escapar(subtitulo)}</p>` : ''}</div>
<div class="conversa">${corpo || '<div class="dia"><span>Ninguém mandou nada</span></div>'}</div>
</body></html>`;
  return imprimir(html, navegador);
}
