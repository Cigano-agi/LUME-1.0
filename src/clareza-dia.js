import {LEITURA_PESSOAL_SQL} from './leitura-sql.js';
import {NEGOCIO_ATUAL_PESSOAL_SQL, ETAPAS_NEGOCIO} from './negocios-desktop.js';
import {HASH_FONTE_SQL, SUGESTAO_ATUAL_SQL} from './tarefas-esquema.js';
import {diaLocal} from './relogio.js';
import {resumoAcoesLume} from './acoes-lume.js';
import {criarNomeVisivel} from './nomes-conversa.js';

const NOMES = 'LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id';
const NOME = 'COALESCE(g.nome,c.nome,e.conversa_id)';
const NEGOCIOS = `FROM desktop_negocios n CROSS JOIN desktop_fontes e ON e.id=n.evento_id
  ${NOMES} WHERE ${NEGOCIO_ATUAL_PESSOAL_SQL} AND n.etapa NOT IN ('fechado','encerrado')`;

/** Read-only projection. Construction requires the already initialized Desktop service. */
export class ClarezaDia {
  constructor(db, {desktop, agora = () => new Date()} = {}) {
    if (!desktop?.resumo || !desktop?.fonte) throw new TypeError('ClarezaDia precisa do serviço Desktop inicializado.');
    this.db = db; this.desktop = desktop; this.agora = agora;
    // This projection is created after the context/permission schema. Desktop
    // itself also supports legacy profiles whose permission migration is pending.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_desktop_metricas_acl ON eventos
      (conversa_id,permissao,tipo,origem_compartilhamento,dia_local,recebido_em,autor_id,autor_e_dono)`);
  }

  resumo() {
    const agora = this.agora(), dia = diaLocal(agora), db = this.db;
    const nomeVisivel = criarNomeVisivel(db);
    const base = this.desktop.resumo({ordem: 'compromissos', pagina: 1, somenteAcoes: true});
    const acoes06 = resumoAcoesLume(db,{agora});
    // Reuse the application's permission, command-state and stale-suggestion gates.
    const prioridadesAnteriores = base.tarefas.slice(0, 3).map(t => ({
      id: t.id, tipo: t.tipo, titulo: t.resumo, quando: t.quando || null,
      conversaNome: nomeVisivel(t.conversa_nome, t.conversa_id), conversaId: t.conversa_id,
      fonteId: t.evento_id, motivo: t.prioridade,
    }));
    const prioridades = [...acoes06.itens.map(a=>({id:a.id,tipo:a.tipo,titulo:a.resumo,quando:a.lembrar_em,
      conversaNome:nomeVisivel(a.conversa_nome,a.conversa_id),conversaId:a.conversa_id,fonteId:a.evento_id,origem:'acoes06',estado:a.estado,motivo:null})),
      ...prioridadesAnteriores].slice(0,3);
    // One metadata-only scan, with the same live permission/ancestry predicate.
    // No result cache: revocation is visible on the next statement.
    const grupos = db.prepare(`SELECT e.conversa_id,COUNT(*) mensagens,
      COALESCE(SUM(e.dia_local=?),0) mensagensHoje,MAX(e.recebido_em) ultimaMensagemEm
      FROM eventos e INDEXED BY idx_desktop_metricas_acl WHERE ${LEITURA_PESSOAL_SQL}
      GROUP BY e.conversa_id
      ORDER BY ultimaMensagemEm DESC,e.conversa_id`).all(dia);
    const metricas = {mensagens: 0, conversas: grupos.length, mensagensHoje: 0,
      ultimaMensagemEm: grupos[0]?.ultimaMensagemEm ?? null};
    for (const grupo of grupos) { metricas.mensagens += grupo.mensagens; metricas.mensagensHoje += grupo.mensagensHoje; }
    const timestamp = Date.parse(metricas.ultimaMensagemEm);
    const idadeHoras = Number.isFinite(timestamp) ? Math.max(0, Math.floor((agora.getTime() - timestamp) / 3600000)) : null;
    const estado = !metricas.mensagens ? 'sem-dados' : idadeHoras !== null && idadeHoras < 48 ? 'recente' : 'antiga';
    const cobertura = {...metricas, idadeHoras, estado, aviso: !metricas.mensagens
      ? 'Seu resumo aparece quando houver mensagens permitidas. Você também pode começar por uma anotação.'
      : 'Este retrato usa apenas mensagens permitidas e registros salvos. A data é da mensagem, não da última sincronização.'};

    const totais = db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(n.valor_centavos),0) valorCentavos,
      COALESCE(SUM(n.valor_centavos IS NULL),0) semValor ${NEGOCIOS}`).get();
    const negocios = db.prepare(`SELECT n.id,n.titulo,n.etapa,n.valor_centavos valorCentavos,
      n.proximo_contato proximoContato,n.evento_id fonteId,e.conversa_id conversaId,${NOME} conversaNome
      ${NEGOCIOS} ORDER BY n.proximo_contato IS NULL,n.proximo_contato,n.atualizado_em DESC,n.id LIMIT 3`).all()
      .map(n => ({...n, conversaNome:nomeVisivel(n.conversaNome,n.conversaId), etapaNome: ETAPAS_NEGOCIO[n.etapa]}));
    // A changed source may require review, but its old title/value must never leak.
    const totalRevisoes = db.prepare(`SELECT COUNT(*) total FROM desktop_negocios n
      CROSS JOIN desktop_fontes e ON e.id=n.evento_id WHERE ${LEITURA_PESSOAL_SQL} AND n.assinatura<>${HASH_FONTE_SQL}`).get().total;
    const oportunidades = {...totais, totalRevisoes, itens: negocios,
      aviso: 'Valores registrados em negócios abertos. Não representam honorários recebidos nem receita garantida.'};

    // Only four source lookups; repeat the shared ACL rather than trusting a cached ID.
    const ultimaFonte = db.prepare(`SELECT e.conversa_id id,${NOME} nome,e.recebido_em ultimaMensagemEm,
      e.id fonteId,e.texto,e.tipo FROM eventos e ${NOMES}
      WHERE e.conversa_id=? AND ${LEITURA_PESSOAL_SQL} ORDER BY e.recebido_em DESC,e.id DESC LIMIT 1`);
    const conversas = grupos.slice(0, 4).map(grupo => ({...ultimaFonte.get(grupo.conversa_id), mensagens: grupo.mensagens}))
      .map(({texto,tipo,...c}) => ({...c, nome:nomeVisivel(c.nome,c.id), trecho: texto ? texto.slice(0, 180) : tipo === 'audio' ? 'Mensagem de áudio — abra a fonte para conferir.' : 'Mensagem sem texto — abra a fonte para conferir.'}));
    const revisao = db.prepare(`SELECT COUNT(*) total FROM desktop_tarefas_sugestoes s
      JOIN eventos e ON e.id=s.evento_id WHERE s.estado='pendente' AND ${LEITURA_PESSOAL_SQL} AND ${SUGESTAO_ATUAL_SQL}`).get();
    const primeira = prioridades[0], negocio = negocios[0], conversa = conversas[0];
    const foco = primeira ? {titulo: primeira.titulo, descricao: `${primeira.origem==='acoes06'?'Ação para conferir':'Ação registrada'} · ${primeira.conversaNome}`,
      acao: 'abrir-fonte', fonteId: primeira.fonteId, conversaId: primeira.conversaId}
      : negocio ? {titulo: negocio.titulo, descricao: 'Confira o próximo passo deste negócio na mensagem de origem.',
        acao: 'abrir-fonte', fonteId: negocio.fonteId, conversaId: negocio.conversaId}
      : conversa ? {titulo: 'Retome uma conversa com contexto', descricao: conversa.nome,
        acao: 'abrir-fonte', fonteId: conversa.fonteId, conversaId: conversa.id}
      : {titulo: 'Seu próximo passo começa aqui', descricao: 'Conecte suas conversas ou registre uma anotação para organizar o dia.',
        acao: 'abrir-conversas', fonteId: null, conversaId: null};
    const pratica = {titulo: 'Afie o machado',
      pergunta: foco.fonteId ? 'O que está confirmado nesta conversa e qual informação falta para escolher o próximo passo?'
        : 'Qual assunto merece sua atenção hoje? Registre o contexto e um próximo passo que dependa de você.',
      apoio: 'Reserve dois minutos para reler, distinguir fatos de suposições e anotar o que aprendeu.',
      fonteId: foco.fonteId, conversaId: foco.conversaId};
    return {versao: '0.5', geradoEm: agora.toISOString(), dia,
      perfil: {nome: this.desktop.perfil().nome}, cobertura, foco,
      prioridades: {total: base.fila.total+acoes06.total, itens: prioridades}, oportunidades,
      conversas: {total: metricas.conversas, itens: conversas}, revisao, pratica};
  }
}
