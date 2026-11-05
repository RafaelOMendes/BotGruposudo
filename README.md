# 🎙️ Bot do Gabreu

Bot de WhatsApp que fica de olho no grupo **Gruposudo**: quando o **Gabriel Lassen** manda uma mensagem só de interrogações (`?`, `??`, `????`…), ele responde (citando a mensagem) com o áudio [`audio/gabreu.ogg`](audio/gabreu.ogg) como mensagem de voz.

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

Também dá para usar as variáveis de ambiente `BOT_GRUPO`, `BOT_REMETENTE` e `BOT_IDS` (separados por vírgula).

Logs ficam em `bot.log`. Se o celular desconectar o bot, apague `.baileys_auth/` e rode `npm start` de novo para escanear o QR.
