// Aplica a correção upstream de whatsapp-web.js (commit "drop __x_id before spreading
// mediaOptions into outgoing Msg") que ainda não saiu no npm. Sem ela, enviar mídia
// falha com "Data passed to getter must include an id property".
// Roda automaticamente no `npm install` (postinstall). Pode remover quando sair versão > 1.34.7.
const fs = require('fs');
const path = require('path');

const arquivo = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
let src = fs.readFileSync(arquivo, 'utf8');

if (src.includes('delete message.__x_id')) {
  console.log('[patch-wwebjs] já aplicado.');
  process.exit(0);
}

const ancora = '        // Bot\'s won\'t reply if canonicalUrl is set (linking)';
if (!src.includes(ancora)) {
  console.error('[patch-wwebjs] ponto de inserção não encontrado; verifique a versão da biblioteca.');
  process.exit(1);
}

src = src.replace(
  ancora,
  '        if (message.__x_id) {\n            delete message.__x_id;\n        }\n' + ancora
);
fs.writeFileSync(arquivo, src);
console.log('[patch-wwebjs] correção aplicada.');
