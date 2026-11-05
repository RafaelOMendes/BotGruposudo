# 🎙️ Bot do Gabreu

Bot de WhatsApp que fica de olho no grupo **Gruposudo**: quando o **Gabriel Lassen** manda só `?`, ele responde (citando a mensagem) com o áudio [`audio/gabreu.ogg`](audio/gabreu.ogg) como mensagem de voz.

## Como usar

```bash
npm install
npm start
```

Na primeira vez aparece um QR code no terminal: abra o WhatsApp no celular → **Aparelhos conectados** → **Conectar aparelho** e escaneie. A sessão fica salva em `.wwebjs_auth/`, então não pede de novo.

Depois disso, feche o terminal (Ctrl+C). A partir daí o bot sobe sozinho quando o Windows liga.

## Inicialização automática

Um atalho `BotWhatsAudioGabreu.lnk` em `shell:startup` executa `start-oculto.vbs`, que roda `start.cmd` sem janela. O `start.cmd` reinicia o bot se ele cair.

## Configuração (opcional)

Variáveis de ambiente:

| Variável         | Padrão           | Para quê                                             |
| ---------------- | ---------------- | ---------------------------------------------------- |
| `BOT_GRUPO`      | `Gruposudo`      | Nome do grupo                                        |
| `BOT_REMETENTE`  | `Gabriel Lassen` | Nome do contato (salvo ou do perfil)                 |
| `BOT_NUMERO`     | —                | Número do Gabriel, só dígitos (mais confiável que nome) |
| `CHROME_PATH`    | Chrome padrão    | Caminho do Chrome usado pelo bot                     |

Logs ficam em `bot.log`.
