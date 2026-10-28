import {criarNomeVisivel} from './nomes-conversa.js';
import {comLeituraOrganizacao} from './pessoal/organizacao-validade.js';

const parse = value => { try { return JSON.parse(value || 'null'); } catch { return null; } };
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const executionLabels = {em_andamento:'Em andamento',aguardando_assistente:'Aguardando executor',resultado_informado:'Resultado informado · falta conferir',verificado:'Resultado verificado',invalidada:'Contexto alterado · confira',revogada:'Execução revogada',expirada:'Autorização expirada',indisponivel:'Execução indisponível'};

/** Read projection only. Permission and source validity stay with the original services.
 * No schema, classification, queue, consent or delivery is created by this adapter. */
export class ExperienciaLume {
  constructor(db,{acoes,produto,organizacao=null,pessoal=null,conexao=null,agora=()=>new Date()}={}) {
    Object.assign(this,{db,acoes,produto,organizacao,pessoal,conexao,agora});
    this.nome=criarNomeVisivel(db);
  }
  listar({pagina=1,limite=30}={}) {
    return comLeituraOrganizacao(this.db,()=>this._listar({pagina,limite}));
  }
  _listar({pagina,limite}) {
    if(!Number.isSafeInteger(pagina)||pagina<1||pagina>1000||!Number.isSafeInteger(limite)||limite<1||limite>50)throw Error('Paginação inválida.');
    const atualizadoEm=this.agora().toISOString(),lacunas=[];
    if(!this.acoes)return {versao:1,atualizadoEm,itens:[],lacunas:['A organização de assuntos está indisponível neste ambiente.'],conexao:{estado:'indisponivel'},pagina,proximaPagina:null};
    // Pages are bounded per existing state; identity deduplication prevents a due
    // snoozed action occurring both in ativos and estacionado.
    const rows=new Map();let more=false;
    for(const estado of ['ativos','estacionado','resolvido']) {
      const page=this.acoes.listar({estado,pagina,limite});
      if(page.length===limite)more=true;
      for(const row of page)rows.set(row.id,row);
    }
    const itens=[];
    for(const action of rows.values()) {
      const item=this.projetar(action,this.organizacao?.obter(action.id));
      if(item)itens.push(item);
    }
    if(this.pessoal?.organizador){
      const projects=this.pessoal.organizador.projetos.listar({limite:limite+1,offset:(pagina-1)*limite});
      if(projects.length>limite)more=true;
      for(const p of projects.slice(0,limite)){
        const item=this.projetarProjeto(p);if(item&&!itens.some(i=>i.projetoId===p.id))itens.push(item);
      }
      const events=this.pessoal.organizador.acontecimentos({pagina,limite});
      if(events.proximaPagina)more=true;
      for(const event of events.itens){const item=this.projetarAcontecimento(event);if(item)itens.push(item);}
    }
    itens.sort((a,b)=>({precisa:0,cuidando:1,mudou:2}[a.grupo]-{precisa:0,cuidando:1,mudou:2}[b.grupo])||b.atualizadoEm.localeCompare(a.atualizadoEm)||a.id.localeCompare(b.id));
    if(more)lacunas.push('Este é um recorte paginado dos assuntos disponíveis.');
    let connection;try{connection=this.conexao?.estado?.();}catch{}
    const capturaPausada=this.db.prepare("SELECT valor FROM desktop_config WHERE chave='captura_pausada'").get()?.valor==='1';
    return {versao:1,atualizadoEm,itens,lacunas,pagina,proximaPagina:more?pagina+1:null,
      conexao:{estado:connection?.estado||'indisponivel',captura:capturaPausada?'pausada':connection?.estado==='conectada'?'disponivel':'indisponivel',processamento:this.pessoal?.running?'em_andamento':'sem_execucao_observada'}};
  }
  obter(id){
    return comLeituraOrganizacao(this.db,()=>this._obter(id));
  }
  _obter(id){
    if(typeof id!=='string'||!/^(?:(?:acao|projeto):[0-9a-f-]{36}|acontecimento:[1-9][0-9]*:[0-3])$/i.test(id))throw Error('Assunto inválido.');
    const action=id.startsWith('acao:')?this.acoes?.obter(id.slice(5)):null;
    const event=id.startsWith('acontecimento:')?this.pessoal?.organizador?.acontecimento(Number(id.split(':')[1]),Number(id.split(':')[2])):null;
    const item=event?this.projetarAcontecimento(event):id.startsWith('projeto:')?this.projetarProjeto(this.pessoal?.organizador?.projetos.obter(id.slice(8))):action?this.projetar(action,this.organizacao?.obter(action.id)):null;
    return {versao:1,atualizadoEm:this.agora().toISOString(),itens:item?[item]:[],lacunas:item?[]:['Assunto indisponível ou fonte alterada.'],pagina:1,proximaPagina:null};
  }
  projetar(action,organized) {
    let source;
    try{source=this.produto.fonte(action.evento_id,{detalhes:false});}catch{return null;}
    if(!source||source.conversa_id!==action.conversa_id)return null;
    // An attendance exclusion is also honored by this companion projection.
    if(this.pessoal?.politica?.regra(action.conversa_id)?.atendimento?.excluida)return null;
    const acompanhamento=parse(this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get('pessoal-acompanhamento:'+action.id)?.valor);
    const following=Boolean(acompanhamento&&iso(acompanhamento.proxima));
    const followingActive=following&&this.pessoal?.ativa?.()===true;
    const execution=action.execucao_ui||{estado:'nenhuma'};
    const changed=action.estado==='resolvido'||execution.estado==='verificado';
    const working=execution.estado==='em_andamento'||followingActive;
    const inferred=this.pessoal?.organizador?.sugestoes(action.evento_id);
    if(this.pessoal?.organizador?.config('acao-inferida:'+action.id)&&!inferred&&action.estado==='sugerido')return null;
    const overlap=v=>v.inicio<=action.trecho_inicio&&v.inicio+v.trecho.length>=action.trecho_inicio+action.trecho.length;
    const oportunidade=inferred?.oportunidades?.some(overlap),vinculo=inferred?.vinculos?.find(v=>v.tipo==='projeto'&&v.projetoId&&overlap(v));
    const manual=this.pessoal?.organizador?.vinculoManual(action.evento_id,action.trecho_inicio,action.trecho.length);
    const projetoInferido=manual?this.pessoal.organizador.projetos.obter(manual.projetoId):vinculo?this.pessoal.organizador.projetos.obter(vinculo.projetoId):null;
    const categoria=organized?.grupo==='comercial'||oportunidade||action.tipo==='lead'?'comercial':organized?.grupo==='projetos'||projetoInferido||['pendencia','compromisso'].includes(action.tipo)?'entregas':'combinados';
    const lacunas=[];
    if(!organized?.avaliacao&&!inferred)lacunas.push('Classificação ainda não disponível.');
    if(!action.prazo_citado)lacunas.push('Prazo não informado.');
    if(!action.responsavel_id)lacunas.push('Responsável não confirmado.');
    if(following&&!followingActive)lacunas.push('Acompanhamento registrado; serviço pessoal pausado.');
    if(organized?.incerteza?.includes('escopo_da_demanda_ambiguo'))lacunas.push('Há mais de um pedido na mesma fonte; confira o vínculo.');
    if(source.lacunas?.length)lacunas.push('A fonte tem conteúdo parcial; confira a origem.');
    const state=execution.estado!=='nenhuma'?execution.estado:action.estado;
    const estadoRotulo=executionLabels[state]||({sugerido:'Para conferir',confirmado:'Combinado confirmado',estacionado:'Adiado por você',resolvido:'Marcado como resolvido'}[state]||'Estado não identificado');
    const acoes=[{tipo:'abrir',rotulo:'Abrir assunto'},{tipo:'fonte',rotulo:'Ver fonte'},{tipo:'acao',rotulo:'Rever ação'}];
    if(this.pessoal?.ativa?.()&&this.pessoal?.politica?.podeEnviar?.(action.conversa_id)?.permitido)acoes.push({tipo:'preparar',rotulo:'Preparar resposta'});
    if(!following&&this.pessoal?.politica?.regra(action.conversa_id)?.remoto&&this.pessoal?.contexto?.acompanhar(action.id,{remoto:true}))acoes.push({tipo:'acompanhar',rotulo:'Acompanhar assunto'});
    return {id:'acao:'+action.id,acaoId:action.id,assunto:action.resumo,
      pessoas:[{id:action.conversa_id,nome:source.conversa_nome||this.nome(action.conversa_nome,action.conversa_id)}],
      categoria,origem:organized?.avaliacao?.origem==='manual'?'corrigido':action.estado==='sugerido'?'sugerido':'informado',
      atualizadoEm:action.atualizada_em,estado:state,estadoRotulo,grupo:changed?'mudou':working?'cuidando':'precisa',
      acontecimento:action.trecho,consequencia:changed?'Confira o resultado e os registros deste assunto.':working?'Acompanhe o andamento e a próxima verificação.':'Confira o contexto para decidir o próximo passo.',
      lacunas,conversaId:action.conversa_id,projetoId:manual?projetoInferido?.id||null:organized?.projeto?.id||projetoInferido?.id||null,projeto:manual?projetoInferido:organized?.projeto||projetoInferido||null,
      tags:this.pessoal?.organizador?.tags(action.conversa_id)||[],organizacao:inferred?{origem:inferred.origem,atualizadoEm:inferred.atualizadoEm,assuntos:inferred.assuntos}:null,
      prazo:action.prazo_citado||null,responsavel:action.responsavel_id?{id:action.responsavel_id,nome:this.nome(null,action.responsavel_id)}:null,
      acompanhamento:following?{ativo:followingActive,proximaVerificacao:iso(acompanhamento.proxima)}:null,
      execucao:execution,avaliacao:organized?.avaliacao?.origem==='manual'?organized.avaliacao:this.pessoal?.organizador?.avaliacao(action.evento_id,action.trecho_inicio,action.trecho.length)||organized?.avaliacao||null,negocio:organized?.negocio||null,
      entrega:{informada:execution.estado==='resultado_informado'||execution.estado==='verificado',verificada:execution.estado==='verificado',enviada:null,aceita:null},
      fonte:{id:source.id,eventoId:source.id,tipo:source.tipo,conversaId:source.conversa_id,autor:source.autor_nome,recebidoEm:source.recebido_em,trecho:action.trecho},
      acoes};
  }
  projetarAcontecimento(event){
    if(!event)return null;
    let source;try{source=this.produto.fonte(event.fonte.eventoId,{detalhes:false});}catch{return null;}
    if(!source)return null;
    const labels={decisao:'Decisão sugerida',mudanca:'Mudança sugerida',resultado:'Resultado citado · falta conferir'};
    return {id:event.id,acaoId:null,assunto:event.resumo,categoria:'memoria',origem:'sugerido',estado:'sugerido',estadoRotulo:labels[event.tipo]||'Acontecimento sugerido',
      grupo:'mudou',atualizadoEm:event.atualizadoEm,recebidoEm:event.recebidoEm,acontecimento:event.trecho,
      consequencia:'Confira o trecho antes de considerar esta interpretação confirmada.',
      pessoas:[{id:source.conversa_id,nome:source.conversa_nome||this.nome(null,source.conversa_id)}],conversaId:source.conversa_id,
      projetoId:null,projeto:null,prazo:null,responsavel:null,acompanhamento:null,execucao:{estado:'nenhuma'},avaliacao:null,negocio:null,
      entrega:{informada:false,verificada:false,enviada:null,aceita:null},
      fonte:{...event.fonte,autor:source.autor_nome},lacunas:['Interpretação sugerida; não confirma execução, verificação, envio ou aceite.'],
      acoes:[{tipo:'abrir',rotulo:'Abrir acontecimento'},{tipo:'fonte',rotulo:'Ver fonte'}]};
  }
  projetarProjeto(projeto){
    if(!projeto?.fontes?.length)return null;
    const fonte=projeto.fontes[0],org=this.pessoal?.organizador;
    if(!org?.fonte(fonte.eventoId)||this.pessoal?.politica?.regra(fonte.conversaId)?.atendimento?.excluida)return null;
    const manual=org.vinculoManual(fonte.eventoId,fonte.inicio,fonte.tamanho);if(manual&&manual.projetoId!==projeto.id)return null;
    const inference=org.sugestoes(fonte.eventoId);
    // Projetos inferidos só conservam visibilidade enquanto sua derivação é atual.
    const automatic=org.config('projeto-inferido:'+projeto.id);
    if(automatic&&!inference&&projeto.estado==='rascunho'&&manual?.projetoId!==projeto.id)return null;
    const source=this.produto.fonte(fonte.eventoId,{detalhes:false});if(!source)return null;
    return {id:'projeto:'+projeto.id,acaoId:null,assunto:projeto.nome,pessoas:[{id:fonte.conversaId,nome:source.conversa_nome||this.nome(null,fonte.conversaId)}],
      categoria:'entregas',origem:projeto.estado==='confirmado'?'confirmado':'sugerido',estado:projeto.estado,estadoRotulo:projeto.estado==='confirmado'?'Projeto confirmado':'Projeto sugerido · confira',
      atualizadoEm:projeto.atualizadoEm,grupo:'mudou',acontecimento:fonte.trecho,consequencia:'Projeto identificado neste trecho. Confira os vínculos e os combinados.',
      conversaId:fonte.conversaId,projetoId:projeto.id,projeto,prazo:null,responsavel:null,acompanhamento:null,execucao:{estado:'nenhuma'},avaliacao:null,negocio:null,
      entrega:{informada:false,verificada:false,enviada:null,aceita:null},fonte:{...fonte,id:fonte.eventoId,autor:source.autor_nome},lacunas:[],
      acoes:[{tipo:'abrir',rotulo:'Abrir projeto'},{tipo:'fonte',rotulo:'Ver fonte'}]};
  }
  companheiro(){
    const view=this.listar({limite:10});
    const itens=view.itens.filter(i=>i.id.startsWith('acao:'));
    const item=itens.find(item=>item.grupo==='precisa'&&item.estado!=='estacionado')||itens.find(item=>item.grupo==='cuidando')||itens[0];
    return item?{id:item.id,assunto:item.assunto.slice(0,160),pessoa:item.pessoas[0]?.nome||'',estado:item.estado,grupo:item.grupo,motivo:item.consequencia,prazo:item.prazo,fonteId:item.fonte.id,atualizadoEm:item.atualizadoEm,destino:{tipo:'assunto',id:item.id}}:null;
  }
}
