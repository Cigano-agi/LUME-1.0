import {randomUUID} from 'node:crypto';
import {avaliarComJev,JEV_MODELO} from '../vendas/jev.js';
import {prepararVendasJev} from '../vendas/servico.js';
import {lerFontesVendas,hashFontesVendas,revisaoVendas} from '../vendas/recorte.js';
const CHAVE='pessoal-classificador';
const etapa='classificacao_pessoal';
// Independent worker, shared durable stages and sales records. No reply capability.
export class ClassificadorPessoal {
  constructor(db,{pessoal,segredos,avaliar=avaliarComJev,agora=()=>new Date()}={}){
    this.db=db;this.pessoal=pessoal;this.segredos=segredos;this.avaliar=avaliar;this.agora=agora;this.running=null;this.timer=null;this.controller=new AbortController();
    prepararVendasJev(db);
    db.prepare("UPDATE etapas SET estado='falha',ultimo_erro='CLASSIFICACAO_INTERROMPIDA',lease_token=NULL,lease_ate=NULL WHERE etapa=? AND estado='em_curso'").run(etapa);
    db.exec(`DROP TRIGGER IF EXISTS pessoal_classificar_novo;
      CREATE TRIGGER pessoal_classificar_novo AFTER INSERT ON eventos
      WHEN NEW.do_proprio_bot=0 AND NEW.direcao='entrada' AND json_valid(NEW.bruto) AND json_extract(NEW.bruto,'$.tipoLote')='notify'
      AND EXISTS(SELECT 1 FROM desktop_config WHERE chave='pessoal-enabled' AND valor='1')
      AND EXISTS(SELECT 1 FROM desktop_config WHERE chave='${CHAVE}' AND CASE WHEN json_valid(valor) THEN json_extract(valor,'$.enabled')=1 ELSE 0 END)
      BEGIN INSERT OR IGNORE INTO etapas(evento_id,etapa,estado,atualizado_em,proxima_tentativa_em)
      VALUES(NEW.id,'${etapa}','pendente',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+12 seconds')); END;`);
  }
  config(){try{return JSON.parse(this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(CHAVE)?.valor||'null')||{enabled:false,limiteMensalMicrousd:0};}catch{return {enabled:false,limiteMensalMicrousd:0};}}
  #guardar(key,value){this.db.prepare('INSERT INTO desktop_config VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run(key,JSON.stringify(value));}
  #mes(){return this.agora().toISOString().slice(0,7);}
  #reservado(mes=this.#mes()){return Number(this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(CHAVE+':reserva:'+mes)?.valor||0);}
  async estado(){
    const c=this.config(),cofre=await this.segredos?.estado?.()||{};
    return {...c,modelo:JEV_MODELO,configurada:cofre.configurada===true,reservadoMicrousd:this.#reservado(),running:Boolean(this.running),
      motivo:!cofre.configurada?'Conecte uma chave própria do Jev no Lume.':!c.enabled?'Classificação contínua desligada.':c.limiteMensalMicrousd<=this.#reservado()?'Limite mensal atingido.':'Classificação em paralelo nas conversas autorizadas.',
      aviso:'Envia até 20 mensagens por análise à OpenRouter/TypeSafe. Classifica assunto, andamento e interesse; não confirma vendas nem envia respostas.'};
  }
  configurar({enabled,confirmar,limiteMensalMicrousd}={}){
    if(typeof enabled!=='boolean'||confirmar!==true||!Number.isSafeInteger(limiteMensalMicrousd)||limiteMensalMicrousd<0||limiteMensalMicrousd>1000000||enabled&&limiteMensalMicrousd===0)throw Error('Confirme o destino e um limite mensal explícito, em milionésimos de dólar.');
    this.controller.abort();this.controller=new AbortController();
    const c={enabled,limiteMensalMicrousd,id:randomUUID(),ativadaEm:this.agora().toISOString(),aposId:this.db.prepare('SELECT COALESCE(MAX(id),0) n FROM eventos').get().n};
    this.#guardar(CHAVE,c);return this.estado();
  }
  invalidar({desativar=false}={}){
    this.controller.abort();this.controller=new AbortController();
    if(desativar)this.#guardar(CHAVE,{...this.config(),enabled:false,id:randomUUID()});
  }
  #permitida(id){return this.pessoal.ativa()&&this.pessoal.politica.regra(id).remoto&&!this.pessoal.politica.regra(id).atendimento.excluida&&this.db.prepare('SELECT permitida FROM desktop_ia_conversas WHERE conversa_id=?').get(id)?.permitida===1;}
  async #processar(signal){
    signal=AbortSignal.any([signal,this.pessoal.controller.signal]);
    const c=this.config();if(!c.enabled||!this.pessoal.ativa()||signal.aborted)return;
    if(!(await this.segredos?.estado?.())?.configurada)return;
    const e=this.db.prepare(`SELECT e.* FROM etapas q JOIN desktop_fontes e ON e.id=q.evento_id WHERE q.etapa=? AND q.estado='pendente' AND q.proxima_tentativa_em<=? ORDER BY q.proxima_tentativa_em,e.id LIMIT 1`).get(etapa,this.agora().toISOString());
    if(!e)return;
    const terminar=(estado,motivo,resultado=null)=>this.db.prepare('UPDATE etapas SET estado=?,ultimo_erro=?,resultado=?,lease_token=NULL,lease_ate=NULL,atualizado_em=? WHERE evento_id=? AND etapa=?').run(estado,motivo,resultado?JSON.stringify(resultado):null,this.agora().toISOString(),e.id,etapa);
    if(e.id<=c.aposId||Date.parse(e.recebido_em)<Math.floor(Date.parse(c.ativadaEm)/1000)*1000||!this.#permitida(e.conversa_id))return terminar('desistida','CLASSIFICACAO_SEM_AUTORIZACAO');
    const newer=this.db.prepare(`SELECT 1 FROM eventos n JOIN etapas q ON q.evento_id=n.id AND q.etapa=?
      WHERE n.conversa_id=? AND n.id>? AND (n.recebido_em>? OR (n.recebido_em=? AND n.id>?)) LIMIT 1`)
      .get(etapa,e.conversa_id,c.aposId,e.recebido_em,e.recebido_em,e.id);
    if(newer)return terminar('desistida','CLASSIFICACAO_CONSOLIDADA');
    const candidatas=lerFontesVendas(this.db,e.conversa_id),fontes=candidatas.filter(f=>f.recebido_em<e.recebido_em||f.recebido_em===e.recebido_em&&f.id<=e.id).slice(-20);
    if(!fontes.some(f=>f.id===e.id)||!e.texto?.trim())return terminar('falha','CLASSIFICACAO_AGUARDA_TEXTO');
    const bytes=Buffer.byteLength(JSON.stringify(fontes));if(bytes>24000)return terminar('falha','CLASSIFICACAO_CONTEXTO_LONGO');
    // Conservative accounting, including errors/unknown dispatch. Never refund or retry implicitly.
    // 1.14 official input price $0.042/M; reserve $0.10/M per UTF-8 byte plus 4096 bytes of instructions.
    const reserva=Math.ceil((bytes+4096)*.1);
    if(this.#reservado()+reserva>c.limiteMensalMicrousd)return;
    const assinatura=hashFontesVendas(fontes),janela=hashFontesVendas(candidatas),revisao=revisaoVendas(this.db,e.conversa_id),policy=this.pessoal.politica.assinatura(e.conversa_id);
    const atual=()=>!signal.aborted&&this.config().enabled&&this.config().id===c.id&&this.#permitida(e.conversa_id)&&this.pessoal.politica.assinatura(e.conversa_id)===policy&&revisaoVendas(this.db,e.conversa_id)===revisao&&hashFontesVendas(lerFontesVendas(this.db,e.conversa_id))===janela;
    let key;try{key=await this.segredos.ler();}catch{return terminar('falha','CLASSIFICACAO_COFRE_INDISPONIVEL');}
    if(!atual())return terminar('desistida','CLASSIFICACAO_REVOGADA');
    const mes=this.#mes(); // Account at dispatch, after every asynchronous preparation.
    this.db.exec('SAVEPOINT pessoal_classificar');
    try{
      if(this.#reservado(mes)+reserva>c.limiteMensalMicrousd){this.db.exec('RELEASE pessoal_classificar');return;}
      const claimed=this.db.prepare("UPDATE etapas SET estado='em_curso',tentativas=tentativas+1,lease_token=?,fonte_assinatura=? WHERE evento_id=? AND etapa=? AND estado='pendente'").run(randomUUID(),assinatura,e.id,etapa);
      if(claimed.changes!==1){this.db.exec('RELEASE pessoal_classificar');return;}
      this.#guardar(CHAVE+':reserva:'+mes,this.#reservado(mes)+reserva);
      this.db.exec('RELEASE pessoal_classificar');
    }catch(error){this.db.exec('ROLLBACK TO pessoal_classificar;RELEASE pessoal_classificar');throw error;}
    const inicio=performance.now();
    try{
      const result=await this.avaliar({fontes:structuredClone(fontes),chave:key,confirmar:true,classificar:true,signal});
      if(!atual())return terminar('desistida','CLASSIFICACAO_REVOGADA');
      const id=randomUUID(),em=this.agora().toISOString();
      const avaliacao={...result,id,avaliado_em:em,fontes:fontes.map(f=>f.id),desatualizada:false,
        duracaoMs:Math.round(performance.now()-inicio),eventoId:e.id,origem:'jev',somenteSugestao:true,
        recorte:{escopo:'mensagens_selecionadas',total:candidatas.length,selecionadas:fontes.length,inicio_em:fontes[0].recebido_em,fim_em:fontes.at(-1).recebido_em,contexto_omitido_possivel:true,assinatura_janela:janela,revisao},
        consentimento:{confirmado_em:c.ativadaEm,provedor:'OpenRouter / TypeSafe',modelo:JEV_MODELO,assinatura_recorte:assinatura,configuracao:c.id},
        aviso:'Sugestão ligada a este recorte; temperatura não é probabilidade de venda. Conclusão informada não é entrega verificada.'};
      this.db.exec('SAVEPOINT pessoal_classificar_resultado');
      try{this.db.prepare('INSERT INTO lume_vendas_avaliacoes VALUES(?,?,?,?,?)').run(id,e.conversa_id,assinatura,JSON.stringify(avaliacao),em);terminar('concluida',null,{avaliacaoId:id,assunto:result.assunto,andamento:result.andamento,continuidade:result.continuidade,modelo:result.modelo,reservaMicrousd:reserva,mes,duracaoMs:avaliacao.duracaoMs});this.db.exec('RELEASE pessoal_classificar_resultado');}
      catch(error){this.db.exec('ROLLBACK TO pessoal_classificar_resultado;RELEASE pessoal_classificar_resultado');throw error;}
      const demandas=this.db.prepare("SELECT id FROM lume_acoes WHERE evento_id=? AND estado IN ('sugerido','confirmado','estacionado') LIMIT 32").all(e.id);
      for(const demanda of demandas)this.pessoal.organizarDemanda?.(demanda.id);
    }catch(error){terminar('falha',error.code||'CLASSIFICACAO_NAO_CONCLUIDA',{reservaMicrousd:reserva,mes,reenvioAutomatico:false});}
  }
  tick(){if(this.running)return this.running;this.running=this.#processar(this.controller.signal).catch(()=>{}).finally(()=>{this.running=null;});return this.running;}
  iniciar(){if(this.timer)return;this.timer=setInterval(()=>{void this.tick();},1000);this.timer.unref?.();}
  async encerrar(){clearInterval(this.timer);this.timer=null;this.controller.abort();await this.running;}
}
