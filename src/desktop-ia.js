import { randomUUID } from 'node:crypto';
import {assinaturaFonte} from './tarefas-esquema.js';
import { diaLocal } from './relogio.js';
import { prepararRecuperacao, recuperar, recorte, LEITURA_SQL, IA_SQL } from './recuperacao.js';
import { chamarGemini, pedidoGemini, reservarMicros, conferirResposta, MODELO_DESKTOP, PRECO_DESKTOP } from './gemini-desktop.js';
import { fundirRankings } from './semantica.js';
import {avisosFonte} from './fontes-desktop.js';
import {contextoProximo,conferirRecorteConsulta} from './contexto-recuperacao.js';

const segredoAusente = { estado: async () => ({ disponivel: false, configurada: false }), ler: async () => { throw new Error('Configure a chave no aplicativo desktop.'); }, gravar: async () => { throw new Error('Armazenamento seguro indisponível.'); }, remover: async () => {} };
const fontePublica = e => ({ fonte: 'E'+e.id, id: e.id, conversa_id: e.conversa_id, origem_id: e.origem_id, recebido_em: e.recebido_em,
  conversa_nome: e.conversa_nome, autor_nome: e.autor_nome, permissao: e.permissao, avisos:avisosFonte(e),texto: (e.trecho || e.texto).slice(0,1800), truncada: Boolean(e.trecho) || e.texto.length > 1800,
  ...(e.contextoProximo?{contextoProximo:e.contextoProximo}:{}) });

export class DesktopIA {
  constructor(db, { segredos = segredoAusente, gerar = chamarGemini, agora = () => new Date(), semantica = null } = {}) {
    this.db = db; this.segredos = segredos; this.gerar = gerar; this.agora = agora;
    this.previas = new Map(); this.ativos = new Set(); this.operacoes = new Map();
    this.semantica = semantica;
    db.exec(`CREATE TABLE IF NOT EXISTS desktop_ia_config (id INTEGER PRIMARY KEY CHECK(id=1), habilitada INTEGER NOT NULL DEFAULT 0, limite_micros INTEGER NOT NULL DEFAULT 500000, revisao INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO desktop_ia_config(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS desktop_ia_conversas (conversa_id TEXT PRIMARY KEY, permitida INTEGER NOT NULL CHECK(permitida IN(0,1)), decidido_em TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_ia_gastos (id TEXT PRIMARY KEY, dia TEXT NOT NULL, reservado_micros INTEGER NOT NULL, estado TEXT NOT NULL, criado_em TEXT NOT NULL, entrada_tokens INTEGER, saida_tokens INTEGER);
      CREATE INDEX IF NOT EXISTS desktop_ia_gastos_dia ON desktop_ia_gastos(dia);`);
    prepararRecuperacao(db);
  }
  config() { return this.db.prepare('SELECT * FROM desktop_ia_config WHERE id=1').get(); }
  invalidar() {
    this.previas.clear();
    this.db.prepare('UPDATE desktop_ia_config SET revisao=revisao+1 WHERE id=1').run();
    for (const controller of this.ativos) controller.abort();
  }
  cancelar({id}={}) {
    if(typeof id!=='string'||id.length>100)throw new Error('Operação inválida.');
    const previa=this.previas.get(id),ativa=this.operacoes.get(id);
    if(previa){previa.cancelada=true;this.previas.delete(id);}
    if(ativa){ativa.previa.cancelada=true;ativa.controller.abort();}
    return {cancelada:Boolean(previa||ativa),aviso:'Cancelamento solicitado. Dados já enviados não podem ser recolhidos; reservas existentes permanecem.'};
  }
  gasto() { return this.db.prepare('SELECT COALESCE(SUM(reservado_micros),0) total FROM desktop_ia_gastos WHERE dia=?').get(diaLocal(this.agora())).total; }
  async estado() {
    const cfg = this.config(), secret = await this.segredos.estado();
    return { habilitada: Boolean(cfg.habilitada), limiteUSD: cfg.limite_micros / 1e6, reservadoUSD: this.gasto() / 1e6,
      chaveConfigurada: secret.configurada, protecaoDisponivel: secret.disponivel, modelo: MODELO_DESKTOP, preco: PRECO_DESKTOP,
      conversas: this.db.prepare(`SELECT c.id,c.nome,COALESCE(a.permitida,0) permitida FROM conversas_app c LEFT JOIN desktop_ia_conversas a ON a.conversa_id=c.id ORDER BY c.nome LIMIT 1000`).all(),
      aviso: 'O limite reserva o custo máximo estimado por pedido neste perfil, inclusive falhas. A cobrança real é feita pelo Google e pode diferir. Outros aplicativos não entram neste limite.' };
  }
  async configurar({ habilitada, limiteUSD, chave, cienteEnvio } = {}) {
    if (typeof habilitada !== 'boolean' || typeof limiteUSD !== 'number' || !Number.isFinite(limiteUSD) || limiteUSD < 0 || limiteUSD > 20) throw new Error('Escolha um limite diário entre US$0 e US$20.');
    if (habilitada && cienteEnvio !== true) throw new Error('Confirme que entende o envio de dados ao Google.');
    if (chave !== undefined && (typeof chave !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(chave))) throw new Error('Formato de chave inválido.');
    this.invalidar();
    this.db.prepare('UPDATE desktop_ia_config SET habilitada=0 WHERE id=1').run();
    const revisao = this.config().revisao;
    if (chave) await this.segredos.gravar(chave);
    const secret = await this.segredos.estado();
    if (this.config().revisao !== revisao) throw new Error('As configurações mudaram. Confira o estado atual.');
    if (habilitada && (!secret.disponivel || !secret.configurada)) throw new Error('Guarde sua chave com proteção do sistema antes de ativar.');
    this.db.prepare('UPDATE desktop_ia_config SET habilitada=?,limite_micros=? WHERE id=1').run(habilitada ? 1 : 0, Math.round(limiteUSD * 1e6));
    return this.estado();
  }
  async removerChave() {
    this.invalidar(); this.db.prepare('UPDATE desktop_ia_config SET habilitada=0 WHERE id=1').run();
    await this.segredos.remover(); return this.estado();
  }
  permitir({ conversa, permitida } = {}) {
    if (typeof conversa !== 'string' || typeof permitida !== 'boolean' || !this.db.prepare('SELECT 1 FROM conversas_app WHERE id=?').get(conversa)) throw new Error('Conversa inválida.');
    this.invalidar();
    this.db.prepare(`INSERT INTO desktop_ia_conversas VALUES(?,?,?) ON CONFLICT(conversa_id) DO UPDATE SET permitida=excluded.permitida,decidido_em=excluded.decidido_em`).run(conversa, permitida ? 1 : 0, this.agora().toISOString());
    return { ok: true };
  }
  async prepararConsulta(input = {}) {
    const modo=input.modo || 'lexical';
    if(!['lexical','hibrido','denso'].includes(modo))throw new Error('Modo de recuperação inválido.');
    if(modo==='lexical')return this.preparar(input);
    if(!this.config().habilitada)throw new Error('Ative a IA em Configurações.');
    if(!this.semantica)throw new Error('Busca por significado indisponível neste ambiente. Escolha textual.');
    const filtro=recorte(input,this.agora());
    const denso=await this.semantica.buscar(filtro);
    const fontes=modo==='denso'?denso:fundirRankings(recuperar(this.db,filtro,{limite:20}),denso);
    return this.preparar(input,fontes,modo);
  }
  preparar(input, fontesRecuperadas = null, modo = 'lexical') {
    const cfg = this.config();
    if (!cfg.habilitada) throw new Error('Ative a IA em Configurações. A busca local continua disponível.');
    if (diaLocal(this.agora()) > PRECO_DESKTOP.validoAte) throw new Error('Atualize a tabela de preços do aplicativo antes de usar IA.');
    const filtro = recorte(input, this.agora());
    if(input?.contextoProximo!==undefined&&typeof input.contextoProximo!=='boolean')throw new Error('Escolha se deseja incluir mensagens próximas.');
    const sementes = fontesRecuperadas || recuperar(this.db, filtro);
    const eventos=input?.contextoProximo===false?sementes:contextoProximo(this.db,sementes,filtro);
    if (!eventos.length) return { insuficiente: true, fontes: [], filtro, aviso: 'Não encontrei fontes nesse recorte com IA autorizada. Confira período e conversas nas configurações; nenhuma chamada foi feita.' };
    const fontes = eventos.map(fontePublica);
    const contexto = { pergunta: filtro.pergunta, periodo: { desde: filtro.desde, ate: filtro.ate, fuso: filtro.fuso }, fontes };
    const pedido = pedidoGemini(contexto);
    const contextoIds=JSON.stringify(eventos.map(e=>e.id));
    const conferirContexto=()=>{
      conferirRecorteConsulta(this.db,eventos,filtro);
      if(input?.contextoProximo!==false&&JSON.stringify(contextoProximo(this.db,sementes,filtro).map(e=>e.id))!==contextoIds)throw new Error('As mensagens próximas mudaram. Confira uma nova prévia.');
    };
    const resultado=this.registrarOperacao({eventos,fontes,pedido,tipo:'consulta',conferirContexto});
    return {...resultado,filtro,recuperacao:modo,contexto:{ativado:input?.contextoProximo!==false,adicionadas:eventos.length-sementes.length},cobertura:this.semantica?.estado()||null,aviso:'Confira os trechos abaixo. São candidatos e podem não responder à pergunta. Só a pergunta, período e estas fontes serão enviados ao Google ao confirmar. O recorte pode estar incompleto.'};
  }
  registrarOperacao({eventos,fontes,pedido,tipo,reservaMicros=null,conferirContexto=null}) {
    const cfg=this.config();
    if(!cfg.habilitada||diaLocal(this.agora())>PRECO_DESKTOP.validoAte)throw new Error('Ative a IA e confira a validade da tabela de preços.');
    const reserva=reservaMicros??reservarMicros(pedido);
    if(!Number.isSafeInteger(reserva)||reserva<1||reserva>20000000)throw new Error('Reserva de custo inválida.');
    if (reserva + this.gasto() > cfg.limite_micros) throw new Error('O limite diário não comporta esta consulta. Nenhum pedido foi enviado.');
    const id = randomUUID(), expira = this.agora().getTime() + 300000;
    for (const [k,p] of this.previas) if (p.expira < this.agora().getTime()) this.previas.delete(k);
    if (this.previas.size >= 20) this.previas.delete(this.previas.keys().next().value);
    this.previas.set(id, {tipo, fontes, hashes: eventos.map(e => ({ id: e.id, hash: assinaturaFonte(e) })), pedido, reserva, revisao: cfg.revisao, expira,conferirContexto });
    this.conferir(this.previas.get(id));
    return { id, expiraEm: new Date(expira).toISOString(),fontes,reservaUSD:reserva/1e6,modelo:MODELO_DESKTOP};
  }
  conferir(previa) {
    if(previa.cancelada)throw new Error('Operação cancelada. Nenhum resultado foi aplicado.');
    const cfg = this.config();
    if (!cfg.habilitada || cfg.revisao !== previa.revisao || this.agora().getTime() > previa.expira || diaLocal(this.agora()) > PRECO_DESKTOP.validoAte) throw new Error('A prévia expirou ou a permissão mudou. Prepare outra consulta.');
    for (const registro of previa.hashes) {
      const e = this.db.prepare(`SELECT e.* FROM desktop_fontes e WHERE e.id=? AND ${LEITURA_SQL} AND ${IA_SQL}`).get(registro.id);
      if (!e || assinaturaFonte(e) !== registro.hash) throw new Error('Uma fonte mudou ou foi revogada. Prepare outra consulta.');
    }
    previa.conferirContexto?.();
  }
  async responder(data={}) {
    return this.executarOperacao(data,{tipo:'consulta',conferirResultado:(dados,fontes)=>conferirResposta(dados,fontes),finalizar:(resposta,previa)=>({...resposta,fontes:resposta.insuficiente?[]:previa.fontes.filter(f=>resposta.afirmacoes.some(a=>a.fonte===f.fonte)),reservaUSD:previa.reserva/1e6,modelo:MODELO_DESKTOP})});
  }
  async executarOperacao({id,confirmar}={}, {tipo,conferirResultado,finalizar,antesDeEnviar=()=>{},gerar=this.gerar}) {
    if (confirmar !== true || typeof id !== 'string') throw new Error('Confirme o envio do recorte apresentado.');
    const previa = this.previas.get(id);
    if (!previa) throw new Error('Prévia ausente ou já utilizada. Prepare outra consulta.');
    if(previa.tipo!==tipo)throw new Error('Prévia de outra operação.');
    this.previas.delete(id); this.conferir(previa);
    const controller = new AbortController(); this.ativos.add(controller);
    this.operacoes.set(id,{previa,controller});
    try {
      const chave = await this.segredos.ler();
      this.conferir(previa); // IPC não abre janela entre revogação/cancelamento e envio.
      const dia = diaLocal(this.agora());
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.conferir(previa);antesDeEnviar();
        if (this.gasto() + previa.reserva > this.config().limite_micros) throw new Error('Limite diário atingido. Nenhum pedido foi enviado.');
        this.db.prepare('INSERT INTO desktop_ia_gastos(id,dia,reservado_micros,estado,criado_em) VALUES(?,?,?,?,?)').run(id,dia,previa.reserva,'reservado',this.agora().toISOString());
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      const result = await gerar({ chave, pedido: previa.pedido, signal: controller.signal });
      this.conferir(previa);
      if(controller.signal.aborted)throw new Error('Operação interrompida. Nenhum resultado foi aplicado.');
      const resposta = conferirResultado(result.dados, previa.fontes);
      const retorno=finalizar(resposta,previa);
      const safeCount = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
      this.db.prepare("UPDATE desktop_ia_gastos SET estado='concluido',entrada_tokens=?,saida_tokens=? WHERE id=?")
        .run(safeCount(result.uso?.promptTokenCount),safeCount(result.uso?.candidatesTokenCount),id);
      return retorno;
    } catch (error) { this.db.prepare("UPDATE desktop_ia_gastos SET estado='incerto' WHERE id=?").run(id); throw error; }
    finally { this.ativos.delete(controller);this.operacoes.delete(id); }
  }
}
