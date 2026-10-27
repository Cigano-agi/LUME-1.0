import { randomUUID } from 'node:crypto';
import { LEITURA_PESSOAL_SQL } from '../leitura-sql.js';
import { chaveConversa } from '../exclusoes.js';

const erro = (code, message) => Object.assign(new Error(message), { code });
const jidValido = value => typeof value === 'string' && /^[A-Za-z0-9._:-]+@(s\.whatsapp\.net|c\.us|lid|g\.us)$/.test(value) && value.length <= 160;
const LEASE_MS=120_000;
const LOTE_DESCOBERTA=100;

// Schema-only entry point for restore; no connection or startup observations.
export function prepararHistoricoWhatsApp(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS wa_cobertura (
      id INTEGER PRIMARY KEY CHECK(id=1), estado TEXT NOT NULL,
      observado_em TEXT NOT NULL, ultimo_lote_em TEXT, ultimo_historico_em TEXT);
      CREATE TABLE IF NOT EXISTS wa_interrupcoes (
        id TEXT PRIMARY KEY, inicio TEXT NOT NULL, fim TEXT, motivo TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wa_recuperacoes (
        id TEXT PRIMARY KEY, conversa_id TEXT NOT NULL, evento_id INTEGER,
        modo TEXT NOT NULL, estado TEXT NOT NULL, pedido_em TEXT NOT NULL,
        atualizado_em TEXT NOT NULL, recibo INTEGER NOT NULL DEFAULT 0, erro TEXT);
      CREATE INDEX IF NOT EXISTS wa_recuperacoes_conversa ON wa_recuperacoes(conversa_id,pedido_em);
      CREATE TABLE IF NOT EXISTS wa_retomadas (
        interrupcao_id TEXT NOT NULL, conversa_id TEXT NOT NULL,
        PRIMARY KEY(interrupcao_id,conversa_id));
      CREATE TABLE IF NOT EXISTS wa_fila_retomada (
        interrupcao_id TEXT NOT NULL REFERENCES wa_interrupcoes(id) ON DELETE CASCADE,
        conversa_id TEXT NOT NULL, estado TEXT NOT NULL,
        tentativas INTEGER NOT NULL DEFAULT 0, proxima_tentativa_em TEXT,
        ultimo_erro TEXT, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL,
        PRIMARY KEY(interrupcao_id,conversa_id));
      CREATE INDEX IF NOT EXISTS wa_fila_retomada_ordem ON wa_fila_retomada(estado,proxima_tentativa_em,criado_em);
      CREATE TRIGGER IF NOT EXISTS wa_recuperacao_removida AFTER DELETE ON eventos BEGIN
        DELETE FROM wa_recuperacoes WHERE evento_id=old.id;
        DELETE FROM wa_retomadas WHERE conversa_id=old.conversa_id
          AND NOT EXISTS(SELECT 1 FROM eventos WHERE conversa_id=old.conversa_id);
      END;
      CREATE TRIGGER IF NOT EXISTS wa_fila_retomada_removida AFTER DELETE ON eventos BEGIN
        DELETE FROM wa_fila_retomada WHERE conversa_id=old.conversa_id
          AND NOT EXISTS(SELECT 1 FROM eventos WHERE conversa_id=old.conversa_id);
      END;`);
}

/** A request receipt is NOT a proof of delivered history or complete coverage. */
export class HistoricoWhatsApp {
  #db; #agora; #pendentes = new Map(); #automatico = null; #timer = null; #conexao = null;
  #periodoDescoberto = null;
  constructor(db, { agora = () => new Date() } = {}) {
    this.#db = db; this.#agora = agora;
    prepararHistoricoWhatsApp(db);
    const anterior = db.prepare('SELECT * FROM wa_cobertura WHERE id=1').get();
    if (anterior && !db.prepare('SELECT 1 FROM wa_interrupcoes WHERE fim IS NULL').get()) {
      this.#interromper(anterior.observado_em, anterior.estado === 'desconectada' ? 'aplicativo_fechado' : 'reinicio');
    }
    // Outra instância pode continuar trabalhando neste banco. Claims ativos
    // permanecem intactos; um processo morto libera o job pelo vencimento.
    db.prepare(`UPDATE wa_recuperacoes SET estado='interrompida',atualizado_em=?,erro='APLICATIVO_REINICIADO'
      WHERE estado='solicitando' AND NOT EXISTS(SELECT 1 FROM wa_fila_retomada f
        WHERE f.conversa_id=wa_recuperacoes.conversa_id AND f.estado='solicitando'
          AND f.proxima_tentativa_em>?)`).run(this.#iso(),this.#iso());
  }
  #iso() { return this.#agora().toISOString(); }
  #interromper(inicio, motivo) {
    if (!this.#db.prepare('SELECT 1 FROM wa_interrupcoes WHERE fim IS NULL').get()) {
      this.#db.prepare('INSERT INTO wa_interrupcoes(id,inicio,motivo) VALUES(?,?,?)').run(randomUUID(), inicio, motivo);
    }
  }
  observarEstado({ estado }) {
    const antes = this.#db.prepare('SELECT * FROM wa_cobertura WHERE id=1').get();
    const agora = this.#iso();
    if (antes?.estado === 'conectada' && estado !== 'conectada') this.#interromper(agora, 'conexao_interrompida');
    if (estado === 'conectada') this.#db.prepare('UPDATE wa_interrupcoes SET fim=? WHERE fim IS NULL').run(agora);
    else if(this.#timer){clearTimeout(this.#timer);this.#timer=null;}
    this.#db.prepare(`INSERT INTO wa_cobertura(id,estado,observado_em) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET estado=excluded.estado,observado_em=excluded.observado_em`).run(estado, agora);
  }
  observarLote(lote, resultado = {}) {
    const agora = this.#iso();
    this.#db.prepare(`UPDATE wa_cobertura SET ultimo_lote_em=?,
      ultimo_historico_em=CASE WHEN ? THEN ? ELSE ultimo_historico_em END WHERE id=1`).run(agora, lote.type === 'history' ? 1 : 0, agora);
    // Record receipt separately. Do not infer request completion from an unrelated batch.
    return { recebido: true, persistencia_com_falhas: Number(resultado?.falhas || 0) > 0 };
  }
  async retomarAoReceber(conexao, lote) {
    // Capture all eligible anchors before starting the bounded network drain.
    if (lote.type !== 'notify' || conexao.estado().estado !== 'conectada') return;
    const periodo=this.#db.prepare('SELECT id,fim FROM wa_interrupcoes WHERE fim IS NOT NULL ORDER BY fim DESC,id DESC LIMIT 1').get();
    if(!periodo)return;
    const ids=[...new Set((lote.messages??[]).map(m=>m?.key?.remoteJid).filter(jidValido))];
    for(const conversaId of ids)this.#enfileirarConversa(periodo,conversaId);
    return this.drenarPendentes(conexao);
  }
  #enfileirarConversa(periodo,conversaId){
    if(!jidValido(conversaId))return;
    if(this.#db.prepare(`SELECT 1 FROM wa_fila_retomada WHERE conversa_id=? AND
      (interrupcao_id=? OR estado IN ('pendente','solicitando')) LIMIT 1`).get(conversaId,periodo.id))return;
    if(this.#db.prepare('SELECT 1 FROM priv_conversas_excluidas WHERE hash=?').get(chaveConversa(conversaId)))return;
    try{this.#ancora(conversaId,'retomar');}catch{return;}
    const agora=this.#iso();
    this.#db.prepare(`INSERT OR IGNORE INTO wa_fila_retomada
      (interrupcao_id,conversa_id,estado,tentativas,proxima_tentativa_em,ultimo_erro,criado_em,atualizado_em)
      VALUES (?,?,'pendente',0,?,NULL,?,?)`).run(periodo.id,conversaId,agora,agora,agora);
  }
  async #descobrirConversas(conexao){
    const periodo=this.#db.prepare('SELECT id,fim FROM wa_interrupcoes WHERE fim IS NOT NULL ORDER BY fim DESC,id DESC LIMIT 1').get();
    if(!periodo||this.#periodoDescoberto===periodo.id)return;
    // A conversa silenciosa não produzirá notify para se inscrever. Descobrir
    // pelo acervo, em páginas com cursor, antes de drenar os pedidos de rede.
    // A fila persistida deduplica uma nova varredura após reinício; nenhum novo
    // schema/cursor persistido é necessário. Uma âncora antiga não prova que o
    // WhatsApp entregará a lacuna: a cobertura permanece desconhecida.
    let cursor='';
    while(conexao.estado().estado==='conectada'){
      const rows=this.#db.prepare(`SELECT DISTINCT conversa_id FROM eventos
        WHERE conversa_id>? ORDER BY conversa_id LIMIT ?`).all(cursor,LOTE_DESCOBERTA);
      for(const row of rows)this.#enfileirarConversa(periodo,row.conversa_id);
      if(rows.length<LOTE_DESCOBERTA){this.#periodoDescoberto=periodo.id;return;}
      cursor=rows.at(-1).conversa_id;
      await new Promise(resolve=>setImmediate(resolve));
    }
  }
  drenarPendentes(conexao){
    if(conexao.estado().estado!=='conectada')return Promise.resolve();
    this.#conexao=conexao;
    if(this.#automatico)return this.#automatico;
    if(this.#timer){clearTimeout(this.#timer);this.#timer=null;}
    this.#automatico=(async()=>{
      await this.#descobrirConversas(conexao);
      let noTurno=0;
      while(conexao.estado().estado==='conectada'){
        const job=this.#db.prepare(`SELECT * FROM wa_fila_retomada WHERE
          (estado='pendente' OR estado='solicitando')
          AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em<=?)
          ORDER BY criado_em,interrupcao_id,conversa_id LIMIT 1`).get(this.#iso());
        if(!job)break;
        await this.#executarRetomada(conexao,job);
        if(++noTurno===3){noTurno=0;await new Promise(resolve=>setImmediate(resolve));}
      }
    })().finally(()=>{this.#automatico=null;this.#agendarRetomada();});
    return this.#automatico;
  }
  #agendarRetomada(){
    if(this.#timer||!this.#conexao||this.#conexao.estado().estado!=='conectada')return;
    const next=this.#db.prepare("SELECT MIN(proxima_tentativa_em) AS due FROM wa_fila_retomada WHERE estado IN ('pendente','solicitando')").get()?.due;
    if(!next)return;
    const delay=Math.max(0,Date.parse(next)-this.#agora().getTime());
    this.#timer=setTimeout(()=>{this.#timer=null;void this.drenarPendentes(this.#conexao).catch(()=>{});},Math.min(delay,2_147_483_647));
    this.#timer.unref?.();
  }
  async #executarRetomada(conexao,job){
    const key=[job.interrupcao_id,job.conversa_id],now=this.#iso(),token=`CLAIM:${randomUUID()}`;
    if(job.tentativas>=4){
      this.#db.prepare(`UPDATE wa_fila_retomada SET estado='falha',ultimo_erro='HISTORICO_FALHA',
        proxima_tentativa_em=NULL,atualizado_em=? WHERE interrupcao_id=? AND conversa_id=?
        AND estado IN ('pendente','solicitando') AND
        (proxima_tentativa_em IS NULL OR proxima_tentativa_em<=?)`).run(now,...key,now);
      return;
    }
    const lease=()=>new Date(this.#agora().getTime()+LEASE_MS).toISOString();
    const claimed=this.#db.prepare(`UPDATE wa_fila_retomada SET estado='solicitando',tentativas=tentativas+1,
      proxima_tentativa_em=?,ultimo_erro=?,atualizado_em=?
      WHERE interrupcao_id=? AND conversa_id=? AND
        estado IN ('pendente','solicitando') AND tentativas<4 AND
        (proxima_tentativa_em IS NULL OR proxima_tentativa_em<=?)`)
      .run(lease(),token,now,...key,now);
    if(claimed.changes!==1)return;
    const renovar=setInterval(()=>{
      try{this.#db.prepare(`UPDATE wa_fila_retomada SET proxima_tentativa_em=?,atualizado_em=?
        WHERE interrupcao_id=? AND conversa_id=? AND estado='solicitando' AND ultimo_erro=?`)
        .run(lease(),this.#iso(),...key,token);}
      catch{/* A tentativa de rede termina pelo timeout; lease vencido fica recuperável. */}
    },LEASE_MS/2);
    renovar.unref?.();
    const cancelar=code=>this.#db.prepare(`UPDATE wa_fila_retomada SET estado='cancelada',ultimo_erro=?,atualizado_em=?
      WHERE interrupcao_id=? AND conversa_id=? AND estado='solicitando' AND ultimo_erro=?`).run(code,this.#iso(),...key,token);
    try{
    if(this.#db.prepare('SELECT 1 FROM priv_conversas_excluidas WHERE hash=?').get(chaveConversa(job.conversa_id)))return cancelar('FONTE_EXCLUIDA');
    try{this.#ancora(job.conversa_id,'retomar');}catch{return cancelar('HISTORICO_SEM_ANCORA');}
    const periodo=this.#db.prepare('SELECT fim FROM wa_interrupcoes WHERE id=?').get(job.interrupcao_id);
    if(!periodo?.fim)return cancelar('HISTORICO_SEM_ANCORA');
    try{
      await this.recuperar(conexao,{conversaId:job.conversa_id});
      this.#db.prepare(`UPDATE wa_fila_retomada SET estado='aguardando_historico',ultimo_erro=NULL,
        proxima_tentativa_em=NULL,atualizado_em=?
        WHERE interrupcao_id=? AND conversa_id=? AND estado='solicitando' AND ultimo_erro=?`).run(this.#iso(),...key,token);
    }catch(e){
      const code=['HISTORICO_SEM_ANCORA','HISTORICO_FONTE_ALTERADA','FONTE_EXCLUIDA','HISTORICO_CANCELADO','HISTORICO_INDISPONIVEL'].includes(e?.code)?e.code:'HISTORICO_FALHA';
      if(['HISTORICO_SEM_ANCORA','HISTORICO_FONTE_ALTERADA','FONTE_EXCLUIDA'].includes(code))return cancelar(code);
      const disconnected=conexao.estado().estado!=='conectada';
      const attempts=job.tentativas+1;
      const final=attempts>=4;
      const delay=[30_000,120_000,600_000][Math.min(attempts-1,2)];
      this.#db.prepare(`UPDATE wa_fila_retomada SET estado=?,ultimo_erro=?,proxima_tentativa_em=?,atualizado_em=?
        WHERE interrupcao_id=? AND conversa_id=? AND estado='solicitando' AND ultimo_erro=?`).run(final?'falha':'pendente',code,
          final?null:new Date(this.#agora().getTime()+(disconnected?0:delay)).toISOString(),this.#iso(),...key,token);
    }
    }finally{clearInterval(renovar);}
  }
  #ancora(conversaId, modo, eventoId = null) {
    if (!jidValido(conversaId)) throw erro('CONVERSA_INVALIDA', 'Conversa inválida.');
    const ordem = modo === 'anteriores' ? 'ASC' : 'DESC';
    // Imported sources do not authorize requesting another account's history.
    const row = this.#db.prepare(`SELECT e.id,e.bruto,e.origem_id,e.recebido_em FROM eventos e
      WHERE e.conversa_id=? AND e.permissao<>'compartilhado' AND NOT EXISTS
        (SELECT 1 FROM f10_procedencias fp WHERE fp.evento_id=e.id)
        AND ${LEITURA_PESSOAL_SQL} ${eventoId === null ? '' : 'AND e.id=?'}
      ORDER BY e.recebido_em ${ordem},e.id ${ordem} LIMIT 1`).get(...(eventoId === null ? [conversaId] : [conversaId, eventoId]));
    if (!row) throw erro('HISTORICO_SEM_ANCORA', 'Ainda não há mensagem local permitida para recuperar esta conversa.');
    let mensagem;
    try { mensagem = JSON.parse(row.bruto)?.mensagem; } catch {}
    const chave = mensagem?.key;
    const timestamp = Number(mensagem?.messageTimestamp) * 1000;
    if (!chave || chave.remoteJid !== conversaId || chave.id !== row.origem_id || typeof chave.fromMe !== 'boolean' || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw erro('HISTORICO_SEM_ANCORA', 'A mensagem local não contém uma referência válida do WhatsApp.');
    }
    return { eventoId: row.id, chave: { remoteJid: conversaId, id: chave.id, fromMe: chave.fromMe }, timestamp };
  }
  estado({ conversaId } = {}) {
    if (conversaId !== undefined) this.#ancora(conversaId, 'retomar');
    const conexao = this.#db.prepare('SELECT estado,observado_em,ultimo_lote_em,ultimo_historico_em FROM wa_cobertura WHERE id=1').get() ?? null;
    const filtro = conversaId ? 'AND e.conversa_id=?' : '';
    const cobertura = this.#db.prepare(`SELECT COUNT(*) AS mensagens,MIN(e.recebido_em) AS primeira_em,MAX(e.recebido_em) AS ultima_em
      FROM eventos e WHERE ${LEITURA_PESSOAL_SQL} ${filtro}`).get(...(conversaId ? [conversaId] : []));
    const tentativas = conversaId ? this.#db.prepare(`SELECT id,modo,estado,pedido_em,atualizado_em,recibo,erro
      FROM wa_recuperacoes WHERE conversa_id=? ORDER BY pedido_em DESC,id DESC LIMIT 10`).all(conversaId) : [];
    return { cobertura: 'desconhecida', conexao, armazenado: { ...cobertura },
      interrupcoes: this.#db.prepare('SELECT inicio,fim,motivo FROM wa_interrupcoes ORDER BY inicio DESC LIMIT 20').all(),
      tentativas, aviso: 'O WhatsApp pode fornecer apenas parte do histórico. Mensagens armazenadas não comprovam cobertura completa.' };
  }
  async recuperar(conexao, { conversaId, modo = 'retomar' } = {}) {
    if (!['retomar', 'anteriores'].includes(modo)) throw erro('MODO_INVALIDO', 'Modo de recuperação inválido.');
    const ancora = this.#ancora(conversaId, modo);
    if (this.#pendentes.has(conversaId)) return this.#pendentes.get(conversaId);
    const recente = this.#db.prepare('SELECT pedido_em FROM wa_recuperacoes WHERE conversa_id=? ORDER BY pedido_em DESC LIMIT 1').get(conversaId);
    if (recente && Date.parse(this.#iso()) - Date.parse(recente.pedido_em) < 30_000) throw erro('HISTORICO_AGUARDE', 'Aguarde a resposta do WhatsApp antes de pedir novamente.');
    const id = randomUUID(), quando = this.#iso();
    this.#db.prepare(`INSERT INTO wa_recuperacoes(id,conversa_id,evento_id,modo,estado,pedido_em,atualizado_em)
      VALUES(?,?,?,?,'solicitando',?,?)`).run(id, conversaId, ancora.eventoId, modo, quando, quando);
    const trabalho = Promise.resolve().then(async () => {
      try {
        await conexao.solicitarHistorico({ chave: ancora.chave, timestamp: ancora.timestamp, limite: 50 });
        // A source may be removed or its permission changed while the network request is in flight.
        const atual = this.#ancora(conversaId, modo, ancora.eventoId);
        if (atual.eventoId !== ancora.eventoId) throw erro('HISTORICO_FONTE_ALTERADA', 'A referência da conversa mudou; confira o histórico recebido.');
        this.#db.prepare("UPDATE wa_recuperacoes SET estado='aguardando_historico',recibo=1,atualizado_em=? WHERE id=?").run(this.#iso(), id);
        return { id, estado: 'aguardando_historico', cobertura: 'desconhecida', aviso: 'Pedido recebido pelo transporte. A chegada das mensagens depende do WhatsApp.' };
      } catch (e) {
        const codigo = ['HISTORICO_INDISPONIVEL', 'HISTORICO_CANCELADO', 'HISTORICO_SEM_ANCORA', 'HISTORICO_FONTE_ALTERADA'].includes(e?.code) ? e.code : 'HISTORICO_FALHA';
        this.#db.prepare("UPDATE wa_recuperacoes SET estado='falhou',erro=?,atualizado_em=? WHERE id=?").run(codigo, this.#iso(), id);
        throw erro(codigo, 'Não foi possível recuperar o histórico agora. As mensagens já guardadas continuam disponíveis.');
      } finally { this.#pendentes.delete(conversaId); }
    });
    this.#pendentes.set(conversaId, trabalho);
    return trabalho;
  }
}
