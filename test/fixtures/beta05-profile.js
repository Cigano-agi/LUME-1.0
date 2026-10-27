// DEMONSTRAÇÃO SINTÉTICA. Nunca carregar no perfil de uso real.
import {ContextoApp} from '../../src/contexto-app.js';
import {Desktop, VERSAO_TERMOS} from '../../src/desktop.js';
import {NegociosDesktop} from '../../src/negocios-desktop.js';
import {diaLocal} from '../../src/relogio.js';

export function perfilBeta05(db, {agora = new Date('2026-09-23T15:00:00.000Z'), vazio = false} = {}) {
  const contexto = new ContextoApp(db), desktop = new Desktop(db);
  const negocios = new NegociosDesktop(db, {agora: () => agora});
  desktop.aceitar({nome: 'Eduardo · demonstração', aceito: true, versao: VERSAO_TERMOS});
  let contador = 0;
  function mensagem({conversa = 'demo-ana', nome = 'Ana Ribeiro · demonstração',
    texto = 'Podemos revisar os documentos antes da próxima conversa?', permissao = 'dirigida',
    data = agora.toISOString(), tipo = 'texto'} = {}) {
    db.prepare('INSERT OR IGNORE INTO conversas_app VALUES(?,?)').run(conversa, nome);
    const origem = 'demo-beta05-' + (++contador);
    const id = Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
      VALUES(?,?,'entrada',?,'{}',?,?,?,?)`).run(conversa, origem, tipo, texto, data, diaLocal(new Date(data)), permissao).lastInsertRowid);
    return {id, conversa, origem};
  }
  function tarefa(fonte, {titulo = 'Conferir documentos recebidos', tipo = 'pendencia', quando = null, estado = 'aberto'} = {}) {
    return Number(db.prepare(`INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,quando,extraido_em,estado)
      VALUES(?,?,?,?,?,?,?)`).run(fonte.conversa, fonte.origem, tipo, titulo, quando, agora.toISOString(), estado).lastInsertRowid);
  }
  function negocio(fonte, {titulo = 'Consultoria contratual · demonstração', etapa = 'proposta', valor_centavos = 350000, proximo_contato = null} = {}) {
    return negocios.salvar({previa: negocios.preparar({fonte: fonte.id}).id, confirmar: true, titulo, etapa, valor_centavos, proximo_contato});
  }
  const fontes = {};
  if (!vazio) {
    fontes.ana = mensagem({texto: 'Doutor Eduardo, envio os documentos da empresa. Nossa reunião de revisão ficou para 24/09 às 10h.'});
    tarefa(fontes.ana, {titulo: 'Preparar a reunião de revisão com Ana', tipo: 'compromisso', quando: '2026-09-24T10:00:00-03:00'});
    fontes.marcos = mensagem({conversa: 'demo-marcos', nome: 'Marcos Almeida · demonstração', texto: 'Recebi sua proposta de consultoria contratual de R$ 3.500. Quero conversar sobre o escopo antes de decidir.'});
    negocio(fontes.marcos, {proximo_contato: diaLocal(agora)});
    tarefa(fontes.marcos, {titulo: 'Conferir dúvidas de Marcos sobre o escopo'});
    fontes.clara = mensagem({conversa: 'demo-clara', nome: 'Clara Martins · demonstração', texto: 'Gostaria de conhecer sua assessoria mensal. Podemos começar por uma reunião para entender a demanda?'});
    negocio(fontes.clara, {titulo: 'Assessoria mensal · demonstração', etapa: 'interesse', valor_centavos: null});
    tarefa(fontes.clara, {titulo: 'Preparar perguntas para a conversa com Clara'});
    fontes.estudo = mensagem({conversa: 'demo-estudo', nome: 'Estudo e método · demonstração', texto: 'Revisão de prática: separar documentos recebidos, pontos ainda não confirmados e perguntas para a próxima reunião.'});
  }
  return {contexto, desktop, negocios, mensagem, tarefa, negocio, fontes, agora};
}
