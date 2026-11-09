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
export async function gerarPdf({ titulo = 'Documento', html }, { navegador } = {}) {
  const exe = navegadorPdf(navegador);
  if (!exe) throw new Error('não achei Chrome nem Edge para gerar o PDF');
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-pdf-'));
  try {
    const entrada = path.join(pasta, 'doc.html');
    const saida = path.join(pasta, 'doc.pdf');
    fs.writeFileSync(entrada, pagina(titulo, html));
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
