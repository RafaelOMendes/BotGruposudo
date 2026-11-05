# 🎙️ Bot do Gabreu

Bot de WhatsApp que fica de olho no grupo **Gruposudo**:

- 🎙️ Quando o **Gabriel Lassen** manda uma mensagem só de interrogações (`?`, `??`, `????`…), responde (citando a mensagem) com o áudio [`audio/gabreu.ogg`](audio/gabreu.ogg) como mensagem de voz.
- 🖼️ Quando o **Nicolas Bresolin** manda uma figurinha ou imagem, o Claude decide se ela é *non-sense* (via [Claude Code](https://claude.com/claude-code) no modo `claude -p`, usando o login que já está no PC; não precisa de chave de API). Se for, o bot responde com uma figurinha "manda figurinha de gente animal".

Feito com [Baileys](https://github.com/WhiskeySockets/Baileys), que fala o protocolo do WhatsApp direto (sem navegador). Os pedidos de reenvio dos aparelhos que não conseguem abrir a mensagem (o "Aguardando mensagem" do iPhone) são atendidos automaticamente.

## Como usar

```bash
npm install
npm start
```

Na primeira vez aparece um QR code no terminal (e também em http://localhost:3999, caso o terminal corte o QR): abra o WhatsApp no celular → **Aparelhos conectados** → **Conectar aparelho** e escaneie. A sessão fica salva em `.baileys_auth/`, então não pede de novo.

Depois disso, feche o terminal (Ctrl+C). A partir daí o bot sobe sozinho quando o Windows liga.

## Inicialização automática

Um atalho `BotWhatsAudioGabreu.lnk` em `shell:startup` executa `start-oculto.vbs`, que roda `start.cmd` sem janela. O `start.cmd` reinicia o bot se ele cair (e para se já houver outra instância rodando ou se a sessão for desconectada pelo celular).

## Configuração

Copie `config.example.json` para `config.json` (fica fora do git) e ajuste:

| Campo       | Para quê                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `grupo`     | Nome do grupo                                                            |
| `remetente` | Nome de perfil da pessoa (usado só se `ids` estiver vazio)               |
| `ids`       | IDs do WhatsApp da pessoa (`...@lid` ou `número@s.whatsapp.net`) — mais confiável |
| `figurinha.remetente` / `figurinha.ids` | Quem dispara a resposta com figurinha (mesma lógica de `remetente`/`ids`) |
| `figurinha.arquivo` | Figurinha de resposta: `.webp` 512×512 (a pasta `figurinhas/` fica fora do git) |
| `figurinha.intervaloSeg` | Intervalo mínimo entre respostas com figurinha (padrão 60 s) |
| `figurinha.chanceSemIA` | Se o `claude` não estiver instalado: chance de responder mesmo assim (1 = sempre, 0 = nunca) |
| `claude` | Caminho do Claude Code CLI (padrão: `claude` no PATH; ou variável `CLAUDE_CLI_PATH`) |

Para criar uma figurinha a partir de qualquer imagem:

```bash
node -e "require('sharp')('meme.jpg').resize(512,512,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).webp().toFile('figurinhas/manda-figurinha.webp')"
```

Também dá para usar as variáveis de ambiente `BOT_GRUPO`, `BOT_REMETENTE` e `BOT_IDS` (separados por vírgula).

Logs ficam em `bot.log`. Se o celular desconectar o bot, apague `.baileys_auth/` e rode `npm start` de novo para escanear o QR.
