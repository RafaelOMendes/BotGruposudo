// Regras criadas pelo próprio grupo ("quando o Bernardo mandar X, faça Y"), salvas em regras.json.
// As ações possíveis são só mandar mensagens (texto, resposta da IA, meme, figurinha, áudio):
// nenhuma regra executa código ou mexe no PC.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_POR_GRUPO = 30;

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
  criar(jid, v, remetente, criadoPor) {
    if (this.doGrupo(jid).length >= MAX_POR_GRUPO) return { ok: false, erro: `limite de ${MAX_POR_GRUPO} regras no grupo` };
    const temTexto = v.regra_texto_modo !== 'nenhum' && v.regra_texto_valor.trim();
    if (!remetente.nome && !remetente.ids.length && v.regra_tipo_mensagem === 'qualquer' && !temTexto) {
      return { ok: false, erro: 'regra vaga demais (qualquer pessoa, qualquer mensagem)' };
    }
    if (v.regra_tipo_mensagem === 'texto' && temTexto && v.regra_texto_valor.trim().length < 2 && !remetente.nome && !remetente.ids.length) {
      return { ok: false, erro: 'condição de texto curta demais para qualquer pessoa' };
    }
    if (v.regra_acao_tipo === 'texto' && !v.regra_acao_conteudo.trim()) return { ok: false, erro: 'regra de texto sem texto' };

    const regra = {
      id: crypto.randomBytes(3).toString('hex'),
      grupo: jid,
      descricao: v.regra_descricao.slice(0, 200),
      criadoPor,
      criadoEm: new Date().toISOString(),
      remetente: { nome: remetente.nome.slice(0, 60), ids: remetente.ids },
      tipoMensagem: v.regra_tipo_mensagem,
      texto: temTexto ? { modo: v.regra_texto_modo, valor: v.regra_texto_valor.slice(0, 200) } : null,
      acao: { tipo: v.regra_acao_tipo, conteudo: v.regra_acao_conteudo.slice(0, 1000) },
      intervaloSeg: 30,
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
   * @param {object} msg { jid, tipo, texto, autorIds: string[], autorNome }
   */
  disparadas(msg) {
    const agora = Date.now();
    return this.doGrupo(msg.jid).filter((r) => {
      if (r.tipoMensagem !== 'qualquer' && r.tipoMensagem !== msg.tipo) return false;

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
      }

      if (agora - (this.ultimoDisparo.get(r.id) || 0) < (r.intervaloSeg || 30) * 1000) return false;
      this.ultimoDisparo.set(r.id, agora);
      return true;
    });
  }
}
