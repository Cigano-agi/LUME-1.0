import {randomUUID} from 'node:crypto';
import {LEITURA_SQL,LEITURA_PESSOAL_SQL} from '../leitura-sql.js';
import {assinaturaFonte} from '../tarefas-esquema.js';
import {AcoesLume} from '../acoes-lume.js';
import {autoriaParaLaya} from './autoria.js';
import {eventoExcluido} from '../exclusoes.js';

// A interpretação contínua só pode nascer de uma fonte local dirigida ao dono
// (ou escrita por ele). Procedências importadas ficam disponíveis para leitura,
// mas nunca ampliam a fila de interpretação deste perfil.
const PESSOAL_SQL = `(e.permissao IN ('minha','dirigida','terceiro') AND NOT EXISTS(
  SELECT 1 FROM f10_procedencias fp WHERE fp.evento_id=e.id
))`;

// Preparar um backup não é reiniciar o worker: seus claims em curso ficam intactos.
export function prepararEsquemaFilaLaya(db,{recuperar=false}={}){
    db.exec(`CREATE TABLE IF NOT EXISTS desktop_config(chave TEXT PRIMARY KEY,valor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lume_laya_fila(
      evento_id INTEGER PRIMARY KEY REFERENCES eventos(id) ON DELETE CASCADE,
      conversa_id TEXT NOT NULL,
      fonte_assinatura TEXT NOT NULL,
      modo TEXT NOT NULL DEFAULT 'continuo' CHECK(modo IN('continuo','manual')),
      estado TEXT NOT NULL CHECK(estado IN('pendente','analisando','aguardando_modelo','abstido','erro')),
      motivo TEXT,
      criada_em TEXT NOT NULL,
      atualizada_em TEXT NOT NULL,
      duracao_ms INTEGER,
      tentativa_id TEXT
    );
    CREATE INDEX IF NOT EXISTS lume_laya_fila_estado ON lume_laya_fila(estado,evento_id);
    CREATE INDEX IF NOT EXISTS lume_laya_fila_conversa ON lume_laya_fila(conversa_id);
    CREATE TABLE IF NOT EXISTS lume_laya_agenda(
      conversa_id TEXT PRIMARY KEY,
      ultimo_turno INTEGER NOT NULL
    );`);
    if(!db.prepare('PRAGMA table_info(lume_laya_fila)').all().some(col=>col.name==='modo'))db.exec("ALTER TABLE lume_laya_fila ADD COLUMN modo TEXT NOT NULL DEFAULT 'continuo' CHECK(modo IN('continuo','manual'))");
    if(!db.prepare('PRAGMA table_info(lume_laya_fila)').all().some(col=>col.name==='tentativa_id'))db.exec('ALTER TABLE lume_laya_fila ADD COLUMN tentativa_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS lume_laya_fila_recente ON lume_laya_fila(estado,modo,evento_id DESC)');
    // Uma queda depois de reservar um item não o marca como concluído.
    if(recuperar)db.prepare("UPDATE lume_laya_fila SET estado='pendente',motivo='reinicio',tentativa_id=NULL WHERE estado='analisando'").run();
}

// A fila registra cobertura, nunca o texto da conversa. A aprovação do motor continua obrigatória.
export class FilaLaya {
  constructor(db,{laya,agora=()=>new Date(),intervaloMs=2000,podeProcessar=()=>true}={}){
    if(!laya||typeof laya.classificar!=='function'||typeof laya.status!=='function')throw new Error('Laya local obrigatório para a fila.');
    this.db=db;this.laya=laya;this.agora=agora;this.intervaloMs=intervaloMs;this.podeProcessar=podeProcessar;
    this.timer=null;this.proximo=null;this.rodando=null;this.fechado=false;this.turnosRecentes=0;this.sinalPendente=false;
    this.acoes=new AcoesLume(db,{agora});
    prepararEsquemaFilaLaya(db,{recuperar:true});
  }
  #lote(tabela,coluna,chave,limite){
    const config='laya-fila-cursor:'+chave;
    let state;
    try{state=JSON.parse(this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(config)?.valor||'null');}catch{}
    if(!state||!Number.isSafeInteger(state.cursor)||state.cursor<0||!Number.isSafeInteger(state.teto)||state.teto<state.cursor)
      state={cursor:0,teto:0};
    if(state.cursor>=state.teto)state={cursor:0,teto:this.db.prepare(`SELECT COALESCE(MAX(${coluna}),0) teto FROM ${tabela}`).get().teto};
    // LIMIT vem antes de qualquer filtro de elegibilidade. O teto fixo permite
    // voltar a fontes antigas mesmo enquanto novas mensagens continuam chegando.
    const ids=this.db.prepare(`SELECT ${coluna} id FROM ${tabela} WHERE ${coluna}>? AND ${coluna}<=? ORDER BY ${coluna} LIMIT ?`).all(state.cursor,state.teto,limite);
    const cursor=ids.length<limite?state.teto:ids.at(-1).id;
    return {ids,salvar:()=>this.db.prepare('INSERT INTO desktop_config VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor')
      .run(config,JSON.stringify({cursor,teto:state.teto}))};
  }
  limparSemPermissao({limite=100}={}){
    if(!Number.isInteger(limite)||limite<1||limite>100)throw new Error('Limite da limpeza inválido.');
    const lote=this.#lote('lume_laya_fila','evento_id','limpeza',limite);
    const agenda=this.#lote('lume_laya_agenda','rowid','agenda',limite);
    const item=this.db.prepare('SELECT conversa_id,modo FROM lume_laya_fila WHERE evento_id=?');
    const fonte=this.db.prepare(`SELECT e.conversa_id,e.origem_id FROM desktop_fontes e WHERE e.id=? AND
      ((?='continuo' AND ${LEITURA_PESSOAL_SQL} AND ${PESSOAL_SQL}) OR
       (?='manual' AND ${LEITURA_SQL} AND EXISTS(SELECT 1 FROM lume_acoes_conversas p WHERE p.conversa_id=e.conversa_id)))`);
    this.db.exec('SAVEPOINT laya_limpeza');
    try{
      for(const {id} of lote.ids){
        const row=item.get(id);if(!row)continue;
        const e=fonte.get(id,row.modo,row.modo);
        if(e&&!eventoExcluido(this.db,e.conversa_id,e.origem_id))continue;
        this.db.prepare('DELETE FROM lume_laya_fila WHERE evento_id=?').run(id);
        this.db.prepare('DELETE FROM lume_laya_agenda WHERE conversa_id=? AND NOT EXISTS(SELECT 1 FROM lume_laya_fila WHERE conversa_id=?)').run(row.conversa_id,row.conversa_id);
      }
      for(const {id} of agenda.ids)this.db.prepare(`DELETE FROM lume_laya_agenda WHERE rowid=?
        AND NOT EXISTS(SELECT 1 FROM lume_laya_fila WHERE conversa_id=lume_laya_agenda.conversa_id)`).run(id);
      lote.salvar();agenda.salvar();this.db.exec('RELEASE laya_limpeza');
    }catch(error){this.db.exec('ROLLBACK TO laya_limpeza;RELEASE laya_limpeza');throw error;}
  }
  capturarNovas({limite=100}={}){
    if(!Number.isInteger(limite)||limite<1||limite>100)throw new Error('Limite da fila inválido.');
    if(!this.podeProcessar())return 0;
    const lote=this.#lote('eventos','id','captura',Math.ceil(limite/2));
    const recentes=this.db.prepare('SELECT id FROM eventos ORDER BY id DESC LIMIT ?').all(limite-Math.ceil(limite/2));
    const fonte=this.db.prepare(`SELECT e.* FROM desktop_fontes e WHERE e.id=? AND
      e.tipo='texto' AND e.texto IS NOT NULL AND length(trim(e.texto))>0 AND ${LEITURA_PESSOAL_SQL} AND ${PESSOAL_SQL}`);
    const existe=this.db.prepare('SELECT 1 FROM lume_laya_fila WHERE evento_id=?');
    const linhas=[];
    for(const id of new Set([...lote.ids,...recentes].map(r=>r.id))){
      if(existe.get(id))continue;
      const row=fonte.get(id);
      if(row&&!eventoExcluido(this.db,row.conversa_id,row.origem_id))linhas.push(row);
    }
    const agora=this.agora().toISOString(),inserir=this.db.prepare("INSERT OR IGNORE INTO lume_laya_fila(evento_id,conversa_id,fonte_assinatura,estado,criada_em,atualizada_em) VALUES(?,?,?,'pendente',?,?)");
    this.db.exec('BEGIN IMMEDIATE');
    try{for(const row of linhas)inserir.run(row.id,row.conversa_id,assinaturaFonte(row),agora,agora);lote.salvar();this.db.exec('COMMIT');}
    catch(error){this.db.exec('ROLLBACK');throw error;}
    return linhas.length;
  }
  organizarConversa({conversa,limite=50}={}){
    if(typeof conversa!=='string'||!conversa||conversa.length>200||!Number.isInteger(limite)||limite<1||limite>100)throw Error('Recorte de conversa inválido.');
    if(!this.db.prepare('SELECT 1 FROM lume_acoes_conversas WHERE conversa_id=?').get(conversa))throw Error('Autorize esta conversa antes de organizar.');
    const linhas=this.db.prepare(`SELECT e.* FROM desktop_fontes e
      WHERE e.conversa_id=? AND e.tipo='texto' AND e.texto IS NOT NULL AND length(trim(e.texto))>0 AND ${LEITURA_SQL}
      ORDER BY e.id DESC LIMIT ?`).all(conversa,limite);
    const agora=this.agora().toISOString();
    const salvar=this.db.prepare(`INSERT INTO lume_laya_fila(evento_id,conversa_id,fonte_assinatura,modo,estado,criada_em,atualizada_em)
      VALUES(?,?,?,'manual','pendente',?,?)
      ON CONFLICT(evento_id) DO UPDATE SET fonte_assinatura=excluded.fonte_assinatura,modo='manual',
        estado=CASE WHEN lume_laya_fila.estado='analisando' THEN 'analisando' ELSE 'pendente' END,
        motivo=CASE WHEN lume_laya_fila.estado='analisando' THEN lume_laya_fila.motivo ELSE NULL END,
        tentativa_id=CASE WHEN lume_laya_fila.estado='analisando' THEN lume_laya_fila.tentativa_id ELSE NULL END,
        atualizada_em=excluded.atualizada_em`);
    this.db.exec('BEGIN IMMEDIATE');
    try{for(const row of linhas)salvar.run(row.id,row.conversa_id,assinaturaFonte(row),agora,agora);this.db.exec('COMMIT');}
    catch(error){this.db.exec('ROLLBACK');throw error;}
    this.sinalizar();
    return{conversa,selecionadas:linhas.length,limite};
  }
  cancelarConversa({conversa}={}){
    if(typeof conversa!=='string'||!conversa||conversa.length>200)throw Error('Conversa inválida.');
    const agora=this.agora().toISOString();
    const resultado=this.db.prepare(`UPDATE lume_laya_fila SET estado='abstido',motivo='cancelado_usuario',atualizada_em=?
      WHERE conversa_id=? AND modo='manual' AND estado IN('pendente','analisando','aguardando_modelo')`).run(agora,conversa);
    return{conversa,canceladas:resultado.changes};
  }
  estado(){
    this.limparSemPermissao();
    const row=this.db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN estado='pendente' THEN 1 ELSE 0 END) pendentes,
      SUM(CASE WHEN estado='analisando' THEN 1 ELSE 0 END) analisando,
      SUM(CASE WHEN estado='aguardando_modelo' AND motivo='modelo_ausente' THEN 1 ELSE 0 END) aguardandoModelo,
      SUM(CASE WHEN estado='aguardando_modelo' AND motivo='qualidade_pendente' THEN 1 ELSE 0 END) aguardandoValidacao,
      SUM(CASE WHEN motivo='acoes_sugeridas' THEN 1 ELSE 0 END) sugeridas,
      SUM(CASE WHEN estado='abstido' AND motivo NOT IN ('cancelado_usuario','acoes_sugeridas') THEN 1 ELSE 0 END) abstidas,
      SUM(CASE WHEN motivo='cancelado_usuario' THEN 1 ELSE 0 END) canceladas,
      SUM(CASE WHEN estado='erro' THEN 1 ELSE 0 END) erros,
      MAX(CASE WHEN estado='abstido' AND motivo IS NOT 'cancelado_usuario' THEN atualizada_em END) ultimaAnaliseEm
      FROM lume_laya_fila`).get();
    const conversas=this.db.prepare(`SELECT f.conversa_id id,COUNT(f.evento_id) total,
      SUM(CASE WHEN f.estado='pendente' OR f.estado='analisando' THEN 1 ELSE 0 END) naFila,
      SUM(CASE WHEN f.estado='aguardando_modelo' AND f.motivo='modelo_ausente' THEN 1 ELSE 0 END) aguardandoModelo,
      SUM(CASE WHEN f.estado='aguardando_modelo' AND f.motivo='qualidade_pendente' THEN 1 ELSE 0 END) aguardandoValidacao,
      SUM(CASE WHEN f.motivo='acoes_sugeridas' THEN 1 ELSE 0 END) sugeridas,
      SUM(CASE WHEN f.estado='abstido' AND f.motivo NOT IN ('cancelado_usuario','acoes_sugeridas') THEN 1 ELSE 0 END) abstidas,
      SUM(CASE WHEN f.modo='manual' AND f.estado IN('pendente','analisando','aguardando_modelo') THEN 1 ELSE 0 END) manuaisNaFila,
      SUM(CASE WHEN f.motivo='cancelado_usuario' THEN 1 ELSE 0 END) canceladas,
      SUM(CASE WHEN f.estado='erro' THEN 1 ELSE 0 END) erros,
      MAX(CASE WHEN f.estado='abstido' AND f.motivo IS NOT 'cancelado_usuario' THEN f.atualizada_em END) ultimaAnaliseEm
      FROM lume_laya_fila f
      GROUP BY f.conversa_id ORDER BY f.conversa_id`).all();
    return {...Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value??(key==='ultimaAnaliseEm'?null:0)])),conversas};
  }
  async passo(){
    if(this.fechado||this.rodando||!this.podeProcessar())return false;
    this.rodando=(async()=>{
      const modelo=this.laya.status();
      if(modelo.instalado!==true||modelo.aprovado!==true||modelo.avaliacao!=='aprovada'){
        const motivo=modelo.instalado!==true?'modelo_ausente':'qualidade_pendente';
        const lote=this.#lote('lume_laya_fila','evento_id','espera',100);
        const atualizar=this.db.prepare(`UPDATE lume_laya_fila SET estado='aguardando_modelo',motivo=?,atualizada_em=?
          WHERE evento_id=? AND estado IN('pendente','aguardando_modelo') AND (estado<>'aguardando_modelo' OR motivo IS NOT ?)`);
        this.db.exec('SAVEPOINT laya_espera');
        try{
          for(const {id} of lote.ids)atualizar.run(motivo,this.agora().toISOString(),id,motivo);
          lote.salvar();this.db.exec('RELEASE laya_espera');
        }catch(error){this.db.exec('ROLLBACK TO laya_espera;RELEASE laya_espera');throw error;}
        return false;
      }
      this.limparSemPermissao();
      this.capturarNovas();
      this.db.prepare("UPDATE lume_laya_fila SET estado='pendente',motivo=NULL WHERE evento_id IN(SELECT evento_id FROM lume_laya_fila WHERE estado='aguardando_modelo' ORDER BY evento_id DESC LIMIT 100)").run();
      // Um turno em três atende mensagens contínuas novas; os outros dois
      // atendem pedidos manuais. O décimo cobre histórico entre conversas.
      // A alternativa vazia usa o outro modo sem desperdiçar um turno.
      const turnoHistorico=this.turnosRecentes>=9;
      const modoPrioritario=this.turnosRecentes%3===0?'continuo':'manual';
      const item=turnoHistorico
        ?this.db.prepare(`SELECT f.evento_id,f.fonte_assinatura,f.conversa_id,f.modo FROM lume_laya_fila f
          LEFT JOIN lume_laya_agenda a ON a.conversa_id=f.conversa_id WHERE f.estado='pendente'
          ORDER BY COALESCE(a.ultimo_turno,0),f.evento_id ASC LIMIT 1`).get()
        :this.db.prepare(`SELECT evento_id,fonte_assinatura,conversa_id,modo FROM lume_laya_fila
          WHERE estado='pendente' AND modo=? ORDER BY evento_id DESC LIMIT 1`).get(modoPrioritario)
          ||this.db.prepare(`SELECT evento_id,fonte_assinatura,conversa_id,modo FROM lume_laya_fila
            WHERE estado='pendente' AND modo=? ORDER BY evento_id DESC LIMIT 1`).get(modoPrioritario==='continuo'?'manual':'continuo');
      if(!item)return false;
      this.turnosRecentes=turnoHistorico?0:this.turnosRecentes+1;
      if(turnoHistorico)this.db.prepare(`INSERT INTO lume_laya_agenda(conversa_id,ultimo_turno)
        VALUES(?,(SELECT COALESCE(MAX(ultimo_turno),0)+1 FROM lume_laya_agenda))
        ON CONFLICT(conversa_id) DO UPDATE SET ultimo_turno=excluded.ultimo_turno`).run(item.conversa_id);
      const escopo=item.modo==='continuo'?`${LEITURA_PESSOAL_SQL} AND ${PESSOAL_SQL}`:LEITURA_SQL;
      const fonte=this.db.prepare(`SELECT e.* FROM desktop_fontes e
        WHERE e.id=? AND ${escopo}`).get(item.evento_id);
      if(!fonte||eventoExcluido(this.db,item.conversa_id,fonte.origem_id)){this.db.prepare('DELETE FROM lume_laya_fila WHERE evento_id=?').run(item.evento_id);return false;}
      const assinatura=assinaturaFonte(fonte);
      if(assinatura!==item.fonte_assinatura){this.db.prepare("UPDATE lume_laya_fila SET fonte_assinatura=?,estado='pendente',motivo='fonte_alterada' WHERE evento_id=?").run(assinatura,item.evento_id);return false;}
      const inicio=performance.now();
      const tentativaId=randomUUID();
      this.db.prepare("UPDATE lume_laya_fila SET estado='analisando',motivo=NULL,tentativa_id=?,atualizada_em=? WHERE evento_id=?").run(tentativaId,this.agora().toISOString(),item.evento_id);
      let motivo='sem_acao',estado='abstido',candidatas=[];
      try{
        if(fonte.texto.length>2000){motivo='texto_longo';}
        else if(autoriaParaLaya(fonte)==='terceiro'){motivo='fonte_terceiro';}
        else if(typeof this.laya.extrairAcoes!=='function'){estado='erro';motivo='extrator_indisponivel';}
        else{
          const resultado=await this.laya.extrairAcoes({
            texto:fonte.texto,fonte:'E'+fonte.id,
            canal:fonte.conversa_id.endsWith('@g.us')?'grupo':'dm',
            autor:autoriaParaLaya(fonte),autorId:fonte.autor_id??null
          });
          if(!Array.isArray(resultado?.candidatas))throw Error('LAYA_SAIDA_INVALIDA');
          candidatas=resultado.candidatas;motivo=candidatas.length?'acoes_sugeridas':'sem_acao';
        }
      }catch(error){estado=error?.message==='LAYA_NAO_INSTALADO'?'aguardando_modelo':'erro';motivo=estado==='aguardando_modelo'?'modelo_ausente':error?.message==='LAYA_SAIDA_INVALIDA'?'saida_invalida':'falha_local';}
      // A revogação ou edição ocorrida durante a inferência vence o resultado.
      const tentativaAtual=this.db.prepare('SELECT motivo,tentativa_id FROM lume_laya_fila WHERE evento_id=?').get(item.evento_id);
      if(tentativaAtual?.tentativa_id!==tentativaId||tentativaAtual.motivo==='cancelado_usuario')return false;
      if(!this.podeProcessar()){
        this.db.prepare("UPDATE lume_laya_fila SET estado='pendente',motivo='aceite_pendente',tentativa_id=NULL,atualizada_em=? WHERE evento_id=?")
          .run(this.agora().toISOString(),item.evento_id);
        return false;
      }
      // A aprovação pode ser retirada enquanto o worker ainda está inferindo.
      const qualidadeAtual=this.laya.status();
      if(qualidadeAtual.aprovado!==true||qualidadeAtual.avaliacao!=='aprovada'){
        this.db.prepare("UPDATE lume_laya_fila SET estado='aguardando_modelo',motivo='qualidade_pendente',tentativa_id=NULL,atualizada_em=? WHERE evento_id=?")
          .run(this.agora().toISOString(),item.evento_id);
        return false;
      }
      const atual=this.db.prepare(`SELECT e.* FROM desktop_fontes e
        WHERE e.id=? AND ${escopo}`).get(item.evento_id);
      if(!atual||eventoExcluido(this.db,item.conversa_id,atual.origem_id)){this.db.prepare('DELETE FROM lume_laya_fila WHERE evento_id=?').run(item.evento_id);return false;}
      const assinaturaAtual=assinaturaFonte(atual);
      if(assinaturaAtual!==item.fonte_assinatura){this.db.prepare("UPDATE lume_laya_fila SET fonte_assinatura=?,estado='pendente',motivo='fonte_alterada',atualizada_em=? WHERE evento_id=?").run(assinaturaAtual,this.agora().toISOString(),item.evento_id);return false;}
      if(autoriaParaLaya(atual)!==autoriaParaLaya(fonte)){
        this.db.prepare("UPDATE lume_laya_fila SET estado='pendente',motivo='autoria_alterada',tentativa_id=NULL,atualizada_em=? WHERE evento_id=?")
          .run(this.agora().toISOString(),item.evento_id);
        return false;
      }
      if(estado==='abstido'&&candidatas.length){
        try{this.acoes.registrar({eventoId:item.evento_id,candidatas});}
        catch{estado='erro';motivo='saida_invalida';}
      }
      this.db.prepare('UPDATE lume_laya_fila SET estado=?,motivo=?,atualizada_em=?,duracao_ms=? WHERE evento_id=?')
        .run(estado,motivo,this.agora().toISOString(),Math.round(performance.now()-inicio),item.evento_id);
      return true;
    })().finally(()=>{
      this.rodando=null;
      if(this.sinalPendente&&!this.fechado){this.sinalPendente=false;this.agendarProximo();}
    });
    return this.rodando;
  }
  agendarProximo(){
    if(this.fechado||this.proximo)return;
    this.proximo=setTimeout(()=>{this.proximo=null;this.sinalizar();},25);
    this.proximo.unref?.();
  }
  sinalizar(){
    if(this.fechado)return;
    if(this.rodando){this.sinalPendente=true;return;}
    void this.passo().then(processado=>{
      if(processado)this.agendarProximo();
    }).catch(()=>{});
  }
  iniciar(){if(this.timer||this.fechado)return;this.timer=setInterval(()=>this.sinalizar(),this.intervaloMs);this.timer.unref?.();this.sinalizar();}
  async parar(){this.fechado=true;this.sinalPendente=false;if(this.timer)clearInterval(this.timer);if(this.proximo)clearTimeout(this.proximo);this.timer=null;this.proximo=null;await this.rodando;}
}
