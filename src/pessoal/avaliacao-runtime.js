import {randomUUID} from 'node:crypto';
import casos from './casos-avaliacao.js';
import {avaliarExecucao} from './avaliacao.js';
import {hash} from './politica.js';

const digestResultado=x=>hash({id:x.id,input:x.input,output:x.output,requestId:x.requestId,em:x.em,
  ...(x.reciboTipo===undefined?{}:{reciboTipo:x.reciboTipo})});

// Captures actual Responses results locally. Review is explicit and content-bound;
// neither a fabricated origin field nor a passing unit test can release runtime.
export class AvaliacaoPessoal {
  constructor(db,{chatgpt,instrucoes,agora=()=>new Date()}={}) {
    this.db=db;this.chatgpt=chatgpt;this.instrucoes=instrucoes;this.agora=agora;this.busy=false;
  }
  #get(){try{
    const r=JSON.parse(this.db.prepare("SELECT valor FROM desktop_config WHERE chave='pessoal-avaliacao'").get()?.valor||'null');
    if(!r||typeof r.id!=='string'||typeof r.modelo!=='string'||!Array.isArray(r.resultados)||r.resultados.length>100||
      r.resultados.some(x=>!casos.some(c=>c.id===x.id)||typeof x.output!=='string'||typeof x.requestId!=='string'||!x.requestId||x.reciboTipo!==undefined&&x.reciboTipo!=='response_id'||x.digest!==digestResultado(x))||
      new Set(r.resultados.map(x=>x.id)).size!==r.resultados.length||new Set(r.resultados.map(x=>x.requestId)).size!==r.resultados.length)return null;
    return r;
  }catch{return null;}}
  #save(value){this.db.prepare("INSERT INTO desktop_config VALUES('pessoal-avaliacao',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor").run(JSON.stringify(value));}
  #config(){return this.db.prepare("SELECT valor FROM desktop_config WHERE chave='pessoal-chatgpt-model'").get()?.valor;}
  #contrato(){return hash([this.instrucoes,casos]);}
  estado({relatorio=false}={}) {
    const run=this.#get(),revisoes=run?.resultados?.filter(r=>r.revisao).map(r=>({...r.revisao,id:r.id,origem:'modelo_real',evidencia:r.digest+' '+r.revisao.evidencia}))||[];
    const aval=avaliarExecucao({casos,resultados:revisoes});
    const atual=Boolean(run&&run.modelo===this.#config()&&run.contrato===this.#contrato());
    return {id:run?.id||null,modelo:run?.modelo||null,executados:run?.resultados.length||0,revisados:revisoes.length,
      busy:this.busy||Boolean(run?.lease&&Date.parse(run.lease.ate)>this.agora().getTime()),atual,avaliacao:aval,aceita:run?.aceita===true,
      liberada:atual&&run.aceita===true&&aval.aprovadoAutonomia,
      ...(relatorio?{casos,execucao:run}:{})};
  }
  async iniciar({confirmar=false}={}) {
    if(!confirmar||this.estado().busy)throw Error('Confirme o uso do plano para executar os 100 casos.');
    const state=await this.chatgpt.estado();
    if(this.estado().busy)throw Error('Avaliação já em curso.');
    if(!state.connected||!state.planEnabled||!state.model||state.paused)throw Error('Conecte e selecione o modelo primeiro.');
    this.#save({id:randomUUID(),modelo:state.model,contrato:this.#contrato(),criadaEm:this.agora().toISOString(),resultados:[],aceita:false});
    return this.estado();
  }
  async proximo({signal}={}) {
    if(this.estado().busy)throw Error('Avaliação já em curso.');
    const run=this.#get();if(!run||!this.estado().atual)throw Error('Inicie a avaliação do modelo atual.');
    const c=casos.find(c=>!run.resultados.some(r=>r.id===c.id));if(!c)return this.estado();
    const previous=JSON.stringify(run),token=randomUUID();
    run.lease={token,ate:new Date(this.agora().getTime()+180000).toISOString()};
    if(this.db.prepare("UPDATE desktop_config SET valor=? WHERE chave='pessoal-avaliacao' AND valor=?").run(JSON.stringify(run),previous).changes!==1)throw Error('Avaliação já em curso.');
    this.busy=true;
    try {
      const fontes=c.contexto.fontes.map((f,i)=>({id:i+2,texto:f.texto,origemAvaliacao:f.id}));
      const categoria=({equipe:'team',fornecedor:'supplier',amigo:'friend',familia:'family',desconhecido:'unknown'})[c.contexto.categoria]||c.contexto.categoria;
      const input={mensagemAtual:{id:1,texto:c.entrada},categoria,
        contexto:{fontes:[{id:1,texto:c.entrada},...fontes],condicoes:c.cenario,acoes:[],lacunas:[]},externas:[],exemplos:[],correcoes:[]};
      const output=await this.chatgpt.responder({instructions:this.instrucoes,input:[{role:'user',content:JSON.stringify(input)}],signal,
        validar:()=>{const current=this.#get();return current?.id===run.id&&current?.lease?.token===token&&Date.parse(run.lease.ate)>this.agora().getTime()&&this.estado().atual;}});
      const recibo=output.requestId||output.responseId;
      if(!output.completed||output.model!==run.modelo||typeof recibo!=='string'||!recibo||typeof output.text!=='string'||!output.text.trim()||run.resultados.some(r=>r.requestId===recibo)||this.#get()?.lease?.token!==token||Date.parse(run.lease.ate)<=this.agora().getTime()||!this.estado().atual)throw Error('Execução sem comprovante único do provedor ou contrato alterado.');
      const result={id:c.id,input,output:output.text,requestId:recibo,em:this.agora().toISOString()};
      if(!output.requestId)result.reciboTipo='response_id';
      result.digest=digestResultado(result);run.resultados.push(result);run.aceita=false;this.#save(run);
    }finally{
      const current=this.#get();if(current?.lease?.token===token){delete current.lease;this.#save(current);}this.busy=false;
    }
    return this.estado();
  }
  revisar({id,digest,interpretacao,fontes,resposta,criticoAtendido,revisadoPor,evidencia}={}) {
    if(this.estado().busy)throw Error('Aguarde a execução em andamento.');
    const run=this.#get(),r=run?.resultados.find(r=>r.id===id);
    if(!r||r.digest!==digest||![interpretacao,fontes,resposta,criticoAtendido].every(v=>typeof v==='boolean')||
      typeof revisadoPor!=='string'||revisadoPor.trim().length<3||revisadoPor.length>200||typeof evidencia!=='string'||evidencia.trim().length<20||evidencia.length>3000)throw Error('Revisão incompleta ou resultado alterado.');
    r.revisao={interpretacao,fontes,resposta,criticoAtendido,revisadoPor,evidencia};run.aceita=false;this.#save(run);return this.estado();
  }
  aceitar({confirmar=false}={}) {
    const state=this.estado();if(!confirmar||state.busy||!state.atual||!state.avaliacao.aprovadoAutonomia)throw Error('Avaliação real e revisão ainda pendentes.');
    const run=this.#get();run.aceita=true;run.aceitaEm=this.agora().toISOString();this.#save(run);return this.estado();
  }
}
