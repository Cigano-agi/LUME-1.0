const CHAVE='pessoal-companheiro';
export class CompanheiroPessoal {
  constructor(db,{publicar,conexao,pessoal,disponivel=true}={}){
    this.db=db;this.publicar=publicar;this.conexao=conexao;this.pessoal=pessoal;this.disponivel=disponivel;this.timer=null;this.ultimo=null;
  }
  estado(){
    let config;try{config=JSON.parse(this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(CHAVE)?.valor||'{}');}catch{}
    return {enabled:config?.enabled===true,som:config?.som===true,disponivel:this.disponivel,
      tema:['system','light','dark'].includes(config?.tema)?config.tema:'system',
      movimento:['system','reduce'].includes(config?.movimento)?config.movimento:'system',
      volume:Number.isFinite(config?.volume)?Math.max(0,Math.min(1,config.volume)):.35,
      pausado:config?.pausado===true,adiadoId:typeof config?.adiadoId==='string'?config.adiadoId:null,
      adiadoAte:typeof config?.adiadoAte==='string'&&Number.isFinite(Date.parse(config.adiadoAte))?config.adiadoAte:null};
  }
  configurar(data){
    const validators={enabled:v=>typeof v==='boolean',som:v=>typeof v==='boolean',pausado:v=>typeof v==='boolean',tema:v=>['system','light','dark'].includes(v),movimento:v=>['system','reduce'].includes(v),volume:v=>Number.isFinite(v)&&v>=0&&v<=1,adiadoId:v=>v===null||typeof v==='string'&&/^acao:[0-9a-f-]{36}$/i.test(v),adiadoAte:v=>v===null||typeof v==='string'&&Number.isFinite(Date.parse(v))};
    if(!data||typeof data!=='object'||Array.isArray(data)||!Object.keys(data).length||Object.keys(data).some(k=>!Object.hasOwn(validators,k)||!validators[k](data[k])||!this.disponivel&&!['tema','movimento','som','volume'].includes(k)))throw Error('Preferência inválida.');
    const {disponivel,...atual}=this.estado(),next={...atual,...data};
    this.db.prepare('INSERT INTO desktop_config(chave,valor) VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run(CHAVE,JSON.stringify(next));
    this.ultimo=null;this.sinalizar();return this.estado();
  }
  sinalizar(){
    const config=this.estado();let estado='aguardando',mensagem='Sua memória está por aqui.',notificacaoId=null,assunto=null;
    if(config.pausado){estado='pausado';mensagem='Companhia pausada. O atendimento mantém suas próprias regras.';}
    else if(this.pessoal.organizador?.running){estado='trabalhando';mensagem='Organizando conversas autorizadas.';}
    else if(!this.pessoal.ativa()){estado='aguardando';mensagem='Atendimento pessoal pausado. A memória continua disponível.';}
    else if(this.conexao.estado().estado!=='conectada'){estado='desconectado';mensagem='Aguardando a conexão do WhatsApp.';}
    else{
      const pendente=this.db.prepare("SELECT id FROM pessoal_propostas WHERE estado='pendente' ORDER BY criada_em DESC LIMIT 1").get();
      if(pendente&&this.pessoal.validarAviso({propostaId:pendente.id})){
        estado='atencao';mensagem='Uma resposta precisa da sua decisão no Telegram.';notificacaoId='proposta:'+pendente.id;
      }else if(this.pessoal.running){estado='trabalhando';mensagem='Conferindo as demandas.';}
    }
    if(config.enabled&&!config.pausado&&this.experiencia){
      try{assunto=this.experiencia.companheiro();}catch{}
      if(assunto&&assunto.id===config.adiadoId&&Date.parse(config.adiadoAte)>Date.now())assunto=null;
      if(assunto){
        mensagem=assunto.assunto;
        if(!['pausado','desconectado','trabalhando'].includes(estado))estado=assunto.grupo==='precisa'?'atencao':assunto.grupo==='mudou'?'concluido':'aguardando';
        notificacaoId=assunto.id+':'+assunto.estado+':'+assunto.atualizadoEm;
      }
    }
    const snapshot={enabled:config.enabled,som:config.som&&!config.pausado,estado,mensagem,notificacaoId,assunto,tema:config.tema,movimento:config.movimento,volume:config.volume,pausado:config.pausado};
    const serialized=JSON.stringify(snapshot);
    if(serialized!==this.ultimo){this.publicar(snapshot);this.ultimo=serialized;}
  }
  iniciar(){if(this.timer)return;this.sinalizar();this.timer=setInterval(()=>{try{this.sinalizar();}catch{}},15000);this.timer.unref?.();}
  encerrar(){clearInterval(this.timer);this.timer=null;}
}
