import {hash,jidValido} from './politica.js';
import {aguardar,lerJsonLimitado} from './leitura-limitada.js';

const repositorio=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const tarefa=/^[A-Za-z0-9_-]{1,80}$/;
const curto=(s,max=500)=>String(s??'').replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,max);

/** Fixed read-only endpoints. Neither the model nor a source may supply a URL. */
export class FerramentasPessoais {
  constructor(db,{fetchImpl=fetch,credencial=async()=>null,permitida=()=>false,agora=()=>new Date(),prazoMs=20000}={}) {
    this.db=db;this.fetch=fetchImpl;this.credencial=credencial;this.permitida=permitida;this.agora=agora;
    if(!Number.isSafeInteger(prazoMs)||prazoMs<1||prazoMs>20000)throw Error('Prazo inválido.');this.prazoMs=prazoMs;
  }
  vincular({conversaId,tipo,recurso,remover=false}) {
    if(!jidValido(conversaId)||!['github','clickup'].includes(tipo)||!(tipo==='github'?repositorio:tarefa).test(recurso))throw new Error('Vínculo inválido. Use owner/repo ou o ID da tarefa ClickUp.');
    if(remover)this.db.prepare('DELETE FROM pessoal_vinculos WHERE conversa_id=? AND tipo=? AND recurso=?').run(conversaId,tipo,recurso);
    else {
      const total=this.db.prepare('SELECT COUNT(*) n FROM pessoal_vinculos WHERE conversa_id=?').get(conversaId).n;
      if(total>=5)throw new Error('Limite de cinco vínculos por conversa.');
      this.db.prepare('INSERT OR IGNORE INTO pessoal_vinculos VALUES(?,?,?)').run(conversaId,tipo,recurso);
    }
    this.db.prepare('UPDATE pessoal_politicas SET versao=versao+1 WHERE conversa_id=?').run(conversaId);
    return this.listar(conversaId);
  }
  listar(conversaId) {return this.db.prepare('SELECT tipo,recurso FROM pessoal_vinculos WHERE conversa_id=? ORDER BY tipo,recurso LIMIT 5').all(conversaId);}
  async #get(tipo,path,signal,conversaId,vigente) {
    if(!this.permitida(conversaId)||!vigente())throw Error('revogado');
    signal?.throwIfAborted();
    const token=await aguardar(this.credencial(tipo),signal);
    if(!this.permitida(conversaId)||!vigente()||signal?.aborted)throw Error('revogado');
    if(tipo==='clickup'&&!token)throw Error('sem_credencial');
    const headers=tipo==='github'?{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'}:{};
    if(token)headers.Authorization=tipo==='github'?'Bearer '+token:token;
    const requestSignal=AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]);
    const response=await aguardar(this.fetch((tipo==='github'?'https://api.github.com':'https://api.clickup.com/api/v2')+path,
      {method:'GET',headers,redirect:'error',signal:requestSignal}),requestSignal);
    if(!response.ok)throw Error('consulta_indisponivel');
    const dados=await lerJsonLimitado(response,{signal:requestSignal});
    if(!this.permitida(conversaId)||!vigente())throw Error('revogado');
    return dados;
  }
  async consultar(conversaId,{signal,tipo=null}={}) {
    if(tipo!==null&&!['github','clickup'].includes(tipo))throw Error('Tipo de consulta inválido.');
    if(!this.permitida(conversaId))return [];
    signal=AbortSignal.any([AbortSignal.timeout(this.prazoMs),...(signal?[signal]:[])]);
    const fontes=[];
    for(const link of this.listar(conversaId).filter(link=>tipo===null||link.tipo===tipo)) {
      const id=link.tipo+':'+link.recurso;
      const versao=this.db.prepare('SELECT versao FROM pessoal_politicas WHERE conversa_id=?').get(conversaId)?.versao;
      const vigente=()=>this.db.prepare('SELECT versao FROM pessoal_politicas WHERE conversa_id=?').get(conversaId)?.versao===versao
        &&this.listar(conversaId).some(l=>l.tipo===link.tipo&&l.recurso===link.recurso);
      try {
        let dados,url;
        if(link.tipo==='github') {
          const repo=link.recurso.split('/').map(encodeURIComponent).join('/');
          const commits=await this.#get('github',`/repos/${repo}/commits?per_page=3`,signal,conversaId,vigente);
          const deployments=await this.#get('github',`/repos/${repo}/deployments?per_page=3`,signal,conversaId,vigente);
          if(!Array.isArray(commits)||!Array.isArray(deployments))throw Error('resposta_invalida');
          const publicacoes=[];
          for(const d of deployments.slice(0,3)) {
            if(!Number.isSafeInteger(d.id))continue;
            const statuses=await this.#get('github',`/repos/${repo}/deployments/${d.id}/statuses?per_page=1`,signal,conversaId,vigente);
            const s=Array.isArray(statuses)?statuses[0]:null;
            publicacoes.push({id:d.id,sha:curto(d.sha,64),ambiente:curto(d.environment,100),producao:d.production_environment===true,
              estado:curto(s?.state||'desconhecido',40),data:curto(s?.created_at,40)});
          }
          dados={commits:commits.slice(0,3).map(c=>({sha:curto(c.sha,64),mensagem:curto(c.commit?.message),data:curto(c.commit?.committer?.date,40)})),
            publicacoes,limite:'Commit não prova publicação; status GitHub é relato do integrador, não prova HTTP/visual da URL.'};
          url='https://github.com/'+repo;
        }else {
          const t=await this.#get('clickup','/task/'+encodeURIComponent(link.recurso),signal,conversaId,vigente);
          if(String(t.id)!==link.recurso)throw Error('tarefa_divergente');
          dados={id:t.id,nome:curto(t.name),estado:curto(t.status?.status,100),atualizadoEm:curto(t.date_updated,40),
            prazoInformado:curto(t.due_date,40),limite:'Tarefa concluída não comprova publicação nem aceite do cliente.'};
          url='https://app.clickup.com/t/'+encodeURIComponent(t.id);
        }
        if(!this.permitida(conversaId)||!vigente())return [];signal.throwIfAborted();
        fontes.push({id,tipo:link.tipo,recurso:link.recurso,url,dados,assinatura:hash(dados),consultadaEm:this.agora().toISOString(),disponivel:true});
      }catch {if(!this.permitida(conversaId)||!vigente())return [];fontes.push({id,tipo:link.tipo,recurso:link.recurso,disponivel:false,motivo:'Consulta não concluída ou sem permissão.'});}
    }
    return this.permitida(conversaId)?fontes:[];
  }
}
