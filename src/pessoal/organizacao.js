import {createHash} from 'node:crypto';
import {ContextoPessoal,lacunaFonte,validarConversa} from './contexto.js';
import {PoliticaPessoal} from './politica.js';
import {conferirCandidatasAcoes} from '../acoes-lume.js';
import {ProjetosComerciais} from '../projetos-comerciais/index.js';
import {NegociosDesktop} from '../negocios-desktop.js';
import {VendasJev} from '../vendas/servico.js';
import {CRITERIOS_ASSUNTO,CRITERIOS_ANDAMENTO,CRITERIOS_CONTINUIDADE,CRITERIOS_TEMPERATURA,CRITERIOS_ETAPA} from '../vendas/jev.js';
import {assinaturaFonte} from '../tarefas-esquema.js';
import {LEITURA_PESSOAL_SQL} from '../leitura-sql.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const falha=(code,message)=>Object.assign(new Error(message),{code});
const ativas=new Set(['sugerido','confirmado','estacionado']);
const escolha=(value,criteria,manual=false)=>value&&Object.hasOwn(criteria,value.valor)&&
  (manual&&value.confianca===null||Number.isFinite(value.confianca)&&value.confianca>=0&&value.confianca<=1)
  ?{valor:value.valor,confianca:value.confianca}:null;
const campos=(data,allowed)=>{
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!allowed.includes(k)))
    throw falha('ORGANIZACAO_INVALIDA','Informe somente os identificadores da organização.');
};

/** Adaptador local de registros já extraídos. Não extrai texto, chama modelos ou concede permissões. */
export class OrganizacaoPessoal {
  constructor(db,{agora=()=>new Date()}={}) {
    this.db=db;
    this.contexto=new ContextoPessoal(db);
    this.acoes=this.contexto.acoes;
    this.politica=new PoliticaPessoal(db,{agora});
    this.vendas=new VendasJev(db,{agora});
    this.projetos=new ProjetosComerciais(db,{agora});
    this.negocios=new NegociosDesktop(db,{agora});
  }

  #demanda(acaoId,conversaId) {
    const acao=this.acoes.obter(acaoId);
    if(!acao||acao.conversa_id!==conversaId||this.politica.regra(conversaId).atendimento.excluida)return null;
    const fonte=this.db.prepare(`SELECT e.* FROM desktop_fontes e WHERE e.id=? AND e.conversa_id=? AND ${LEITURA_PESSOAL_SQL}`).get(acao.evento_id,conversaId);
    if(!fonte||lacunaFonte(fonte))return null;
    try {
      const [literal]=conferirCandidatasAcoes([{fonte:'E'+fonte.id,tipo:acao.tipo,resumo:acao.resumo,trecho:acao.trecho,prazo_citado:acao.prazo_citado}],fonte);
      if(literal.trecho_inicio!==acao.trecho_inicio||literal.fonte_assinatura!==acao.fonte_assinatura)return null;
    }catch{return null;}
    return {acao,fonte};
  }

  #avaliacao(conversaId,fonte) {
    const regra=this.politica.regra(conversaId);
    if(regra.atendimento.excluida)return null;
    const a=this.vendas.obter({conversa_id:conversaId});
    if(!a||a.desatualizada||!a.fontes?.includes(fonte.id)||!['jev','manual'].includes(a.origem)||
      !Object.hasOwn(CRITERIOS_TEMPERATURA,a.temperatura)||!Object.hasOwn(CRITERIOS_ETAPA,a.etapa))return null;
    // Correção manual é local; não depende de cofre/consentimento de inferência externa.
    if(a.origem==='jev'&&(!regra.remoto||!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desktop_ia_conversas'").get()||
      this.db.prepare('SELECT permitida FROM desktop_ia_conversas WHERE conversa_id=?').get(conversaId)?.permitida!==1))return null;
    // Uma classificação automática descreve a entrada que a originou, não cada mensagem do contexto.
    if((a.origem==='jev'||a.eventoId!==undefined)&&a.eventoId!==fonte.id)return null;
    return {id:a.id,origem:a.origem,eventoId:a.eventoId??null,avaliadoEm:a.avaliado_em,
      temperatura:a.temperatura,etapa:a.etapa,assunto:escolha(a.assunto,CRITERIOS_ASSUNTO,a.origem==='manual'),
      andamento:escolha(a.andamento,CRITERIOS_ANDAMENTO,a.origem==='manual'),continuidade:escolha(a.continuidade,CRITERIOS_CONTINUIDADE,a.origem==='manual'),
      revisao:a.revisao??null,escopo:'fonte_atual',somenteSugestao:true};
  }

  #demandaUnica({acao,fonte}) {
    return this.db.prepare(`SELECT COUNT(*) n FROM lume_acoes WHERE evento_id=? AND fonte_assinatura=?
      AND (estado IN ('sugerido','confirmado','estacionado') OR id=?)`).get(fonte.id,acao.fonte_assinatura,acao.id).n===1;
  }

  #chave(fonte) {
    // Sem nome, rótulo Jev ou revisão: mudança de texto não cria outro projeto para a mesma origem.
    return 'pessoal-demanda-v1:'+hash([fonte.conversa_id,fonte.origem_id,fonte.id]);
  }
  #cobre(projeto,{acao,fonte}) {
    return projeto?.fontes.some(f=>f.eventoId===fonte.id&&f.conversaId===fonte.conversa_id&&
      f.inicio<=acao.trecho_inicio&&f.inicio+f.tamanho>=acao.trecho_inicio+acao.trecho.length);
  }
  #projeto(demanda,projetoId) {
    if(projetoId!==undefined) {
      if(typeof projetoId!=='string'||!projetoId||projetoId.length>200)throw falha('PROJETO_INDISPONIVEL','Projeto sem vínculo atual com esta fonte.');
      const projeto=this.projetos.obter(projetoId);
      if(!this.#cobre(projeto,demanda))throw falha('PROJETO_INDISPONIVEL','Projeto sem vínculo atual com esta fonte.');
      return {projeto};
    }
    const anterior=this.db.prepare('SELECT id FROM lume_projetos_comerciais WHERE chave=?').get(hash(['explicito',this.#chave(demanda.fonte)]));
    if(anterior) {
      const projeto=this.projetos.obter(anterior.id);
      return this.#cobre(projeto,demanda)?{projeto}:{motivo:'origem_ja_organizada_requer_revisao'};
    }
    // Reutilizar só um vínculo já existente sobre o trecho; nunca buscar por nome de pessoa/projeto.
    const rows=this.db.prepare(`SELECT DISTINCT projeto_id FROM lume_projetos_fontes
      WHERE evento_id=? AND removida=0 AND invalidada=0 AND inicio<=? AND inicio+tamanho>=?
      ORDER BY projeto_id LIMIT 21`).all(demanda.fonte.id,demanda.acao.trecho_inicio,demanda.acao.trecho_inicio+demanda.acao.trecho.length);
    if(rows.length>20)return {motivo:'vinculo_ambiguo'};
    const projetos=rows.map(r=>this.projetos.obter(r.projeto_id)).filter(p=>this.#cobre(p,demanda));
    return projetos.length>1?{motivo:'vinculo_ambiguo'}:{projeto:projetos[0]??null};
  }

  #item({acao,fonte},avaliacao,projeto=null) {
    const negocio=this.db.prepare('SELECT * FROM desktop_negocios WHERE evento_id=? AND assinatura=?').get(fonte.id,assinaturaFonte(fonte));
    const incerteza=[],unica=this.#demandaUnica({acao,fonte});
    if(!unica)incerteza.push('escopo_da_demanda_ambiguo');
    if(!avaliacao)incerteza.push('classificacao_indisponivel');
    else {
      if(!avaliacao.assunto||avaliacao.assunto.valor==='insuficiente')incerteza.push('assunto_insuficiente');
      if(!avaliacao.andamento||avaliacao.andamento.valor==='insuficiente')incerteza.push('andamento_insuficiente');
      if(avaliacao.continuidade?.valor==='incerto')incerteza.push('continuidade_incerta');
      if(avaliacao.revisao==='necessaria')incerteza.push('revisao_sugerida');
    }
    const grupo=projeto||unica&&avaliacao?.assunto?.valor==='projeto'?'projetos':
      negocio||unica&&(avaliacao?.assunto?.valor==='comercial'||avaliacao?.origem==='manual'&&avaliacao.temperatura!=='insuficiente')?'comercial':'tarefas';
    return {acaoId:acao.id,conversaId:fonte.conversa_id,eventoId:fonte.id,resumo:acao.resumo,tipo:acao.tipo,estado:acao.estado,
      fonte:{eventoId:fonte.id,conversaId:fonte.conversa_id,origemId:fonte.origem_id,trecho:acao.trecho,inicio:acao.trecho_inicio,assinatura:acao.fonte_assinatura,recebidoEm:fonte.recebido_em},
      grupo,avaliacao,incerteza,
      projeto:projeto?{id:projeto.id,nome:projeto.nome,natureza:projeto.natureza,estado:projeto.estado,acordoVerificado:false}:null,
      negocio:negocio?{id:negocio.id,titulo:negocio.titulo,etapa:negocio.etapa,revisao:negocio.revisao}:null,
      correcao:{acaoId:acao.id,conversaId:fonte.conversa_id,projetoId:projeto?.id??null},
      aviso:'Classificação é sugestão; temperatura não é probabilidade de venda. Andamento informado não comprova entrega ou aceite.'};
  }

  organizar(data={}) {
    campos(data,['acaoId','avaliacaoId','conversaId','projetoId']);
    const {acaoId,avaliacaoId,conversaId,projetoId}=data;validarConversa(conversaId);
    if(typeof avaliacaoId!=='string'||!avaliacaoId||avaliacaoId.length>200)throw falha('AVALIACAO_INDISPONIVEL','Escolha uma classificação atual.');
    this.db.exec('SAVEPOINT pessoal_organizacao');
    try {
      const demanda=this.#demanda(acaoId,conversaId);
      if(!demanda)throw falha('DEMANDA_INDISPONIVEL','Demanda sem fonte literal atual e permitida nesta conversa.');
      const avaliacao=this.#avaliacao(conversaId,demanda.fonte);
      if(!avaliacao||avaliacao.id!==avaliacaoId)throw falha('AVALIACAO_INDISPONIVEL','A classificação ou suas fontes mudaram.');
      let {projeto,motivo}=this.#projeto(demanda,projetoId),projetoCriado=false;
      if(!projeto&&avaliacao.assunto?.valor==='projeto') {
        const regra=this.politica.regra(conversaId),e=demanda.fonte;
        let novaEntrada=false;try{novaEntrada=JSON.parse(e.bruto)?.tipoLote==='notify';}catch{}
        if(!motivo&&!this.#demandaUnica(demanda))motivo='escopo_da_demanda_ambiguo';
        if(!motivo&&(!ativas.has(demanda.acao.estado)||regra.pausada||!this.politica.entradaAtual(e)||
          e.direcao!=='entrada'||e.autor_e_dono||e.do_proprio_bot||!novaEntrada))motivo='demanda_sem_ativacao_atual';
        if(!motivo) {
          projeto=this.projetos.criarRascunho({nome:demanda.acao.resumo.slice(0,160),natureza:'incerto',
            chave:this.#chave(e),fontes:[{eventoId:e.id,trecho:demanda.acao.trecho,inicio:demanda.acao.trecho_inicio}]});
          projetoCriado=projeto.criado;
        }
      }
      const result={item:this.#item(demanda,avaliacao,projeto),projetoCriado,
        candidato:motivo?{tipo:'projeto',motivo,acaoId,eventoId:demanda.fonte.id,conversaId}:null};
      this.db.exec('RELEASE pessoal_organizacao');return result;
    }catch(error){this.db.exec('ROLLBACK TO pessoal_organizacao;RELEASE pessoal_organizacao');throw error;}
  }

  listar(data={}) {
    campos(data,['conversaId','limite']);
    const {conversaId=null,limite=20}=data;
    if(conversaId!==null)validarConversa(conversaId);
    if(!Number.isSafeInteger(limite)||limite<1||limite>100)throw falha('ORGANIZACAO_INVALIDA','Escolha um limite de 1 a 100 itens.');
    const rows=this.db.prepare(`SELECT a.id,e.conversa_id FROM lume_acoes a JOIN eventos e ON e.id=a.evento_id
      WHERE a.estado IN ('sugerido','confirmado','estacionado') ${conversaId===null?'':'AND e.conversa_id=?'}
      ORDER BY a.atualizada_em DESC,a.id DESC LIMIT 201`).all(...(conversaId===null?[]:[conversaId]));
    const result={comercial:[],tarefas:[],projetos:[],candidatos:[],truncada:rows.length>200};let count=0;
    for(const row of rows.slice(0,200)) {
      const demanda=this.#demanda(row.id,row.conversa_id);if(!demanda)continue;
      if(count>=limite){result.truncada=true;break;}
      const avaliacao=this.#avaliacao(row.conversa_id,demanda.fonte),{projeto,motivo}=this.#projeto(demanda);
      const item=this.#item(demanda,avaliacao,projeto);result[item.grupo].push(item);count++;
      if(motivo)result.candidatos.push({tipo:'projeto',motivo,acaoId:row.id,eventoId:demanda.fonte.id,conversaId:row.conversa_id});
    }
    return result;
  }

  obter(acaoId) {
    const acao=this.acoes.obter(acaoId);if(!acao)return null;
    const demanda=this.#demanda(acaoId,acao.conversa_id);if(!demanda)return null;
    const avaliacao=this.#avaliacao(acao.conversa_id,demanda.fonte),{projeto}=this.#projeto(demanda);
    return this.#item(demanda,avaliacao,projeto);
  }
}
