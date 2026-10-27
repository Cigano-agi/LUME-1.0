import { neon } from '@neondatabase/serverless';
import {codificarCursorFeedback,TAMANHO_PAGINA_FEEDBACK} from '../../src/feedback-paginacao.js';

const linha=item=>({
  id:item.id,rotulo:item.rotulo,plataforma:item.plataforma,arquitetura:item.arquitetura,
  canal:item.canal,versao:item.versao,estadoAtualizacao:item.estado_atualizacao,
  codigoErro:item.codigo_erro,whatsappEstado:item.whatsapp_estado,
  criadoEm:new Date(item.criado_em).toISOString(),ultimoContatoEm:new Date(item.ultimo_contato_em).toISOString(),
  ultimoPulsoEm:item.ultimo_pulso_em?new Date(item.ultimo_pulso_em).toISOString():null,
  revogadoEm:item.revogado_em?new Date(item.revogado_em).toISOString():null
});

export function criarRepositorioNeon(connectionString=process.env.DATABASE_URL,{criarCliente=neon}={}){
  if(typeof connectionString!=='string'||!connectionString.trim())throw Object.assign(new Error('CENTRAL_NAO_CONFIGURADA'),{codigo:'CENTRAL_NAO_CONFIGURADA',status:503});
  let sql;
  try{sql=criarCliente(connectionString);}
  catch{throw Object.assign(new Error('CENTRAL_INDISPONIVEL'),{codigo:'CENTRAL_INDISPONIVEL',status:503});}
  return {
    async verificarSchema(){
      try{
        const [item]=await sql`SELECT to_regclass('public.lume_convites') IS NOT NULL AS convites, to_regclass('public.lume_instalacoes') IS NOT NULL AS instalacoes, to_regclass('public.lume_feedback') IS NOT NULL AS feedback, to_regclass('public.lume_schema_migrations') IS NOT NULL AS controle`;
        if(!item?.convites||!item?.instalacoes||!item?.feedback||!item?.controle)throw Object.assign(new Error('SCHEMA_INCOMPLETO'),{codigo:'SCHEMA_INCOMPLETO',status:503});
        const aplicadas=await sql`SELECT nome FROM lume_schema_migrations WHERE nome IN ('001-operacao.sql','002-feedback.sql','003-feedback-severidade.sql','004-feedback-contato.sql','005-pulso-confirmado.sql')`;
        if(aplicadas.length!==5)throw Object.assign(new Error('SCHEMA_INCOMPLETO'),{codigo:'SCHEMA_INCOMPLETO',status:503});
        return {ok:true,banco:'pronto',schema:'005-pulso-confirmado'};
      }catch(error){
        if(error?.codigo==='SCHEMA_INCOMPLETO')throw error;
        throw Object.assign(new Error('CENTRAL_INDISPONIVEL'),{codigo:'CENTRAL_INDISPONIVEL',status:503});
      }
    },
    async criarConvite(item){
      await sql`INSERT INTO lume_convites(id,rotulo,codigo_hash,criado_em) VALUES(${item.id},${item.rotulo},${item.codigoHash},${item.criadoEm})`;
    },
    async revogarConvite(id,agora){
      const itens=await sql`UPDATE lume_convites SET revogado_em=${agora} WHERE id=${id} AND usado_em IS NULL AND revogado_em IS NULL RETURNING id`;
      return Boolean(itens.length);
    },
    async consumirConvite({conviteHash,instalacaoId,tokenHash,dados,agora}){
      const [itens]=await sql.transaction(tx=>[
        tx`WITH convite AS (
          UPDATE lume_convites SET usado_em=${agora}, usado_por=${instalacaoId}
          WHERE codigo_hash=${conviteHash} AND revogado_em IS NULL AND (usado_em IS NULL OR usado_por=${instalacaoId})
          RETURNING rotulo
        )
        INSERT INTO lume_instalacoes(id,rotulo,token_hash,plataforma,arquitetura,canal,versao,estado_atualizacao,whatsapp_estado,criado_em,ultimo_contato_em)
        SELECT ${instalacaoId},rotulo,${tokenHash},${dados.plataforma},${dados.arquitetura},${dados.canal},${dados.versao},'em_dia','nao_informado',${agora},${agora} FROM convite
        ON CONFLICT(id) DO UPDATE SET token_hash=EXCLUDED.token_hash,plataforma=EXCLUDED.plataforma,arquitetura=EXCLUDED.arquitetura,canal=EXCLUDED.canal,versao=EXCLUDED.versao,ultimo_contato_em=EXCLUDED.ultimo_contato_em
        WHERE lume_instalacoes.revogado_em IS NULL
        RETURNING id,canal`
      ]);
      return itens[0]??null;
    },
    async registrarPulso({tokenHash,dados,agora}){
      const itens=await sql`UPDATE lume_instalacoes SET versao=${dados.versao},canal=${dados.canal},plataforma=${dados.plataforma},arquitetura=${dados.arquitetura},estado_atualizacao=${dados.estadoAtualizacao},codigo_erro=${dados.codigoErro},whatsapp_estado=${dados.whatsappEstado},ultimo_contato_em=${agora},ultimo_pulso_em=${agora} WHERE token_hash=${tokenHash} AND revogado_em IS NULL RETURNING id`;
      return itens[0]??null;
    },
    async salvarFeedback({tokenHash,dados,conteudoHash,id,agora}){
      const inseridos=await sql`INSERT INTO lume_feedback(id,instalacao_id,chave_cliente,categoria,etapa,relato,utilidade,contato_autorizado,conteudo_hash,versao,plataforma,criado_em,atualizado_em)
        SELECT ${id},i.id,${dados.chaveCliente},${dados.categoria},${dados.etapa},${dados.relato},${dados.utilidade},${dados.contatoAutorizado},${conteudoHash},i.versao,i.plataforma,${agora},${agora}
        FROM lume_instalacoes i WHERE i.token_hash=${tokenHash} AND i.revogado_em IS NULL
        AND (SELECT count(*) FROM lume_feedback f WHERE f.instalacao_id=i.id AND f.criado_em >= now()-interval '24 hours')<30
        ON CONFLICT(instalacao_id,chave_cliente) DO NOTHING RETURNING id,criado_em`;
      if(inseridos.length)return {id:inseridos[0].id,criadoEm:new Date(inseridos[0].criado_em).toISOString()};
      const existentes=await sql`SELECT f.id,f.criado_em,f.conteudo_hash,f.excluido_em FROM lume_feedback f JOIN lume_instalacoes i ON i.id=f.instalacao_id WHERE i.token_hash=${tokenHash} AND i.revogado_em IS NULL AND f.chave_cliente=${dados.chaveCliente}`;
      if(existentes.length){const item=existentes[0];return item.conteudo_hash===conteudoHash&&!item.excluido_em?{id:item.id,criadoEm:new Date(item.criado_em).toISOString()}:{conflito:true};}
      const instalacoes=await sql`SELECT id FROM lume_instalacoes WHERE token_hash=${tokenHash} AND revogado_em IS NULL`;
      return instalacoes.length?{limite:true}:null;
    },
    async listarFeedback({etapa,severidade,estado,versao,plataforma,cursor}){
      const em=cursor?.em??null,id=cursor?.id??null;
      const [itens,total,versoes]=await Promise.all([
        sql`SELECT f.id,f.instalacao_id,f.categoria,f.etapa,f.relato,f.utilidade,f.contato_autorizado,f.versao,f.plataforma,f.estado,f.severidade,f.criado_em,f.atualizado_em,i.rotulo
          FROM lume_feedback f JOIN lume_instalacoes i ON i.id=f.instalacao_id
          WHERE f.excluido_em IS NULL
          AND (${etapa}::text IS NULL OR f.etapa=${etapa}) AND (${severidade}::text IS NULL OR f.severidade=${severidade})
          AND (${estado}::text IS NULL OR f.estado=${estado}) AND (${versao}::text IS NULL OR f.versao=${versao})
          AND (${plataforma}::text IS NULL OR f.plataforma=${plataforma})
          AND (${em}::timestamptz IS NULL OR (f.criado_em,f.id)<(${em}::timestamptz,${id}::uuid))
          ORDER BY f.criado_em DESC,f.id DESC LIMIT ${TAMANHO_PAGINA_FEEDBACK+1}`,
        sql`SELECT count(*)::int AS total FROM lume_feedback f WHERE f.excluido_em IS NULL
          AND (${etapa}::text IS NULL OR f.etapa=${etapa}) AND (${severidade}::text IS NULL OR f.severidade=${severidade})
          AND (${estado}::text IS NULL OR f.estado=${estado}) AND (${versao}::text IS NULL OR f.versao=${versao})
          AND (${plataforma}::text IS NULL OR f.plataforma=${plataforma})`,
        sql`SELECT DISTINCT versao FROM lume_feedback WHERE excluido_em IS NULL ORDER BY versao DESC`
      ]);
      const rows=itens.slice(0,TAMANHO_PAGINA_FEEDBACK).map(item=>({id:item.id,instalacaoId:item.instalacao_id,rotulo:item.rotulo,categoria:item.categoria,etapa:item.etapa,relato:item.relato,utilidade:item.utilidade,contatoAutorizado:item.contato_autorizado===true,versao:item.versao,plataforma:item.plataforma,estado:item.estado,severidade:item.severidade,criadoEm:new Date(item.criado_em).toISOString(),atualizadoEm:new Date(item.atualizado_em).toISOString()}));
      return {itens:rows,total:total[0]?.total??0,tamanhoPagina:TAMANHO_PAGINA_FEEDBACK,versoes:versoes.map(item=>item.versao),proximoCursor:itens.length>TAMANHO_PAGINA_FEEDBACK?codificarCursorFeedback(rows.at(-1)):null};
    },
    async revisarFeedback(id,estado,severidade,agora){
      const itens=await sql`UPDATE lume_feedback SET estado=${estado},severidade=${severidade},atualizado_em=${agora} WHERE id=${id} AND excluido_em IS NULL RETURNING id,estado,severidade`;
      return itens[0]??null;
    },
    async excluirFeedback(id,agora){
      const itens=await sql`UPDATE lume_feedback SET relato='[excluído]',conteudo_hash=${'0'.repeat(64)},excluido_em=${agora},atualizado_em=${agora} WHERE id=${id} AND excluido_em IS NULL RETURNING id`;
      return Boolean(itens.length);
    },
    async listarInstalacoes(){
      const itens=await sql`SELECT id,rotulo,plataforma,arquitetura,canal,versao,estado_atualizacao,codigo_erro,whatsapp_estado,criado_em,ultimo_contato_em,ultimo_pulso_em,revogado_em FROM lume_instalacoes ORDER BY ultimo_contato_em DESC`;
      return itens.map(linha);
    },
    async revogarInstalacao(id,agora){
      const itens=await sql`UPDATE lume_instalacoes SET revogado_em=${agora} WHERE id=${id} AND revogado_em IS NULL RETURNING id`;
      return Boolean(itens.length);
    },
    async resumirRetencao(limite){
      const [convites,instalacoes,feedback]=await Promise.all([
        sql`SELECT count(*)::int AS total FROM lume_convites WHERE (usado_em IS NOT NULL OR revogado_em IS NOT NULL) AND COALESCE(revogado_em,usado_em)<${limite}`,
        sql`SELECT count(*)::int AS total FROM lume_instalacoes WHERE revogado_em IS NOT NULL AND revogado_em<${limite}`,
        sql`SELECT count(*)::int AS total FROM lume_feedback WHERE excluido_em IS NULL AND criado_em<${limite}`
      ]);
      return {convites:Number(convites[0]?.total||0),instalacoes:Number(instalacoes[0]?.total||0),feedback:Number(feedback[0]?.total||0)};
    },
    async aplicarRetencao(limite){
      const [feedback,convites,instalacoes]=await sql.transaction(tx=>[
        tx`UPDATE lume_feedback SET relato='[excluído]',conteudo_hash=${'0'.repeat(64)},excluido_em=now(),atualizado_em=now() WHERE excluido_em IS NULL AND criado_em<${limite} RETURNING id`,
        tx`DELETE FROM lume_convites WHERE (usado_em IS NOT NULL OR revogado_em IS NOT NULL) AND COALESCE(revogado_em,usado_em)<${limite} RETURNING id`,
        tx`DELETE FROM lume_instalacoes WHERE revogado_em IS NOT NULL AND revogado_em<${limite} RETURNING id`
      ]);
      return {convites:convites.length,instalacoes:instalacoes.length,feedback:feedback.length};
    }
  };
}
