import {prepararComandosWhatsapp, normalizarTag} from './comandos-whatsapp.js';
import {LEITURA_SQL} from './leitura-sql.js';
import {NEGOCIO_ATUAL_SQL, prepararNegocios} from './negocios-desktop.js';
import {criarResolvedorContatoPorIdentificador} from './contatos-desktop.js';

const ESTADOS = new Set(['feito', 'revisar', 'nao_reconhecido', 'nao_executado', 'origem_removida']);
const TIPOS = new Set(['tarefa', 'lembrete', 'cliente', 'tag', 'ajuda', 'desconhecido']);
const TIPOS_ENTIDADE = new Set(['mensagem', 'conversa', 'contato', 'tarefa', 'lembrete', 'negocio']);

const tipoSql = `CASE c.comando
  WHEN '#lume_tarefa' THEN 'tarefa'
  WHEN '#lume_lembrete' THEN 'lembrete'
  WHEN '#lume_cliente' THEN 'cliente'
  WHEN '#lume_tag' THEN 'tag'
  WHEN '#lume_ajuda' THEN 'ajuda'
  ELSE 'desconhecido' END`;

function inteiroPositivo(valor, nome, maximo = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(valor) || valor < 1 || valor > maximo) throw new Error(`${nome} invalido.`);
  return valor;
}

function tagCanonica(valor, {opcional = true} = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (opcional) return '';
    throw new Error('Tag invalida.');
  }
  if (typeof valor !== 'string') throw new Error('Tag invalida.');
  const tag = normalizarTag(valor);
  if (!tag.valida) throw new Error('Tag invalida.');
  return tag.chave;
}

const leituraComo = alias => LEITURA_SQL.replace(/\be\./gu, `${alias}.`);

function predicadoAlvo(entidadeTipo) {
  if (entidadeTipo === 'mensagem') return `EXISTS(SELECT 1 FROM eventos alvo
    WHERE alvo.conversa_id=te.conversa_id AND alvo.origem_id=te.entidade_id AND ${leituraComo('alvo')})`;
  if (entidadeTipo === 'conversa') return `EXISTS(SELECT 1 FROM eventos alvo
    WHERE alvo.conversa_id=te.entidade_id AND ${leituraComo('alvo')})`;
  if (entidadeTipo === 'contato') return `EXISTS(SELECT 1 FROM eventos alvo
    WHERE ((COALESCE(alvo.autor_e_dono,0)=0 AND alvo.autor_id=te.entidade_id)
      OR alvo.conversa_id=te.entidade_id) AND ${leituraComo('alvo')})`;
  if (entidadeTipo === 'tarefa') return `EXISTS(SELECT 1 FROM lume_comando_tarefas alvo
    WHERE alvo.comando_id=c.id AND CAST(alvo.id AS TEXT)=te.entidade_id)`;
  if (entidadeTipo === 'lembrete') return `EXISTS(SELECT 1 FROM lume_comando_lembretes alvo
    WHERE alvo.comando_id=c.id AND CAST(alvo.id AS TEXT)=te.entidade_id)`;
  return `EXISTS(SELECT 1 FROM desktop_negocios n JOIN desktop_fontes e ON e.id=n.evento_id
    WHERE n.id=te.entidade_id AND ${NEGOCIO_ATUAL_SQL})`;
}

const alvoPermitidoSql = `(
  (te.entidade_tipo='mensagem' AND ${predicadoAlvo('mensagem')}) OR
  (te.entidade_tipo='conversa' AND ${predicadoAlvo('conversa')}) OR
  (te.entidade_tipo='contato' AND ${predicadoAlvo('contato')}) OR
  (te.entidade_tipo='tarefa' AND ${predicadoAlvo('tarefa')}) OR
  (te.entidade_tipo='lembrete' AND ${predicadoAlvo('lembrete')}) OR
  (te.entidade_tipo='negocio' AND ${predicadoAlvo('negocio')})
)`;

function efeitoDaLinha(linha) {
  if (linha.tarefa_id != null) return {
    id: `comando:tarefa:${linha.tarefa_id}`,
    registroId: Number(linha.tarefa_id),
    tipo: 'tarefa',
    texto: linha.tarefa_texto,
    estado: linha.tarefa_estado
  };
  if (linha.lembrete_id != null) return {
    id: `comando:lembrete:${linha.lembrete_id}`,
    registroId: Number(linha.lembrete_id),
    tipo: 'lembrete',
    texto: linha.lembrete_texto,
    estado: linha.lembrete_estado,
    prazoLocal: linha.prazo_local,
    prazoUtc: linha.prazo_utc,
    fuso: linha.fuso
  };
  return null;
}

export class ComandosDesktop {
  constructor(db) {
    this.db = db;
    prepararComandosWhatsapp(db);
    prepararNegocios(db);
  }

  listar({estado = '', tipo = '', tag = '', cursor = Number.MAX_SAFE_INTEGER, limite = 50} = {}) {
    if (typeof estado !== 'string' || estado && !ESTADOS.has(estado)) throw new Error('Estado de comando invalido.');
    if (typeof tipo !== 'string' || tipo && !TIPOS.has(tipo)) throw new Error('Tipo de comando invalido.');
    cursor = inteiroPositivo(cursor, 'Cursor');
    limite = inteiroPositivo(limite, 'Limite', 100);
    const chaveTag = tagCanonica(tag);
    const filtros = [LEITURA_SQL];
    const argumentos = [];
    if (estado) { filtros.push('c.estado=?'); argumentos.push(estado); }
    if (tipo) { filtros.push(`${tipoSql}=?`); argumentos.push(tipo); }
    if (chaveTag) {
      filtros.push(`EXISTS(SELECT 1 FROM lume_tags_entidades te
        JOIN lume_tags lt ON lt.id=te.tag_id
        WHERE te.comando_id=c.id AND te.estado='ativa' AND lt.chave=? AND ${alvoPermitidoSql})`);
      argumentos.push(chaveTag);
    }
    const recorte = `FROM lume_comandos c
      JOIN eventos e ON e.id=c.evento_id AND e.conversa_id=c.conversa_id AND e.origem_id=c.origem_id
      WHERE ${filtros.join(' AND ')}`;
    const total = Number(this.db.prepare(`SELECT COUNT(*) total ${recorte}`).get(...argumentos).total);
    const linhas = this.db.prepare(`SELECT c.id,c.contrato,c.evento_id,c.conversa_id,c.origem_id,c.comando,c.estado,c.motivo,
        c.criado_em,c.atualizado_em,${tipoSql} tipo,
        t.id tarefa_id,t.texto tarefa_texto,t.estado tarefa_estado,
        l.id lembrete_id,l.texto lembrete_texto,l.estado lembrete_estado,l.prazo_local,l.prazo_utc,l.fuso,
        COALESCE((SELECT json_group_array(json_object('chave',lt.chave,'nome',lt.nome_exibido))
          FROM lume_tags_entidades te JOIN lume_tags lt ON lt.id=te.tag_id
          WHERE te.comando_id=c.id AND te.estado='ativa' AND ${alvoPermitidoSql}),'[]') tags_json
      FROM lume_comandos c
      JOIN eventos e ON e.id=c.evento_id AND e.conversa_id=c.conversa_id AND e.origem_id=c.origem_id
      LEFT JOIN lume_comando_tarefas t ON t.comando_id=c.id
      LEFT JOIN lume_comando_lembretes l ON l.comando_id=c.id
      WHERE ${filtros.join(' AND ')} AND c.id < ? ORDER BY c.id DESC LIMIT ?`).all(...argumentos, cursor, limite + 1);
    const comandos = linhas.slice(0, limite).map(linha => ({
      id: Number(linha.id),
      contrato: linha.contrato,
      eventoId: Number(linha.evento_id),
      conversaId: linha.conversa_id,
      origemId: linha.origem_id,
      comando: linha.comando,
      tipo: linha.tipo,
      estado: linha.estado,
      motivo: linha.motivo,
      criadoEm: linha.criado_em,
      atualizadoEm: linha.atualizado_em,
      tags: JSON.parse(linha.tags_json),
      efeito: efeitoDaLinha(linha)
    }));
    return {
      comandos,
      total,
      proximoCursor: linhas.length > limite ? comandos.at(-1).id : null
    };
  }

  listarTags({entidadeTipo, tag = '', cursor = Number.MAX_SAFE_INTEGER, limite = 50} = {}) {
    if (typeof entidadeTipo !== 'string' || !TIPOS_ENTIDADE.has(entidadeTipo)) throw new Error('Tipo de entidade invalido.');
    cursor = inteiroPositivo(cursor, 'Cursor');
    limite = inteiroPositivo(limite, 'Limite', 100);
    const chaveTag = tagCanonica(tag);
    const filtros = ["te.estado='ativa'", 'te.entidade_tipo=?', LEITURA_SQL, predicadoAlvo(entidadeTipo)];
    const argumentos = [entidadeTipo];
    if (chaveTag) { filtros.push('t.chave=?'); argumentos.push(chaveTag); }
    const recorte = `FROM lume_tags_entidades te
      JOIN lume_tags t ON t.id=te.tag_id
      JOIN lume_comandos c ON c.id=te.comando_id
      JOIN eventos e ON e.id=c.evento_id AND e.conversa_id=c.conversa_id AND e.origem_id=c.origem_id
      WHERE ${filtros.join(' AND ')}`;
    const selecao = `SELECT te.rowid cursor,t.id tag_id,t.chave,t.nome_exibido,
        te.entidade_tipo,te.entidade_id,te.procedencia,te.estado,
        c.evento_id,c.conversa_id,c.origem_id
      ${recorte}`;
    if(entidadeTipo==='contato'){
      const resolverContato=criarResolvedorContatoPorIdentificador(this.db);
      const permitidas=this.db.prepare(`${selecao} ORDER BY te.rowid DESC`).all(...argumentos).map(linha=>({
        linha,id:resolverContato(linha.entidade_id)
      })).filter(item=>item.id);
      const contagens=new Map();
      for(const {linha} of permitidas){const atual=contagens.get(linha.tag_id)||{chave:linha.chave,nome:linha.nome_exibido,total:0};atual.total++;contagens.set(linha.tag_id,atual);}
      const facetas=[...contagens.values()].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
      const pagina=permitidas.filter(item=>Number(item.linha.cursor)<cursor).slice(0,limite+1);
      const entidades=pagina.slice(0,limite).map(({linha,id})=>({
        tag:{id:Number(linha.tag_id),chave:linha.chave,nome:linha.nome_exibido},
        entidade:{tipo:linha.entidade_tipo,id},procedencia:linha.procedencia,estado:linha.estado,
        eventoId:Number(linha.evento_id),conversaId:linha.conversa_id,origemId:linha.origem_id
      }));
      return{entidades,facetas,total:permitidas.length,proximoCursor:pagina.length>limite?Number(pagina[limite-1].linha.cursor):null};
    }
    const total = Number(this.db.prepare(`SELECT COUNT(*) total ${recorte}`).get(...argumentos).total);
    const facetas = this.db.prepare(`SELECT t.chave,t.nome_exibido nome,COUNT(*) total ${recorte}
      GROUP BY t.id,t.chave,t.nome_exibido ORDER BY t.nome_exibido COLLATE NOCASE,t.id`).all(...argumentos)
      .map(item => ({...item, total: Number(item.total)}));
    const linhas = this.db.prepare(`${selecao} AND te.rowid<? ORDER BY te.rowid DESC LIMIT ?`).all(...argumentos, cursor, limite + 1);
    const entidades = linhas.slice(0, limite).map(linha => ({
      tag: {id: Number(linha.tag_id), chave: linha.chave, nome: linha.nome_exibido},
      entidade: {tipo: linha.entidade_tipo, id: linha.entidade_id},
      procedencia: linha.procedencia,
      estado: linha.estado,
      eventoId: Number(linha.evento_id),
      conversaId: linha.conversa_id,
      origemId: linha.origem_id
    }));
    return {
      entidades,
      facetas,
      total,
      proximoCursor: linhas.length > limite ? Number(linhas[limite - 1].cursor) : null
    };
  }

  listarEfeitos({tipo, tag = '', cursor = Number.MAX_SAFE_INTEGER, limite = 50} = {}) {
    if (!['tarefa', 'lembrete'].includes(tipo)) throw new Error('Tipo de efeito invalido.');
    cursor = inteiroPositivo(cursor, 'Cursor');
    limite = inteiroPositivo(limite, 'Limite', 100);
    const chaveTag = tagCanonica(tag);
    const tarefa = tipo === 'tarefa';
    const tabela = tarefa ? 'lume_comando_tarefas' : 'lume_comando_lembretes';
    const alias = tarefa ? 't' : 'l';
    const estados = tarefa ? "'aberta','revisar','origem_removida'" : "'agendado','revisar','origem_removida'";
    const filtros = [LEITURA_SQL, `${alias}.estado IN(${estados})`];
    const argumentos = [];
    if (chaveTag) {
      filtros.push(`EXISTS(SELECT 1 FROM lume_tags_entidades te
        JOIN lume_tags lt ON lt.id=te.tag_id
        WHERE te.comando_id=c.id AND te.estado='ativa' AND te.entidade_tipo=?
          AND te.entidade_id=CAST(${alias}.id AS TEXT) AND lt.chave=?)`);
      argumentos.push(tipo, chaveTag);
    }
    const recorte = `FROM ${tabela} ${alias}
      JOIN lume_comandos c ON c.id=${alias}.comando_id
      JOIN eventos e ON e.id=c.evento_id AND e.conversa_id=c.conversa_id AND e.origem_id=c.origem_id
      LEFT JOIN grupos_app g ON g.id=e.conversa_id
      LEFT JOIN conversas_app ca ON ca.id=e.conversa_id
      WHERE ${filtros.join(' AND ')}`;
    const total = Number(this.db.prepare(`SELECT COUNT(*) total ${recorte}`).get(...argumentos).total);
    const campos = tarefa
      ? `t.id registro_id,t.texto,t.estado,NULL prazo_local,NULL prazo_utc,NULL fuso`
      : `l.id registro_id,l.texto,l.estado,l.prazo_local,l.prazo_utc,l.fuso`;
    const linhas = this.db.prepare(`SELECT ${campos},c.id comando_id,c.evento_id,c.conversa_id,c.origem_id,c.criado_em,
        COALESCE(g.nome,ca.nome,e.conversa_id) conversa_nome
      ${recorte} AND ${alias}.id<? ORDER BY ${alias}.id DESC LIMIT ?`).all(...argumentos, cursor, limite + 1);
    const itens = linhas.slice(0, limite).map(linha => ({
      id: `comando:${tipo}:${linha.registro_id}`,
      registroId: Number(linha.registro_id),
      comandoId: Number(linha.comando_id),
      tipo,
      texto: linha.texto,
      estado: linha.estado,
      prazoLocal: linha.prazo_local,
      prazoUtc: linha.prazo_utc,
      fuso: linha.fuso,
      eventoId: Number(linha.evento_id),
      conversaId: linha.conversa_id,
      origemId: linha.origem_id,
      conversaNome: linha.conversa_nome,
      criadoEm: linha.criado_em
    }));
    return {
      itens,
      total,
      proximoCursor: linhas.length > limite ? Number(linhas[limite - 1].registro_id) : null
    };
  }

  resolverEfeito({tipo, id} = {}) {
    if (!['tarefa', 'lembrete'].includes(tipo)) throw new Error('Tipo de efeito invalido.');
    id = inteiroPositivo(id, 'Tarefa');
    const tarefa = tipo === 'tarefa';
    const tabela = tarefa ? 'lume_comando_tarefas' : 'lume_comando_lembretes';
    const estado = tarefa ? 'concluida' : 'concluido';
    const resultado = this.db.prepare(`UPDATE ${tabela} SET estado=?
      WHERE id=? AND EXISTS(
        SELECT 1 FROM lume_comandos c
        JOIN eventos e ON e.id=c.evento_id AND e.conversa_id=c.conversa_id AND e.origem_id=c.origem_id
        WHERE c.id=${tabela}.comando_id
          AND c.conversa_id=${tabela}.conversa_id AND c.origem_id=${tabela}.origem_id
          AND ${LEITURA_SQL}
      )`).run(estado, id);
    if (!resultado.changes) throw new Error('Tarefa indisponivel.');
    return {ok: true};
  }

  itensHoje({tag = ''} = {}) {
    const chaveTag = tagCanonica(tag);
    const filtroTag = chaveTag ? `AND EXISTS(SELECT 1 FROM lume_tags_entidades te
      JOIN lume_tags lt ON lt.id=te.tag_id
      WHERE te.comando_id=c.id AND te.estado='ativa' AND lt.chave=?
        AND ((te.entidade_tipo='tarefa' AND te.entidade_id=CAST(t.id AS TEXT))
          OR (te.entidade_tipo='lembrete' AND te.entidade_id=CAST(l.id AS TEXT))))` : '';
    const parametros = chaveTag ? [chaveTag] : [];
    const linhas = this.db.prepare(`SELECT c.id comando_id,c.evento_id,c.conversa_id,c.origem_id,c.criado_em,
        COALESCE(g.nome,ca.nome,e.conversa_id) conversa_nome,
        t.id tarefa_id,t.texto tarefa_texto,t.estado tarefa_estado,
        l.id lembrete_id,l.texto lembrete_texto,l.estado lembrete_estado,l.prazo_local,l.prazo_utc,l.fuso
      FROM lume_comandos c
      JOIN eventos e ON e.id=c.evento_id AND e.conversa_id=c.conversa_id AND e.origem_id=c.origem_id
      LEFT JOIN lume_comando_tarefas t ON t.comando_id=c.id AND t.estado IN('aberta','revisar','origem_removida')
      LEFT JOIN lume_comando_lembretes l ON l.comando_id=c.id AND l.estado IN('agendado','revisar','origem_removida')
      LEFT JOIN grupos_app g ON g.id=e.conversa_id
      LEFT JOIN conversas_app ca ON ca.id=e.conversa_id
      WHERE ${LEITURA_SQL} AND (t.id IS NOT NULL OR l.id IS NOT NULL) ${filtroTag}
      ORDER BY c.id`).all(...parametros);
    return linhas.map(linha => linha.tarefa_id != null ? {
      id: `comando:tarefa:${linha.tarefa_id}`,
      registro_id: Number(linha.tarefa_id),
      comando_id: Number(linha.comando_id),
      resumo: linha.tarefa_texto,
      tipo: 'pendencia',
      quando: null,
      extraido_em: linha.criado_em,
      conversa_id: linha.conversa_id,
      origem_id: linha.origem_id,
      evento_id: Number(linha.evento_id),
      conversa_nome: linha.conversa_nome,
      responsavel: null,
      estado: linha.tarefa_estado,
      origem_tipo: 'comando'
    } : {
      id: `comando:lembrete:${linha.lembrete_id}`,
      registro_id: Number(linha.lembrete_id),
      comando_id: Number(linha.comando_id),
      resumo: linha.lembrete_texto,
      tipo: 'compromisso',
      quando: linha.prazo_utc,
      extraido_em: linha.criado_em,
      conversa_id: linha.conversa_id,
      origem_id: linha.origem_id,
      evento_id: Number(linha.evento_id),
      conversa_nome: linha.conversa_nome,
      responsavel: null,
      estado: linha.lembrete_estado,
      prazo_local: linha.prazo_local,
      prazo_utc: linha.prazo_utc,
      fuso: linha.fuso,
      origem_tipo: 'comando'
    });
  }
}
