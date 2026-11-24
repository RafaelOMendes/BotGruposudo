// Regras criadas pelo próprio grupo ("quando o Bernardo mandar X, faça Y"), salvas em regras.json.
// As ações possíveis são mandar mensagens (texto, resposta da IA, meme, figurinha, áudio) ou apagar a
// mensagem que disparou (o bot é admin): nenhuma regra executa código ou mexe no PC.
// Também há regras fixas (MODELOS): prontas no código, a IA só escolhe qual criar.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_POR_GRUPO = 30;

// Regras prontas no código: a IA só escolhe o modelo (regra_modelo), não monta os campos.
export const MODELOS = {
  // Pedido do Bertolo (aceito pelo Rafa): o Nicolas falou do Bertolo ou do Bernardo → roteiro do Shrek no
  // privado dele. Vai o link de uma página pública com o roteiro (o texto em si tem direitos autorais).
  roteiro_shrek_privado: {
    descricao: 'Quando o Nicolas Bresolin falar do Bertolo ou do Bernardo (nome ou @), mando o roteiro do Shrek 1 no privado dele (no máximo 1 vez a cada 10 min)',
    remetente: { nome: 'Nicolas Bresolin', ids: ['173280573018177@lid', '555584411008@s.whatsapp.net'] },
    tipoMensagem: 'qualquer',
    // "algum": basta uma das palavras no texto da própria mensagem, ou uma @menção desses IDs.
    texto: { modo: 'algum', valor: 'bertolo | bernardo', valores: ['bertolo', 'bernardo', '144366903537743', '45376446971961'] },
    acao: {
      tipo: 'privado_texto',
      conteudo: [
        'Você falou do Bertolo ou do Bernardo no grupo, então aqui vai o roteiro inteiro do Shrek (2001) pra você ler com calma 🧅🟢',
        'https://imsdb.com/scripts/Shrek.html',
        '(Regra pedida pelo Bertolo e aprovada pelo Rafa. Toda vez que falar deles, chega de novo.)',
      ].join('\n\n'),
    },
    intervaloSeg: 600,
    porPessoa: true, // o intervalo conta para cada pessoa, não para a regra toda
  },
};

const normalizar = (s) =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export class Regras {
  constructor(dir) {
    this.arquivo = path.join(dir, 'regras.json');
    this.lista = fs.existsSync(this.arquivo) ? JSON.parse(fs.readFileSync(this.arquivo, 'utf8')) : [];
    this.ultimoDisparo = new Map(); // id -> timestamp
  }

  salvar() {
    fs.writeFileSync(this.arquivo, JSON.stringify(this.lista, null, 2) + '\n');
  }

  doGrupo(jid) {
    return this.lista.filter((r) => r.grupo === jid);
  }

  /** "id | descrição (criada por X)" por linha, para o prompt. */
  resumo(jid) {
    return this.doGrupo(jid)
      .map((r) => `${r.id} | ${r.descricao} (criada por ${r.criadoPor})`)
      .join('\n');
  }

  /**
   * Cria uma regra a partir da saída do Claude. Retorna { ok, regra } ou { ok: false, erro }.
   * @param {string} jid grupo
   * @param {object} v campos regra_* do interpretarMencao
   * @param {{nome: string, ids: string[]}} remetente quem dispara (ids vêm de @menções na mensagem)
   * @param {string} criadoPor
   */
  criar(jid, v, remetente, criadoPor, { figurinha = null } = {}) {
    if (this.doGrupo(jid).length >= MAX_POR_GRUPO) return { ok: false, erro: `limite de ${MAX_POR_GRUPO} regras no grupo` };
    const temTexto = v.regra_texto_modo !== 'nenhum' && v.regra_texto_valor.trim();
    if (!remetente.nome && !remetente.ids.length && v.regra_tipo_mensagem === 'qualquer' && !temTexto) {
      return { ok: false, erro: 'regra vaga demais (qualquer pessoa, qualquer mensagem)' };
    }
    if (v.regra_tipo_mensagem === 'texto' && temTexto && v.regra_texto_valor.trim().length < 2 && !remetente.nome && !remetente.ids.length) {
      return { ok: false, erro: 'condição de texto curta demais para qualquer pessoa' };
    }
    if (v.regra_acao_tipo === 'texto' && !v.regra_acao_conteudo.trim()) return { ok: false, erro: 'regra de texto sem texto' };
    if (v.regra_so_figurinha_citada && !figurinha) return { ok: false, erro: 'responda a figurinha que é para a regra valer' };
    const apagar = v.regra_acao_tipo === 'apagar';
    // Apagar precisa de algo específico: a figurinha, um texto, ou um tipo de mensagem de uma pessoa.
    if (apagar && !figurinha && !temTexto && !(v.regra_tipo_mensagem !== 'qualquer' && (remetente.nome || remetente.ids.length))) {
      return { ok: false, erro: 'regra de apagar ampla demais (diga a figurinha, a palavra ou o tipo de mensagem)' };
    }

    const regra = {
      id: crypto.randomBytes(3).toString('hex'),
      grupo: jid,
      descricao: v.regra_descricao.slice(0, 200),
      criadoPor,
      criadoEm: new Date().toISOString(),
      remetente: { nome: remetente.nome.slice(0, 60), ids: remetente.ids },
      tipoMensagem: figurinha ? 'figurinha' : v.regra_tipo_mensagem,
      figurinha: figurinha || null, // sha256 do arquivo: só essa figurinha dispara
      texto: temTexto ? { modo: v.regra_texto_modo, valor: v.regra_texto_valor.slice(0, 200) } : null,
      acao: { tipo: v.regra_acao_tipo, conteudo: v.regra_acao_conteudo.slice(0, 1000) },
      intervaloSeg: apagar ? 0 : 30,
    };
    this.lista.push(regra);
    this.salvar();
    return { ok: true, regra };
  }

  /** Cria uma regra fixa de MODELOS (uma por grupo: se já existe, devolve a que tem). */
  criarModelo(jid, nome, criadoPor) {
    const modelo = MODELOS[nome];
    if (!modelo) return { ok: false, erro: `não conheço a regra pronta "${nome}"` };
    const existente = this.doGrupo(jid).find((r) => r.modelo === nome);
    if (existente) return { ok: true, regra: existente, jaExistia: true };
    if (this.doGrupo(jid).length >= MAX_POR_GRUPO) return { ok: false, erro: `limite de ${MAX_POR_GRUPO} regras no grupo` };
    const regra = {
      id: crypto.randomBytes(3).toString('hex'),
      grupo: jid,
      modelo: nome,
      criadoPor,
      criadoEm: new Date().toISOString(),
      figurinha: null,
      ...structuredClone(modelo),
    };
    this.lista.push(regra);
    this.salvar();
    return { ok: true, regra };
  }

  apagar(jid, id) {
    const antes = this.lista.length;
    this.lista = this.lista.filter((r) => !(r.grupo === jid && r.id === id.trim()));
    if (this.lista.length === antes) return false;
    this.salvar();
    return true;
  }

  /**
   * Regras que batem com a mensagem (respeitando o intervalo de cada uma).
   * @param {object} msg { jid, tipo, texto, autorIds: string[], autorNome, figurinha (sha256 ou null), mencoes: string[] }
   */
  disparadas(msg) {
    const agora = Date.now();
    return this.doGrupo(msg.jid).filter((r) => {
      if (r.tipoMensagem !== 'qualquer' && r.tipoMensagem !== msg.tipo) return false;
      if (r.figurinha && r.figurinha !== msg.figurinha) return false;

      if (r.remetente.ids.length) {
        if (!r.remetente.ids.some((id) => msg.autorIds.includes(id))) return false;
      } else if (r.remetente.nome) {
        const nome = normalizar(msg.autorNome);
        const alvo = normalizar(r.remetente.nome);
        const bate = nome && (nome.includes(alvo) || alvo.includes(nome) ||
          alvo.split(/\s+/).some((p) => p.length >= 3 && nome.split(/\s+/).includes(p)));
        if (!bate) return false;
      }

      if (r.texto) {
        const t = normalizar(msg.texto);
        const v = normalizar(r.texto.valor);
        if (r.texto.modo === 'igual' && t !== v) return false;
        if (r.texto.modo === 'contem' && !t.includes(v)) return false;
        if (r.texto.modo === 'comeca' && !t.startsWith(v)) return false;
        if (r.texto.modo === 'algum') {
          const marcados = (msg.mencoes || []).map((j) => j.split('@')[0]);
          if (!r.texto.valores.some((p) => t.includes(normalizar(p)) || marcados.includes(p))) return false;
        }
      }

      const chave = r.porPessoa ? `${r.id}|${msg.autorIds[0] || msg.autorNome}` : r.id;
      if (agora - (this.ultimoDisparo.get(chave) || 0) < (r.intervaloSeg ?? 30) * 1000) return false;
      this.ultimoDisparo.set(chave, agora);
      return true;
    });
  }
}
