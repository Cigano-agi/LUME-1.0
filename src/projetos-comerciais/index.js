import {createHash,randomUUID} from 'node:crypto';
import {LEITURA_SQL,LEITURA_PESSOAL_SQL} from '../leitura-sql.js';
import {assinaturaFonte} from '../tarefas-esquema.js';
import {avisosFonte} from '../fontes-desktop.js';
import {criarResolvedorContatoPorIdentificador} from '../contatos-desktop.js';
import {prepararProjetosComerciais} from './esquema.js';
import {previaDeAcoes,criarRascunhoDeAcoes} from './acoes.js';
import {listarImportados,prepararImportado,revalidarImportado} from './importacao.js';
import {derivacaoOrganizacaoAtual,comLeituraOrganizacao} from '../pessoal/organizacao-validade.js';
export {prepararProjetosComerciais,PROJETOS_COMERCIAIS_TABELAS,PROJETOS_COMERCIAIS_BACKUP} from './esquema.js';

const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const estados=['rascunho','confirmado','arquivado'];
const naturezas=['acordo_citado','proposta','incerto'];
const erro=(mensagem,codigo='PROJETO_INVALIDO')=>Object.assign(new Error(mensagem),{codigo});
const texto=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const limiteValido=(v,max)=>Number.isSafeInteger(v)&&v>0&&v<=max;
const conversaDireta=id=>typeof id==='string'&&/^[^@\s]+@(lid|s\.whatsapp\.net|c\.us)$/.test(id);

/** Serviço local: o chamador autentica sessão/termos/gesto. Não fornece grants nem envia mensagens. */
export class ProjetosComerciais {
  constructor(db,{agora=()=>new Date(),leituraLocal=false}={}){this.db=db;this.agora=agora;this.leituraLocal=leituraLocal===true;this.previasAcoes=new Map();this.previasImportados=new Map();prepararProjetosComerciais(db);}
  _quando(){return this.agora().toISOString();}
  _transacao(fn){
    const nome='pc_'+randomUUID().replaceAll('-','');this.db.exec('SAVEPOINT '+nome);
    try{const r=fn();this.db.exec('RELEASE '+nome);return r;}
    catch(e){this.db.exec('ROLLBACK TO '+nome);this.db.exec('RELEASE '+nome);throw e;}
  }
  _evento(id){
    return this.db.prepare(`SELECT e.* FROM desktop_fontes e WHERE e.id=? AND ${this.leituraLocal?LEITURA_PESSOAL_SQL:LEITURA_SQL}`).get(id);
  }
  _selecao({eventoId,trecho,inicio}={}){
    if(!Number.isSafeInteger(eventoId)||eventoId<1)throw erro('Evento inválido.');
    const e=this._evento(eventoId);
    if(!e||typeof e.texto!=='string'||!e.texto.trim())throw erro('Fonte indisponível ou sem permissão de leitura.','FONTE_INDISPONIVEL');
    let selecao='evento',pos=0,tamanho=e.texto.length;
    if(trecho!==undefined){
      if(!texto(trecho,4000))throw erro('Selecione um trecho literal de até 4000 caracteres.');
      selecao='trecho';pos=inicio??e.texto.indexOf(trecho);tamanho=trecho.length;
      if(!Number.isSafeInteger(pos)||pos<0||e.texto.slice(pos,pos+tamanho)!==trecho)throw erro('Trecho ausente na fonte ou posição inválida.');
      if(inicio===undefined&&e.texto.indexOf(trecho,pos+1)!==-1)throw erro('Trecho repetido: informe a posição inicial.');
    }else if(inicio!==undefined)throw erro('Posição inicial exige um trecho.');
    return {eventoId,assinatura:assinaturaFonte(e),selecao,inicio:pos,tamanho};
  }
  _registrar(id,tipo,fonteId=null){
    const quando=this._quando();
    this.db.prepare('INSERT INTO lume_projetos_historico(projeto_id,tipo,fonte_id,quando) VALUES(?,?,?,?)').run(id,tipo,fonteId,quando);
    this.db.prepare('UPDATE lume_projetos_comerciais SET atualizado_em=? WHERE id=?').run(quando,id);
  }
  _inserirFonte(id,f,base){
    const fonteId=randomUUID();
    this.db.prepare(`INSERT INTO lume_projetos_fontes(id,projeto_id,evento_id,assinatura,inicio,tamanho,selecao,base,criada_em)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(fonteId,id,f.eventoId,f.assinatura,f.inicio,f.tamanho,f.selecao,base,this._quando());
    return fonteId;
  }
  _lerFonte(f){
    if(f.removida||f.invalidada)return null;
    if(!derivacaoOrganizacaoAtual(this.db,'vinculo',f.id,{externo:!this.leituraLocal}))return null;
    const e=this._evento(f.evento_id);
    if(!e||assinaturaFonte(e)!==f.assinatura||typeof e.texto!=='string'||e.texto.length<f.inicio+f.tamanho)return null;
    const conteudo=e.texto.slice(f.inicio,f.inicio+f.tamanho);
    return {id:f.id,eventoId:f.evento_id,conversaId:e.conversa_id,origemId:e.origem_id,
      selecao:f.selecao,inicio:f.inicio,tamanho:f.tamanho,trecho:conteudo.slice(0,4000),truncada:conteudo.length>4000,
      recebidoEm:e.recebido_em,tipo:e.tipo,base:Boolean(f.base),avisos:avisosFonte(e),
      transcricao: Boolean(e.transcricao_meta)};
  }
  _carregar(id){
    if(!texto(id,200))return null;
    const p=this.db.prepare('SELECT * FROM lume_projetos_comerciais WHERE id=?').get(id);if(!p)return null;
    if(!derivacaoOrganizacaoAtual(this.db,'projeto',id,{externo:!this.leituraLocal}))return null;
    const links=this.db.prepare('SELECT * FROM lume_projetos_fontes WHERE projeto_id=? ORDER BY criada_em,id').all(id);
    const fontes=links.map(f=>this._lerFonte(f)).filter(Boolean);
    // O nome também é derivado das fontes de criação. Não vaza quando qualquer base perde autoridade.
    if(fontes.filter(f=>f.base).length!==p.bases_total)return null;
    return {p,links,fontes};
  }
  _exigir(id){const r=this._carregar(id);if(!r)throw erro('Projeto indisponível: fonte removida, alterada ou sem permissão.','PROJETO_INDISPONIVEL');return r;}
  _publico({p,links,fontes}){
    return {id:p.id,nome:p.nome,natureza:p.natureza,estado:p.estado,acordoVerificado:false,
      criadoEm:p.criado_em,atualizadoEm:p.atualizado_em,fontes,
      fontesIndisponiveis:links.filter(f=>!f.removida).length-fontes.length};
  }
  criarRascunho({nome,fontes,natureza='incerto',chave}={}){
    if(!texto(nome,160)||!naturezas.includes(natureza)||!Array.isArray(fontes)||fontes.length<1||fontes.length>32||
      chave!==undefined&&!texto(chave,200))throw erro('Nome, natureza, fontes ou chave inválidos.');
    return this._transacao(()=>{
      const selecoes=fontes.map(f=>this._selecao(f));
      selecoes.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      if(new Set(selecoes.map(f=>hash(f))).size!==selecoes.length)throw erro('Fonte repetida no projeto.');
      const assinatura=hash([nome.trim(),natureza,selecoes]);
      const chaveEfetiva=hash(chave===undefined?['automatico',assinatura]:['explicito',chave]);
      const anterior=this.db.prepare('SELECT * FROM lume_projetos_comerciais WHERE chave=?').get(chaveEfetiva);
      if(anterior){
        if(anterior.assinatura_criacao!==assinatura)throw erro('Chave de idempotência já usada com outro conteúdo.','CONFLITO_IDEMPOTENCIA');
        return {...this._publico(this._exigir(anterior.id)),criado:false};
      }
      const id=randomUUID(),quando=this._quando();
      this.db.prepare(`INSERT INTO lume_projetos_comerciais(id,nome,natureza,estado,chave,assinatura_criacao,bases_total,criado_em,atualizado_em)
        VALUES(?,?,?,'rascunho',?,?,?,?,?)`).run(id,nome.trim(),natureza,chaveEfetiva,assinatura,selecoes.length,quando,quando);
      for(const f of selecoes)this._registrar(id,'fonte_vinculada',this._inserirFonte(id,f,1));
      this._registrar(id,'criado');return {...this._publico(this._exigir(id)),criado:true};
    });
  }
  previaDeAcoes(pedido){return previaDeAcoes(this,pedido);}
  criarRascunhoDeAcoes(pedido){return criarRascunhoDeAcoes(this,pedido);}
  listarImportados(pedido){return listarImportados(this,pedido);}
  prepararImportado(pedido){return prepararImportado(this,pedido);}
  revalidarImportado(pedido){return revalidarImportado(this,pedido);}
  obter(id){return comLeituraOrganizacao(this.db,()=>{const r=this._carregar(id);return r?this._publico(r):null;});}
  listar({estado,limite=100,offset=0,q=''}={}){
    return comLeituraOrganizacao(this.db,()=>this._listar({estado,limite,offset,q}));
  }
  _listar({estado,limite,offset,q}){
    if(estado!==undefined&&!estados.includes(estado)||!limiteValido(limite,200)||!Number.isSafeInteger(offset)||offset<0||offset>100000||typeof q!=='string'||q.length>160)throw erro('Filtro ou limite inválido.');
    const rows=this.db.prepare(`SELECT id FROM lume_projetos_comerciais WHERE (?='' OR estado=?) AND (?='' OR nome LIKE ? ESCAPE '\\') ORDER BY atualizado_em DESC,id`);
    const like='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
    const saida=[];let pulados=0;
    for(const row of rows.iterate(estado||'',estado||'',q,like)){const p=this.obter(row.id);if(p){if(pulados++<offset)continue;saida.push(p);}if(saida.length>=limite)break;}
    return saida;
  }
  /** Resumo de projeto ligado à fonte exata de cada contato; descoberta nunca concede autoridade. */
  resumosConfirmadosPorContatos(contatos){
    const saida=new Map();
    if(!Array.isArray(contatos)||contatos.length>12)return saida;
    const resolver=criarResolvedorContatoPorIdentificador(this.db),entrada=[];
    for(const contato of contatos){
      if(!contato||typeof contato.id!=='string'||!Array.isArray(contato.identificadores)||contato.identificadores.length>32)continue;
      for(const jid of new Set(contato.identificadores)){
        if(resolver(jid)===contato.id)entrada.push({id:contato.id,jid});
      }
    }
    if(!entrada.length)return saida;
    // Consulta limitada de candidatos. Política, bases e assinaturas são validadas por obter().
    const rows=this.db.prepare(`WITH entrada AS (
        SELECT json_extract(value,'$.id') contato_id,json_extract(value,'$.jid') jid FROM json_each(?)
      ) SELECT i.contato_id,i.jid,p.id projeto_id,p.atualizado_em,f.id link_id,
        e.id evento_id,e.conversa_id,e.autor_id,COALESCE(e.autor_e_dono,0) dono,e.recebido_em,
        (SELECT COUNT(*) FROM lume_projetos_fontes lf WHERE lf.projeto_id=p.id) links_total
      FROM entrada i JOIN eventos e ON (e.conversa_id=i.jid OR (e.autor_id=i.jid AND COALESCE(e.autor_e_dono,0)=0))
      JOIN lume_projetos_fontes f ON f.evento_id=e.id
      JOIN lume_projetos_comerciais p ON p.id=f.projeto_id
      WHERE p.estado='confirmado' AND f.removida=0 AND f.invalidada=0
      ORDER BY i.contato_id,p.atualizado_em DESC,p.id,e.recebido_em DESC,e.id DESC,f.id
      LIMIT 1025`).all(JSON.stringify(entrada));
    if(rows.length>1024)return saida;
    const porContato=new Map(),contados=new Map();let linksUsados=0;
    for(const row of rows){
      const papel=conversaDireta(row.conversa_id)?'dm':'grupo';
      if(papel==='dm'?row.conversa_id!==row.jid:row.autor_id!==row.jid||row.dono)continue;
      let projetos=porContato.get(row.contato_id);
      if(!projetos){projetos=new Map();porContato.set(row.contato_id,projetos);}
      let candidato=projetos.get(row.projeto_id);
      if(!candidato){
        if(projetos.size>=4)continue;
        if(!contados.has(row.projeto_id)){
          if(!Number.isSafeInteger(row.links_total)||row.links_total<1||linksUsados+row.links_total>512||contados.size>=48)continue;
          linksUsados+=row.links_total;contados.set(row.projeto_id,null);
        }
        candidato=[];projetos.set(row.projeto_id,candidato);
      }
      candidato.push({linkId:row.link_id,eventoId:row.evento_id,jid:row.jid,papel,conversaId:row.conversa_id,recebidoEm:row.recebido_em});
    }
    for(const [contatoId,projetos] of porContato){
      for(const [id,candidatos] of projetos){
        if(contados.get(id)===null)contados.set(id,this.obter(id)||false);
        const projeto=contados.get(id);
        if(!projeto||projeto.estado!=='confirmado')continue;
        const fontes=new Map(projeto.fontes.map(f=>[f.id,f]));
        const fonte=candidatos.find(c=>{
          const f=fontes.get(c.linkId);
          return f&&f.eventoId===c.eventoId&&f.conversaId===c.conversaId&&
            (c.papel==='dm'?c.conversaId===c.jid:!conversaDireta(c.conversaId));
        });
        if(fonte){saida.set(contatoId,{id:projeto.id,nome:projeto.nome,fonteId:fonte.eventoId});break;}
      }
    }
    return saida;
  }
  vincularFonte({id,eventoId,trecho,inicio}={}){
    return this._transacao(()=>{
      const {p}=this._exigir(id);if(p.estado==='arquivado')throw erro('Restaure o projeto antes de vincular fontes.');
      const f=this._selecao({eventoId,trecho,inicio});
      const antiga=this.db.prepare('SELECT * FROM lume_projetos_fontes WHERE projeto_id=? AND evento_id=? AND selecao=? AND inicio=? AND tamanho=?')
        .get(id,f.eventoId,f.selecao,f.inicio,f.tamanho);
      if(antiga){
        if(antiga.invalidada||antiga.assinatura!==f.assinatura)throw erro('Vínculo invalidado: crie uma nova seleção após revisar a fonte.','FONTE_INDISPONIVEL');
        if(!antiga.removida)return {id,fonteId:antiga.id,criado:false};
        this.db.prepare('UPDATE lume_projetos_fontes SET removida=0 WHERE id=?').run(antiga.id);
        this._registrar(id,'fonte_vinculada',antiga.id);return {id,fonteId:antiga.id,criado:false};
      }
      if(this.db.prepare('SELECT count(*) n FROM lume_projetos_fontes WHERE projeto_id=?').get(id).n>=128)throw erro('Limite de fontes do projeto atingido.');
      const fonteId=this._inserirFonte(id,f,0);this._registrar(id,'fonte_vinculada',fonteId);return {id,fonteId,criado:true};
    });
  }
  desvincularFonte({id,fonteId}={}){
    return this._transacao(()=>{
      this._exigir(id);
      const f=this.db.prepare('SELECT * FROM lume_projetos_fontes WHERE id=? AND projeto_id=?').get(fonteId,id);
      if(!f)throw erro('Vínculo inexistente.');
      if(f.base)throw erro('Fonte de criação: arquive o projeto para desfazer o rascunho.');
      if(f.removida)return {id,fonteId,alterado:false};
      this.db.prepare('UPDATE lume_projetos_fontes SET removida=1 WHERE id=?').run(fonteId);
      this._registrar(id,'fonte_desvinculada',fonteId);return {id,fonteId,alterado:true};
    });
  }
  _estado(id,novo,tipo){
    return this._transacao(()=>{
      const {p}=this._exigir(id);if(p.estado===novo)return {...this.obter(id),alterado:false};
      if(novo==='confirmado'&&p.estado!=='rascunho'||tipo==='restaurado'&&p.estado!=='arquivado')throw erro('Transição de estado inválida.');
      this.db.prepare('UPDATE lume_projetos_comerciais SET estado=? WHERE id=?').run(novo,id);
      this._registrar(id,tipo);return {...this.obter(id),alterado:true};
    });
  }
  confirmar({id,confirmar}={}){
    if(confirmar!==true)throw erro('Confirmação explícita da organização do projeto é necessária.');
    return this._estado(id,'confirmado','confirmado');
  }
  arquivar({id}={}){return this._estado(id,'arquivado','arquivado');}
  restaurar({id}={}){return this._estado(id,'rascunho','restaurado');}
  timeline({id,limite=100,antes}={}){
    if(!limiteValido(limite,200)||antes!==undefined&&(!Number.isSafeInteger(antes)||antes<1))throw erro('Paginação inválida.');
    const r=this._carregar(id);if(!r)return [];
    const permitidas=new Set(r.fontes.map(f=>f.id));
    const rows=this.db.prepare(`SELECT * FROM lume_projetos_historico WHERE projeto_id=? ${antes?'AND id<?':''} ORDER BY id DESC LIMIT ?`)
      .all(...(antes?[id,antes,limite]:[id,limite]));
    return rows.map(h=>({id:h.id,tipo:h.tipo,quando:h.quando,
      fonteId:h.fonte_id&&permitidas.has(h.fonte_id)?h.fonte_id:null,
      fonteIndisponivel:h.tipo.startsWith('fonte_')&&(!h.fonte_id||!permitidas.has(h.fonte_id)),
      fonte:h.fonte_id?r.fontes.find(f=>f.id===h.fonte_id)??null:null}));
  }
}
