import {performance} from 'node:perf_hooks';

export const ATIVIDADE_CONFIG='atividade_apps_v1';
export const ATIVIDADE_COLUNAS=['dia','app_id','duracao_ms','amostras','atualizado_em'];
const DAY_MS=86400000;
const padrao=()=>({versao:1,consentimento:0,habilitado:false,pausado:false,retencaoDias:7,excluidos:[]});
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const keys=(v,allowed)=>object(v)&&Object.keys(v).every(k=>allowed.includes(k));
export const appIdValido=id=>typeof id==='string'&&id.length<=128&&/^[\p{L}\p{N}][\p{L}\p{N} ._()+-]*\.exe$/u.test(id)&&!id.includes('..')&&id===id.toLowerCase();
const diaLocal=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
function valido(config){
  return keys(config,['versao','consentimento','habilitado','pausado','retencaoDias','excluidos'])&&Object.keys(config).length===6&&config.versao===1&&[0,1].includes(config.consentimento)&&typeof config.habilitado==='boolean'&&typeof config.pausado==='boolean'&&(!config.habilitado||config.consentimento===1)&&Number.isInteger(config.retencaoDias)&&config.retencaoDias>=1&&config.retencaoDias<=30&&Array.isArray(config.excluidos)&&config.excluidos.length<=100&&config.excluidos.every(appIdValido)&&new Set(config.excluidos).size===config.excluidos.length;
}
export class AtividadeApps {
  constructor(db,{coletar=null,disponivel=false,agora=()=>new Date(),monotonico=()=>performance.now(),sistemaPausado=false}={}){
    this.db=db;this.coletar=coletar;this.disponivel=Boolean(disponivel&&coletar);this.agora=agora;this.monotonico=monotonico;
    this.sistemaPausado=sistemaPausado;this.geracao=0;this.anterior=null;this.pendente=null;this.controller=null;this.timer=null;this.encerrado=false;this.falhaPersistencia=false;this.situacao='aguardando';this.ultimaAmostraEm=null;
    db.exec(`CREATE TABLE IF NOT EXISTS desktop_config(chave TEXT PRIMARY KEY,valor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS atividade_apps_dias(dia TEXT NOT NULL,app_id TEXT NOT NULL,duracao_ms INTEGER NOT NULL CHECK(duracao_ms>=0 AND duracao_ms<=86400000),amostras INTEGER NOT NULL CHECK(amostras>=0),atualizado_em TEXT NOT NULL,PRIMARY KEY(dia,app_id));`);
    this.config=this.lerConfig();this.limparRetencao();
  }
  lerConfig(){try{const raw=this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(ATIVIDADE_CONFIG)?.valor;if(!raw)return padrao();const c=JSON.parse(raw);return valido(c)?c:padrao();}catch{return padrao();}}
  gravarConfig(config){this.db.prepare('INSERT INTO desktop_config(chave,valor) VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run(ATIVIDADE_CONFIG,JSON.stringify(config));}
  limparRetencao(){const date=this.agora();if(!(date instanceof Date)||!Number.isFinite(date.getTime()))throw Error('Relógio local indisponível.');const min=new Date(date);min.setDate(min.getDate()-this.config.retencaoDias+1);this.db.prepare('DELETE FROM atividade_apps_dias WHERE dia<? OR dia>?').run(diaLocal(min),diaLocal(date));}
  permitido(){return !this.encerrado&&!this.falhaPersistencia&&this.disponivel&&this.config.habilitado&&!this.config.pausado&&!this.sistemaPausado;}
  invalidar(){this.geracao++;this.anterior=null;this.controller?.abort();}
  sistema(pausado){this.sistemaPausado=Boolean(pausado);this.invalidar();}
  async configurar(patch){
    if(!keys(patch,['habilitado','pausado','retencaoDias','excluidos','consentimento'])||!Object.keys(patch).length)throw Error('Configuração de acompanhamento inválida.');
    const next={...this.config,...patch};
    if(!valido(next))throw Error('Escolha retenção de 1 a 30 dias, aplicativos válidos e confirme o acompanhamento local.');
    if(patch.habilitado===true&&(!this.config.habilitado||this.config.consentimento!==1)&&patch.consentimento!==1)throw Error('Confirme o acompanhamento local de aplicativos.');
    if(this.encerrado)throw Error('O acompanhamento está encerrando.');
    this.invalidar();const pending=this.pendente;
    try{
      this.db.exec('BEGIN IMMEDIATE');
      this.gravarConfig(next);
      for(const app of next.excluidos)this.db.prepare('DELETE FROM atividade_apps_dias WHERE app_id=?').run(app);
      this.db.exec('COMMIT');this.config=next;this.falhaPersistencia=false;this.situacao='aguardando';this.limparRetencao();
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}this.falhaPersistencia=true;throw error;}
    await pending;return this.estado();
  }
  async apagar(){
    this.invalidar();const pending=this.pendente;
    const next={...this.config,habilitado:false,pausado:false,consentimento:0};
    try{this.db.exec('BEGIN IMMEDIATE');this.gravarConfig(next);this.db.exec('DELETE FROM atividade_apps_dias;COMMIT');this.config=next;this.falhaPersistencia=false;this.ultimaAmostraEm=null;this.situacao='aguardando';}
    catch(error){try{this.db.exec('ROLLBACK');}catch{}this.falhaPersistencia=true;throw error;}
    await pending;return this.estado();
  }
  async pausarDados(){this.invalidar();const pending=this.pendente;this.config={...this.config,habilitado:false,consentimento:0,pausado:false};try{this.gravarConfig(this.config);}catch{this.falhaPersistencia=true;}await pending;}
  passo(){
    if(this.pendente)return this.pendente;
    if(!this.permitido())return Promise.resolve(false);
    const generation=this.geracao,controller=new AbortController();this.controller=controller;
    const started=this.monotonico();
    const pending=Promise.resolve().then(()=>this.permitido()&&generation===this.geracao?this.coletar({signal:controller.signal}):null).then(sample=>{
      if(!this.permitido()||generation!==this.geracao||controller.signal.aborted)return false;
      const now=this.agora(),mono=this.monotonico(),clock=now.getTime();
      if(!sample||!Number.isFinite(clock)||!Number.isFinite(mono)||mono<started||mono-started>2500){this.anterior=null;this.situacao='indisponivel';return false;}
      if(keys(sample,['estado'])&&Object.keys(sample).length===1&&['indisponivel','bloqueado','inativo'].includes(sample.estado)){this.anterior=null;this.situacao=sample.estado;return false;}
      if(!keys(sample,['estado','appId','idleMs'])||Object.keys(sample).length!==3||sample.estado!=='amostra'||!appIdValido(sample.appId)||!Number.isInteger(sample.idleMs)||sample.idleMs<0||sample.idleMs>=60000){this.anterior=null;this.situacao='indisponivel';return false;}
      if(this.config.excluidos.includes(sample.appId)){this.anterior=null;this.situacao='excluido';return false;}
      const day=diaLocal(now),previous=this.anterior;this.situacao='coletando';this.ultimaAmostraEm=now.toISOString();
      this.anterior={appId:sample.appId,day,clock,mono};
      if(!previous||previous.appId!==sample.appId||previous.day!==day)return false;
      const delta=mono-previous.mono,civil=clock-previous.clock;
      if(delta<=0||delta>7500||Math.abs(civil-delta)>1000)return false;
      this.limparRetencao();
      if(!this.db.prepare('SELECT 1 FROM atividade_apps_dias WHERE dia=? AND app_id=?').get(day,sample.appId)&&this.db.prepare('SELECT COUNT(*) n FROM atividade_apps_dias WHERE dia=?').get(day).n>=200){this.anterior=null;this.situacao='limite';return false;}
      this.db.prepare(`INSERT INTO atividade_apps_dias(dia,app_id,duracao_ms,amostras,atualizado_em) VALUES(?,?,?,1,?) ON CONFLICT(dia,app_id) DO UPDATE SET duracao_ms=MIN(86400000,duracao_ms+excluded.duracao_ms),amostras=amostras+1,atualizado_em=excluded.atualizado_em`).run(day,sample.appId,Math.floor(delta),now.toISOString());
      return true;
    }).catch(()=>{if(generation===this.geracao){this.anterior=null;this.situacao='indisponivel';}return false;}).finally(()=>{if(this.pendente===pending){this.pendente=null;this.controller=null;}});
    this.pendente=pending;return pending;
  }
  iniciar(){if(this.timer||this.encerrado)return;this.timer=setInterval(()=>{void this.passo();},5000);this.timer.unref?.();void this.passo();}
  async encerrar(){this.encerrado=true;clearInterval(this.timer);this.timer=null;this.invalidar();await this.pendente;}
  estado({dias=7,pagina=1,limite=50}={}){
    if(!Number.isInteger(dias)||dias<1||dias>30||!Number.isInteger(pagina)||pagina<1||pagina>200||!Number.isInteger(limite)||limite<1||limite>100)throw Error('Período de acompanhamento inválido.');
    this.limparRetencao();
    const now=this.agora(),min=new Date(now);min.setDate(min.getDate()-Math.min(dias,this.config.retencaoDias)+1);const from=diaLocal(min);
    const base=`FROM atividade_apps_dias WHERE dia>=?`;
    const apps=this.db.prepare(`SELECT app_id appId,SUM(duracao_ms) duracaoMs,SUM(amostras) amostras,MAX(atualizado_em) atualizadoEm ${base} GROUP BY app_id ORDER BY duracaoMs DESC,app_id LIMIT ? OFFSET ?`).all(from,limite+1,(pagina-1)*limite);
    const resumo=this.db.prepare(`SELECT COALESCE(SUM(duracao_ms),0) duracaoMs,COALESCE(SUM(amostras),0) amostras,COUNT(DISTINCT app_id) aplicativos ${base}`).get(from);
    const serie=this.db.prepare(`SELECT dia,SUM(duracao_ms) duracaoMs ${base} GROUP BY dia ORDER BY dia`).all(from);
    const fresh=this.anterior&&now.getTime()-this.anterior.clock>=0&&now.getTime()-this.anterior.clock<=7500;
    const estado=this.encerrado?'encerrado':!this.config.habilitado?'desligado':this.falhaPersistencia?'indisponivel':this.config.pausado?'pausado':!this.disponivel?'indisponivel':this.sistemaPausado?'suspenso':!fresh&&this.situacao==='coletando'?'aguardando':this.situacao;
    return {versao:1,disponivel:this.disponivel,estado,config:{...this.config,excluidos:[...this.config.excluidos]},periodo:{inicio:from,fim:diaLocal(now),dias:Math.min(dias,this.config.retencaoDias)},resumo,serie,apps:apps.slice(0,limite).map(a=>({...a,nome:a.appId.replace(/\.exe$/u,'')})),pagina,proximaPagina:apps.length>limite?pagina+1:null,appAtual:estado==='coletando'&&fresh?{appId:this.anterior.appId,nome:this.anterior.appId.replace(/\.exe$/u,'')}:null,ultimaAmostraEm:this.ultimaAmostraEm,amostragemMs:5000,inatividadeMs:60000,local:true};
  }
}
