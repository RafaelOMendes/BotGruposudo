// Usa o Claude Code CLI (`claude -p`, já logado no PC) para decidir se uma figurinha/imagem
// é "non-sense". Não precisa de chave de API: usa o mesmo login do `claude` no terminal.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: { nonsense: { type: 'boolean' }, motivo: { type: 'string' } },
  required: ['nonsense', 'motivo'],
  additionalProperties: false,
});

const PROMPT = `Leia a imagem img.png. É uma figurinha ou imagem mandada num grupo de amigos no WhatsApp.
Decida se ela é "non-sense": aleatória, absurda, sem contexto, um meme esquisito ou bizarro
que pede uma resposta zoeira. Fotos comuns (print de conversa, foto de lugar, documento,
comida, paisagem, selfie normal) e figurinhas de reação comuns e óbvias (joinha, risada, "ok")
NÃO são non-sense.
Responda com nonsense (true/false) e um motivo curto em português.`;

let comando = null;

function rodar(cmd, args, opcoes) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024, ...opcoes }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve(stdout);
    });
  });
}

/** Verifica se o `claude` está instalado. Retorna true/false. */
export async function iniciarIA(caminho = 'claude') {
  try {
    await rodar(caminho, ['--version'], { timeout: 30_000 });
    comando = caminho;
    return true;
  } catch {
    comando = null;
    return false;
  }
}

/** @returns {Promise<{nonsense: boolean, motivo: string}>} */
export async function ehNonsense(buffer) {
  if (!comando) throw new Error('claude CLI não encontrado');

  // Pasta temporária própria: o `claude` só consegue ler arquivos dentro do diretório de trabalho.
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-gabreu-'));
  try {
    await sharp(buffer, { animated: false })
      .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .png()
      .toFile(path.join(pasta, 'img.png'));

    const saida = await rodar(
      comando,
      [
        '-p', PROMPT,
        '--output-format', 'json',
        '--json-schema', SCHEMA,
        '--tools', 'Read',
        '--allowedTools', 'Read',
        '--effort', 'low',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--disable-slash-commands',
      ],
      { cwd: pasta, timeout: 120_000 }
    );

    const r = JSON.parse(saida);
    if (r.is_error) throw new Error(`claude devolveu erro: ${r.subtype} ${r.result || ''}`.trim());
    const v = r.structured_output;
    if (typeof v?.nonsense !== 'boolean') throw new Error(`resposta sem o formato esperado: ${String(r.result).slice(0, 200)}`);
    return { nonsense: v.nonsense, motivo: String(v.motivo || '') };
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}
