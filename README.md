# 🤖 Bot do Gruposudo

Bot de WhatsApp que fica de olho no grupo **Gruposudo**:

- 🎙️ Quando o **Gabriel Lassen** manda uma mensagem só de interrogações (`?`, `??`, `????`…), responde (citando a mensagem) com o áudio [`audio/gabreu.ogg`](audio/gabreu.ogg) como mensagem de voz.
- 🖼️ Quando o **Nicolas Bresolin** manda uma figurinha ou imagem, o Claude decide se ela é *non-sense* (via [Claude Code](https://claude.com/claude-code) no modo `claude -p`, usando o login que já está no PC; não precisa de chave de API). Se for, o próprio Claude escolhe a resposta: a figurinha clássica ("manda figurinha de gente animal" para figurinha, "manda imagem de gente animal" para imagem) ou um **meme novo** que ele monta na hora, escolhendo um template popular do [Imgflip](https://imgflip.com/memetemplates) e escrevendo o texto zoando.
- 💬 Quando alguém marca o bot (`@`) num grupo, o Claude lê a mensagem (com as últimas mensagens do grupo como contexto, a mensagem citada e imagens/figurinhas, se houver) e responde no mesmo tom de quem falou, como um amigo gente boa (pergunta séria → resposta direta; brincadeira → zoeira leve de volta). Quando pedem para pesquisar ou mandar algo, ele pesquisa de verdade na web e **baixa e envia o conteúdo no tipo do arquivo**: vídeo vai como vídeo, áudio como áudio, imagem como imagem, GIF como GIF, PDF/documento como documento (o bot olha o tipo real do arquivo baixado e converte com o ffmpeg o que o WhatsApp não toca, como WebM, MOV, WAV e OGG). Conteúdo de TikTok, X, YouTube, Instagram, Facebook, Threads, Reddit, Kwai, Pinterest etc. é sempre baixado e mandado como arquivo, não só o link. Vídeos e músicas de YouTube, TikTok, Instagram, X etc. são baixados com o [yt-dlp](https://github.com/yt-dlp/yt-dlp) (até 15 min e ~45 MB), e o [ffmpeg](https://ffmpeg.org) converte GIF/WebM para MP4 que o WhatsApp toca. Sem o yt-dlp o bot manda o link; sem o ffmpeg o GIF vai como figurinha animada. No Windows: `winget install yt-dlp.yt-dlp Gyan.FFmpeg`. O Claude roda sem acesso a arquivos ou comandos do PC (só à web), e os downloads só aceitam https de endereços públicos, com limite de tamanho, e documentos só em formatos inofensivos (PDF, Office, TXT...; nada de .exe/.bat/.apk).
- 🔗 Quando alguém manda um **link de TikTok, Instagram, X, YouTube, Facebook, Threads, Kwai, Pinterest...** no grupo, o bot baixa e manda o vídeo (sem precisar marcar). Posts que só abrem logado precisam de um `cookies.txt` (veja abaixo).
- 🖼️ **Figurinha sob demanda:** marca o bot (ou responde a mensagem dele) pedindo figurinha: de uma imagem mandada/respondida (com texto opcional), de um meme, de uma imagem da web ou só de texto (com cor).
- ↩️ **Responder o bot conta como falar com ele:** usar a função "responder" do WhatsApp numa mensagem do bot já faz ele responder, sem precisar marcar.
- ❓ **Na dúvida, pergunta:** se o pedido não estiver claro (qual vídeo, que texto vai na figurinha...), o bot pergunta em vez de chutar.
- 🤖 **Serviço fica evidente:** quando o bot faz algo (baixar vídeo, fazer figurinha, criar/apagar regra), a mensagem vem com `🤖 Serviço: ...` no topo; respostas comuns não.
- 🎨 **Gera imagem e figurinha com IA local:** "@bot gera uma imagem de..." ou "faz uma figurinha de..." usa o [ComfyUI](https://github.com/Comfy-Org/ComfyUI) com o modelo Z-Image Turbo na placa de vídeo (AMD via ROCm). Leva ~1,5 min por imagem; o bot avisa quando começa. Config em `gerador` (pasta do ComfyUI portátil). O ComfyUI é ligado sob demanda e libera a VRAM após 5 min sem uso.
- 🧩 **O grupo cria regras novas** marcando o bot, em linguagem normal (veja abaixo).
- 📚 **Avisa entregas da faculdade** (Moodle e Google Classroom) no grupo: às **12h** o que vence hoje; às **22h** o que vence hoje a partir das 22:10; e às **20h** o que vence amanhã antes das 22:10 (aviso na véspera). O Claude decide se a atividade vale nota ou parece importante (fóruns opcionais e avisos de abertura ficam de fora) e a mensagem diz quanto vale, ou que não sabe. Config em `entregas`: `moodle` = link de Calendário → Exportar calendário → Obter URL; `calendarios` = outros links iCal; `classroom` = ID do cliente OAuth (app para computador) e depois `node classroom.mjs --login` (se o login expirar, o bot abre o navegador sozinho para entrar de novo). Marcando o bot e perguntando ("tem trabalho semana que vem?"), ele consulta o Moodle e o Classroom na hora e responde com nome, disciplina, prazo e nota. Teste sem mandar nada: `node entregas.mjs --teste 12 --data 2026-11-09`.

## Regras criadas pelo grupo

Qualquer pessoa marca o bot e pede, por exemplo:

- `@bot quando o Bernardo mandar bom dia, xinga ele de preguiçoso`
- `@bot toda vez que o @Joao mandar áudio, responde com um meme zoando`
- `@bot quando alguém falar "churrasco", manda o áudio do Gabreu`
- `@bot quais regras tem?` / `@bot apaga a regra do Bernardo`

O Claude transforma o pedido numa regra (quem, que tipo de mensagem, qual texto) e numa ação:

| Ação | O que o bot faz |
| --- | --- |
| `texto` | manda sempre o mesmo texto |
| `ia` | o Claude escreve uma resposta na hora, seguindo a instrução da regra |
| `meme` | o Claude monta um meme zoando a mensagem |
| `figurinha_padrao` | manda a figurinha clássica |
| `audio_gabreu` | manda o áudio do Gabreu |

As regras ficam em `regras.json` (fora do git), valem só no grupo onde foram criadas, têm intervalo de 30 s entre disparos e são no máximo 30 por grupo. Regras vagas demais (qualquer pessoa + qualquer mensagem) são recusadas. Marcar a pessoa com `@` ao criar a regra identifica ela pelo ID, que é mais confiável que o nome.

Feito com [Baileys](https://github.com/WhiskeySockets/Baileys), que fala o protocolo do WhatsApp direto (sem navegador). Os pedidos de reenvio dos aparelhos que não conseguem abrir a mensagem (o "Aguardando mensagem" do iPhone) são atendidos automaticamente.

## Como usar

```bash
npm install
npm start
```

Na primeira vez aparece um QR code no terminal (e também em http://localhost:3999, caso o terminal corte o QR): abra o WhatsApp no celular → **Aparelhos conectados** → **Conectar aparelho** e escaneie. A sessão fica salva em `.baileys_auth/`, então não pede de novo.

Depois disso, feche o terminal (Ctrl+C). A partir daí o bot sobe sozinho quando o Windows liga.

## Inicialização automática

Um atalho `BotGruposudo.lnk` em `shell:startup` executa `start-oculto.vbs`, que roda `start.cmd` sem janela. O `start.cmd` reinicia o bot se ele cair (e para se já houver outra instância rodando ou se a sessão for desconectada pelo celular).

## Configuração

Copie `config.example.json` para `config.json` (fica fora do git) e ajuste:

| Campo       | Para quê                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `grupo`     | Nome do grupo                                                            |
| `remetente` | Nome de perfil da pessoa (usado só se `ids` estiver vazio)               |
| `ids`       | IDs do WhatsApp da pessoa (`...@lid` ou `número@s.whatsapp.net`) — mais confiável |
| `figurinha.remetente` / `figurinha.ids` | Quem dispara a resposta com figurinha (mesma lógica de `remetente`/`ids`) |
| `figurinha.arquivo` | Figurinha de resposta quando ele manda **figurinha**: `.webp` 512×512 (a pasta `figurinhas/` fica fora do git) |
| `figurinha.arquivoImagem` | Figurinha de resposta quando ele manda **imagem** |
| `figurinha.intervaloSeg` | Intervalo mínimo entre respostas com figurinha (padrão 60 s) |
| `figurinha.chanceSemIA` | Se o `claude` não estiver instalado: chance de responder mesmo assim (1 = sempre, 0 = nunca) |
| `mencao.ativo` | Liga/desliga as respostas quando marcam o bot (padrão: ligado) |
| `mencao.intervaloSeg` | Intervalo mínimo entre respostas para a mesma pessoa (padrão 10 s) |
| `mencao.historico` | Quantas mensagens recentes vão como contexto normalmente (padrão 8). O Claude decide se a mensagem continua o assunto ou é assunto novo (e aí ignora o histórico) |
| `mencao.historicoLeitura` | Quantas mensagens ele lê quando pedem ("lê aí", "resume a conversa", "o que o fulano falou?") (padrão 60) |
| `links.ativo` / `links.intervaloSeg` | Liga/desliga o download automático de links de redes sociais (padrão: ligado, 5 s entre links) |
| `cookies` | Arquivo `cookies.txt` (formato Netscape) de uma conta logada, para o yt-dlp baixar posts que exigem login (padrão: `cookies.txt` na pasta do bot; fica fora do git). Dá para exportar com a extensão "Get cookies.txt LOCALLY" no navegador. Use uma conta secundária. |
| `ytdlp` / `ffmpeg` | Caminhos do yt-dlp e do ffmpeg (padrão: no PATH; ou variáveis `YTDLP_PATH` / `FFMPEG_PATH`) |
| `modelos` | Modelo/esforço por tarefa. Padrão: tudo no **Claude Haiku 5.5**; o **Claude Sonnet 5.5** só entra quando o Haiku marca que o pedido é complexo demais. Opus e acima são bloqueados. Ex.: `{"mencao": {"esforco": "low"}}` |
| `claude` | Caminho do Claude Code CLI (padrão: `claude` no PATH; ou variável `CLAUDE_CLI_PATH`) |

Para criar uma figurinha a partir de qualquer imagem:

```bash
node -e "require('sharp')('meme.jpg').resize(512,512,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).webp().toFile('figurinhas/manda-figurinha.webp')"
```

Também dá para usar as variáveis de ambiente `BOT_GRUPO`, `BOT_REMETENTE` e `BOT_IDS` (separados por vírgula).

Logs ficam em `bot.log`. Se o celular desconectar o bot, apague `.baileys_auth/` e rode `npm start` de novo para escanear o QR.
