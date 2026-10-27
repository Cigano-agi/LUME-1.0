import {randomUUID} from 'node:crypto';
import {LEITURA_SQL,IA_SQL,recorte} from './recuperacao.js';
import {diaLocal} from './relogio.js';
import {prepararTarefas,assinaturaFonte,HASH_FONTE_SQL,SUGESTAO_ATUAL_SQL} from './tarefas-esquema.js';
import {pedidoTarefas,conferirTarefas} from './tarefas-contrato.js';
import {MODELO_DESKTOP} from './gemini-desktop.js';
import {avisosFonte} from './fontes-desktop.js';

const MAX_NOVAS=32,MAX_CONTEXTO=16,INTERVALO_MS=300000;
export class DesktopTarefas {
  constructor(db,{ia,perfil=()=>({aceito:false}),agora=()=>new Date()}={}){
    this.db=db;this.ia=ia;this.perfil=perfil;this.agora=agora;this.previas=new Map();this.ocupado=false;this.revisao=0;prepararTarefas(db);
    if(db.prepare("SELECT 1 FROM desktop_tarefas_lotes WHERE estado='iniciado' LIMIT 1").get()){
      db.prepare("UPDATE desktop_tarefas_lotes SET estado='incerto',terminado_em=? WHERE estado='iniciado'").run(agora().toISOString());
      this.pausar('Uma análise foi interrompida no fechamento anterior. Confira as fontes e o orçamento antes de reativar.');
    }
  }
  config(){return this.db.prepare('SELECT * FROM desktop_tarefas_config WHERE id=1').get();}
  pausar(motivo=null){this.ia.invalidar();this.revisao++;this.previas.clear();this.db.prepare('UPDATE desktop_tarefas_config SET ativa=0,erro=? WHERE id=1').run(motivo);}
  configurar({ativa,maxLotesDia=2,conversas=[],cienteEnvioAutomatico=false}={}){
    if(typeof ativa!=='boolean'||!Number.isInteger(maxLotesDia)||maxLotesDia<1||maxLotesDia>10||!Array.isArray(conversas)||conversas.length>100||conversas.some(c=>typeof c!=='string'||c.length>200))throw new Error('Escolha até 100 conversas e de 1 a 10 lotes por dia.');
    if(ativa&&(cienteEnvioAutomatico!==true||!conversas.length||!this.perfil().aceito||!this.ia.config().habilitada))throw new Error('Ative a IA, escolha conversas e confirme o envio automático antes de ligar.');
    for(const conversa of conversas)if(!this.db.prepare('SELECT 1 FROM conversas_app c JOIN desktop_ia_conversas a ON a.conversa_id=c.id WHERE c.id=? AND a.permitida=1').get(conversa))throw new Error('Todas as conversas precisam estar autorizadas para IA.');
    this.ia.invalidar();this.revisao++;this.previas.clear();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const antigas=new Map(this.db.prepare('SELECT * FROM desktop_tarefas_conversas').all().map(c=>[c.conversa_id,c])),agora=this.agora().toISOString();
      this.db.exec('DELETE FROM desktop_tarefas_conversas');
      for(const conversa of new Set(conversas)){
        const depois=antigas.get(conversa)?.depois_id??this.db.prepare('SELECT COALESCE(MAX(id),0) n FROM eventos WHERE conversa_id=?').get(conversa).n;
        this.db.prepare('INSERT INTO desktop_tarefas_conversas VALUES(?,?,?)').run(conversa,agora,depois);
      }
      this.db.prepare('UPDATE desktop_tarefas_config SET ativa=?,max_lotes_dia=?,erro=NULL WHERE id=1').run(ativa?1:0,maxLotesDia);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.estado();
  }
  usadosHoje(){return this.db.prepare("SELECT COUNT(*) n FROM desktop_tarefas_lotes WHERE dia=? AND modo='automatico'").get(diaLocal(this.agora())).n;}
  estado(){
    const c=this.config(),conversas=this.db.prepare('SELECT c.id,c.nome,COALESCE(a.permitida,0) ia,CASE WHEN t.conversa_id IS NOT NULL THEN 1 ELSE 0 END automatica FROM conversas_app c LEFT JOIN desktop_ia_conversas a ON a.conversa_id=c.id LEFT JOIN desktop_tarefas_conversas t ON t.conversa_id=c.id ORDER BY c.nome LIMIT 1000').all();
    return {ativa:Boolean(c.ativa),iaHabilitada:Boolean(this.ia.config().habilitada),maxLotesDia:c.max_lotes_dia,lotesHoje:this.usadosHoje(),ultimaTentativa:c.ultima_tentativa_em,erro:c.erro,ocupado:this.ocupado,conversas,intervaloMinutos:5,maxNovas:MAX_NOVAS,maxContexto:MAX_CONTEXTO,aviso:'Sugestões exigem revisão. O orçamento é o mesmo das perguntas. Automação considera mensagens novas após autorizar cada conversa, no recorte dos últimos 30 dias. Lotes tentados contam mesmo se falharem.'};
  }
  selecionar({conversa,periodo='semana'},{automatico=false}={}){
    if(typeof conversa!=='string'||!conversa||conversa.length>200)throw new Error('Escolha uma conversa para analisar.');
    const filtro=recorte({pergunta:'Ações para revisar',conversa,periodo},this.agora()),where=['e.conversa_id=?',LEITURA_SQL,IA_SQL,"e.texto IS NOT NULL AND trim(e.texto)<>''",'e.dia_local<=?'],args=[conversa,filtro.ate];
    if(filtro.desde){where.push('e.dia_local>=?');args.push(filtro.desde);}
    const autorizacao=this.db.prepare('SELECT * FROM desktop_tarefas_conversas WHERE conversa_id=?').get(conversa);
    if(automatico){if(!this.config().ativa||!autorizacao)throw new Error('Automação não autorizada para esta conversa.');}
    const sql=where.join(' AND '),pendente=`NOT EXISTS(SELECT 1 FROM desktop_tarefas_analises a WHERE a.evento_id=e.id AND a.assinatura=${HASH_FONTE_SQL})`;
    const desdeAuto=automatico?' AND e.id>?':'',paramAuto=automatico?[autorizacao.depois_id]:[];
    const novas=this.db.prepare(`SELECT e.*,COALESCE(c.nome,e.conversa_id) conversa_nome FROM desktop_fontes e LEFT JOIN conversas_app c ON c.id=e.conversa_id WHERE ${sql} AND ${pendente}${desdeAuto} ORDER BY e.id DESC LIMIT ?`).all(...args,...paramAuto,MAX_NOVAS+1);
    const mais=novas.length>MAX_NOVAS;novas.length=Math.min(novas.length,MAX_NOVAS);
    if(!novas.length)return{filtro,novas:[],eventos:[],mais:false};
    const ids=new Set(novas.map(e=>e.id));
    const contexto=this.db.prepare(`SELECT e.*,COALESCE(c.nome,e.conversa_id) conversa_nome FROM desktop_fontes e LEFT JOIN conversas_app c ON c.id=e.conversa_id WHERE ${sql} ORDER BY e.id DESC LIMIT ?`).all(...args,MAX_CONTEXTO);
    const eventos=[...novas,...contexto.filter(e=>!ids.has(e.id))].sort((a,b)=>a.id-b.id);
    return{filtro,novas,eventos,mais};
  }
  preparar(data,{automatico=false}={}){
    if(!this.ia.config().habilitada)throw new Error('Ative a IA e autorize a conversa em Configurações.');
    const lote=this.selecionar(data,{automatico});
    if(!lote.novas.length)return{vazio:true,total:0,aviso:'Nenhuma fonte nova permitida neste recorte. Confira período, leitura e autorização de IA.'};
    const ids=new Set(lote.novas.map(e=>e.id)),fontes=lote.eventos.map(e=>({fonte:'E'+e.id,id:e.id,conversa_id:e.conversa_id,conversa_nome:e.conversa_nome,origem_id:e.origem_id,autor_id:e.autor_id,autor_e_dono:Boolean(e.autor_e_dono),permissao:e.permissao,recebido_em:e.recebido_em,avisos:avisosFonte(e),texto:e.texto.slice(0,1800),truncada:e.texto.length>1800,analisar:ids.has(e.id)}));
    const p=this.ia.registrarOperacao({eventos:lote.eventos,fontes,pedido:pedidoTarefas(fontes),tipo:'tarefas'});
    for(const [id,v]of this.previas)if(v.expira<this.agora().getTime())this.previas.delete(id);if(this.previas.size>=20)this.previas.delete(this.previas.keys().next().value);
    this.previas.set(p.id,{lote,automatico,revisao:this.revisao,expira:Date.parse(p.expiraEm)});
    return{...p,total:lote.novas.length,contexto:fontes.length-lote.novas.length,mais:lote.mais,vazio:false,aviso:'Confira as fontes. O recorte pode omitir respostas ou conclusões. Textos acima de 1.800 caracteres estão marcados como parciais. Apenas estes trechos serão enviados ao Google; o resultado será uma sugestão para você revisar.'};
  }
  validarLote(p){
    if(p.revisao!==this.revisao||p.expira<this.agora().getTime())throw new Error('Prévia de tarefas expirada ou revogada.');
    if(p.lote.novas.some(e=>this.db.prepare('SELECT 1 FROM desktop_tarefas_analises WHERE evento_id=? AND assinatura=?').get(e.id,assinaturaFonte(e))))throw new Error('O lote já foi analisado. Confira uma nova prévia.');
    if(p.automatico){
      if(!this.perfil().aceito||!this.config().ativa||!this.db.prepare('SELECT 1 FROM desktop_tarefas_conversas WHERE conversa_id=?').get(p.lote.filtro.conversa))throw new Error('Envio automático revogado.');
      if(this.usadosHoje()>=this.config().max_lotes_dia)throw new Error('Limite diário de lotes automáticos atingido.');
    }
  }
  async gerar(data,{automatico=false}={}){
    if(data?.confirmar!==true)throw new Error('Confirme o envio das fontes.');
    if(this.ocupado)throw new Error('Uma análise de tarefas já está em andamento.');
    const p=this.previas.get(data.id);if(!p||p.automatico!==automatico)throw new Error('Prévia de tarefas ausente ou de outra operação.');
    this.validarLote(p);this.previas.delete(data.id);this.ocupado=true;const rev=this.revisao;
    try{
      return await this.ia.executarOperacao(data,{tipo:'tarefas',conferirResultado:conferirTarefas,antesDeEnviar:()=>{
        this.validarLote(p);const now=this.agora().toISOString();
        this.db.prepare("INSERT INTO desktop_tarefas_lotes VALUES(?,?,?,'iniciado',?,NULL)").run(data.id,diaLocal(this.agora()),automatico?'automatico':'manual',now);
        if(automatico)this.db.prepare('UPDATE desktop_tarefas_config SET ultima_tentativa_em=?,ultima_conversa_id=? WHERE id=1').run(now,p.lote.filtro.conversa);
      },finalizar:(itens,previa)=>{
        // A chamada remota não transforma a sugestão em tarefa aceita.
        if(p.revisao!==this.revisao)throw new Error('Análise revogada.');
        const now=this.agora().toISOString();let novos=0;this.db.exec('BEGIN IMMEDIATE');
        try{
          this.ia.conferir(previa);
          for(const i of itens){
            const anterior=this.db.prepare('SELECT * FROM desktop_tarefas_sugestoes WHERE evento_id=? AND tipo=?').get(i.eventoid,i.tipo);
            if(anterior&&anterior.estado!=='pendente')continue;
            const id=anterior?.id||randomUUID();
            this.db.prepare(`INSERT INTO desktop_tarefas_sugestoes(id,evento_id,tipo,resumo,trecho,prazo_citado,fontes_total,criada_em) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(evento_id,tipo) DO UPDATE SET resumo=excluded.resumo,trecho=excluded.trecho,prazo_citado=excluded.prazo_citado,fontes_total=excluded.fontes_total,criada_em=excluded.criada_em`).run(id,i.eventoid,i.tipo,i.resumo,i.trecho,i.prazo_citado,p.lote.eventos.length,now);
            this.db.prepare('DELETE FROM desktop_tarefas_fontes WHERE sugestao_id=?').run(id);
            for(const e of p.lote.eventos)this.db.prepare('INSERT INTO desktop_tarefas_fontes VALUES(?,?,?)').run(id,e.id,assinaturaFonte(e));
            if(!anterior)novos++;
          }
          for(const e of p.lote.novas)this.db.prepare('INSERT INTO desktop_tarefas_analises VALUES(?,?,?) ON CONFLICT(evento_id) DO UPDATE SET assinatura=excluded.assinatura,analisado_em=excluded.analisado_em').run(e.id,assinaturaFonte(e),now);
          this.db.prepare("UPDATE desktop_tarefas_lotes SET estado='concluido',terminado_em=? WHERE id=?").run(now,data.id);this.db.exec('COMMIT');
        }catch(e){this.db.exec('ROLLBACK');throw e;}
        return{novos,total:itens.length,analisadas:p.lote.novas.length,mais:p.lote.mais,reservaUSD:previa.reserva/1e6,aviso:'Sugestões salvas para revisão; nenhuma ação foi assumida, concluída ou enviada.'};
      }});
    }catch(e){this.db.prepare("UPDATE desktop_tarefas_lotes SET estado='incerto',terminado_em=? WHERE id=?").run(this.agora().toISOString(),data.id);if(automatico&&rev===this.revisao)this.pausar('A análise automática não terminou. Confira conexão, autorização e orçamento antes de reativar.');throw e;}
    finally{this.ocupado=false;}
  }
  listar({estado='pendente',antes=Number.MAX_SAFE_INTEGER,limite=30}={}){
    if(!['pendente','aceita','descartada'].includes(estado)||!Number.isSafeInteger(antes)||antes<1||!Number.isInteger(limite)||limite<1||limite>100)throw new Error('Filtro de sugestões inválido.');
    const rows=this.db.prepare(`SELECT s.*,s.rowid cursor,e.conversa_id,e.origem_id,e.recebido_em,COALESCE(c.nome,e.conversa_id) conversa_nome FROM desktop_tarefas_sugestoes s JOIN eventos e ON e.id=s.evento_id LEFT JOIN conversas_app c ON c.id=e.conversa_id WHERE s.estado=? AND s.rowid<? AND ${LEITURA_SQL} AND ${SUGESTAO_ATUAL_SQL} ORDER BY s.rowid DESC LIMIT ?`).all(estado,antes,limite+1);
    const mais=rows.length>limite;return{sugestoes:rows.slice(0,limite),mais,proximoAntes:mais?rows[limite-1].cursor:null};
  }
  decidir({id,acao}={}){
    if(typeof id!=='string'||!['aceitar','descartar'].includes(acao))throw new Error('Escolha aceitar ou descartar a sugestão.');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const s=this.db.prepare(`SELECT s.*,e.conversa_id,e.origem_id,e.permissao FROM desktop_tarefas_sugestoes s JOIN eventos e ON e.id=s.evento_id WHERE s.id=? AND ${LEITURA_SQL} AND ${SUGESTAO_ATUAL_SQL}`).get(id);
      if(!s)throw new Error('A fonte mudou, foi apagada ou perdeu permissão. Gere uma análise atual antes de decidir.');
      if(s.estado!=='pendente')throw new Error('Esta sugestão já foi revisada.');
      const now=this.agora().toISOString();let item=null;
      if(acao==='aceitar'){
        this.db.prepare(`INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,quando,extraido_em,modelo,permissao_origem,regra) VALUES(?,?,?,?,NULL,?,?,?,?) ON CONFLICT(conversa_id,origem_id,tipo) DO NOTHING`).run(s.conversa_id,s.origem_id,s.tipo,s.resumo,now,MODELO_DESKTOP,s.permissao||'desconhecida','Sugestão conferida e aceita pelo usuário no aplicativo');
        item=this.db.prepare('SELECT id,estado FROM itens_crm WHERE conversa_id=? AND origem_id=? AND tipo=?').get(s.conversa_id,s.origem_id,s.tipo);
      }
      this.db.prepare('UPDATE desktop_tarefas_sugestoes SET estado=?,revisada_em=?,item_id=? WHERE id=?').run(acao==='aceitar'?'aceita':'descartada',now,item?.id||null,id);this.db.exec('COMMIT');
      return{ok:true,itemId:item?.id||null,estadoItem:item?.estado||null,aviso:item&&item.estado!=='aberto'?'A decisão anterior deste item foi preservada.':'Revisão registrada.'};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  async executarAutomatico(){
    const cfg=this.config();if(this.ocupado||!cfg.ativa||!this.perfil().aceito||!this.ia.config().habilitada||this.usadosHoje()>=cfg.max_lotes_dia)return{executado:false};
    if(cfg.ultima_tentativa_em&&this.agora().getTime()-Date.parse(cfg.ultima_tentativa_em)<INTERVALO_MS)return{executado:false};
    // Rodízio persistente: uma conversa movimentada não consome todos os lotes.
    for(const c of this.db.prepare('SELECT conversa_id FROM desktop_tarefas_conversas ORDER BY CASE WHEN conversa_id>? THEN 0 ELSE 1 END,conversa_id').all(cfg.ultima_conversa_id||'')){
      const revisao=this.revisao;
      try{const p=this.preparar({conversa:c.conversa_id,periodo:'30dias'},{automatico:true});if(p.vazio)continue;return{executado:true,...await this.gerar({id:p.id,confirmar:true},{automatico:true})};}
      catch{if(this.config().ativa&&this.revisao===revisao)this.pausar('A automação foi pausada. Confira autorização, conexão e orçamento antes de reativar.');return{executado:false,pausada:!this.config().ativa};}
    }
    return{executado:false};
  }
}
