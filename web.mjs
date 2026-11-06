// Baixa uma imagem da internet com segurança (a URL vem do Claude, que pode ter sido
// influenciado por mensagens do grupo ou por páginas da web).
//  - só https, sem usuário/senha na URL e só nas portas padrão;
//  - recusa endereços da máquina, da rede local e afins (checa o DNS a cada redirecionamento);
//  - no máximo 8 MB, e o arquivo precisa ser uma imagem de verdade (validado com o sharp).
import dns from 'node:dns/promises';
import net from 'node:net';
import sharp from 'sharp';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function ipPrivado(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return ipPrivado(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
}

async function validarUrl(texto) {
  const url = new URL(texto);
  if (url.protocol !== 'https:') throw new Error('só https');
  if (url.username || url.password) throw new Error('URL com credenciais');
  if (url.port && url.port !== '443') throw new Error('porta não permitida');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const enderecos = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!enderecos.length || enderecos.some((e) => ipPrivado(e.address))) throw new Error('endereço não permitido');
  return url;
}

/** Baixa e devolve a imagem como JPEG (máx. 1600px), pronta para mandar no WhatsApp. */
export async function baixarImagemDaWeb(endereco) {
  let url = await validarUrl(endereco);
  let resposta;
  for (let i = 0; ; i++) {
    resposta = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (BotDoGabreu)', Accept: 'image/*' },
    });
    if (resposta.status >= 300 && resposta.status < 400 && resposta.headers.get('location')) {
      if (i >= MAX_REDIRECTS) throw new Error('redirecionamentos demais');
      url = await validarUrl(new URL(resposta.headers.get('location'), url).toString());
      continue;
    }
    break;
  }
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  const tamanho = Number(resposta.headers.get('content-length') || 0);
  if (tamanho > MAX_BYTES) throw new Error('imagem grande demais');

  const partes = [];
  let total = 0;
  for await (const parte of resposta.body) {
    total += parte.length;
    if (total > MAX_BYTES) throw new Error('imagem grande demais');
    partes.push(parte);
  }
  return sharp(Buffer.concat(partes), { animated: false })
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
}
