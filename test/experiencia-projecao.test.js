import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {prepararEsquemaCrm} from '../src/crm.js';
import {OrganizacaoPessoal} from '../src/pessoal/organizacao.js';
import {ExperienciaLume} from '../src/experiencia-lume.js';

function fixture(t){
  const db=abrirBanco(':memory:');t.after(()=>db.close());prepararEsquemaCrm(db);new ContextoApp(db);
  const org=new OrganizacaoPessoal(db),produto=new Desktop(db),conversa='550000000001@s.whatsapp.net';
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(conversa,'Pessoa de teste');
  const texto='Preciso receber a revisão do catálogo da loja.';
  const evento=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada',?,0,'texto','{}',?,'2026-10-26T12:00:00.000Z','2026-10-26','dirigida')`).run(conversa,'teste-projecao',conversa,texto).lastInsertRowid);
  const acao=org.contexto.registrarDemanda({eventoId:evento,resumo:'Revisar catálogo',trecho:texto,tipo:'pendencia'}).acaoId;
  const pessoal={ativa:()=>true,politica:org.politica},service=new ExperienciaLume(db,{acoes:org.acoes,produto,organizacao:org,pessoal,conexao:{estado:()=>({estado:'conectada'})}});
  return {db,org,produto,service,conversa,evento,acao,pessoal};
}
test('projeção usa identidade/fonte/nomes existentes sem mutar cadastros nem inferir aceite',t=>{
  const f=fixture(t),before=f.db.prepare('SELECT total_changes() n').get().n;
  const view=f.service.listar(),item=view.itens[0];
  assert.equal(item.id,'acao:'+f.acao);assert.equal(item.fonte.eventoId,f.evento);assert.equal(item.pessoas[0].nome,'Pessoa de teste');
  assert.equal(item.grupo,'precisa');assert.equal(item.prazo,null);assert.equal(item.entrega.aceita,null);assert.equal(item.entrega.enviada,null);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(f.service.companheiro().id,item.id);
});
test('fonte alterada e exclusão retiram assunto sem cache de permissão',t=>{
  const f=fixture(t);assert.equal(f.service.listar().itens.length,1);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Outra mensagem totalmente diferente.',f.evento);
  assert.equal(f.service.listar().itens.length,0);assert.equal(f.service.companheiro(),null);
});
test('acompanhamento real preserva próxima verificação, serviço pausado não se diz trabalhando',t=>{
  const f=fixture(t);f.db.prepare('INSERT INTO desktop_config VALUES(?,?)').run('pessoal-acompanhamento:'+f.acao,JSON.stringify({proxima:'2026-10-27T14:00:00.000Z',anterior:'registro'}));
  assert.equal(f.service.listar().itens[0].grupo,'cuidando');
  f.pessoal.ativa=()=>false;const item=f.service.listar().itens[0];assert.equal(item.grupo,'precisa');assert.equal(item.acompanhamento.ativo,false);
  assert.equal(new ExperienciaLume(f.db,{acoes:f.org.acoes,produto:f.produto,pessoal:f.pessoal}).listar().itens[0].acompanhamento.proximaVerificacao,'2026-10-27T14:00:00.000Z');
});
test('resultado informado não equivale a verificado; resolvido não equivale a enviado/aceito',t=>{
  const f=fixture(t),action=f.org.acoes.obter(f.acao);
  const informed=f.service.projetar({...action,execucao_ui:{estado:'resultado_informado'}});
  assert.equal(informed.entrega.informada,true);assert.equal(informed.entrega.verificada,false);assert.equal(informed.grupo,'precisa');
  const checked=f.service.projetar({...action,execucao_ui:{estado:'verificado'}});assert.equal(checked.entrega.verificada,true);assert.equal(checked.entrega.aceita,null);
  const resolved=f.service.projetar({...action,estado:'resolvido'});assert.equal(resolved.grupo,'mudou');assert.equal(resolved.entrega.enviada,null);
});
test('filtros da memória combinam pessoa, assunto, período e tipo com paginação e visibilidade',t=>{
  const f=fixture(t);
  assert.equal(f.produto.buscar({pessoa:f.conversa,assunto:'catálogo',de:'2026-10-26',ate:'2026-10-26',tipo:'texto'}).mensagens[0].id,f.evento);
  const contact=f.produto.contatos({}).contatos[0];
  assert.equal(f.produto.buscar({pessoa:contact.id}).mensagens[0].id,f.evento);
  for(const filter of [{pessoa:'outra'},{de:'2026-10-27'},{ate:'2026-10-25'},{tipo:'audio'},{assunto:'inexistente'}])assert.equal(f.produto.buscar(filter).mensagens.length,0);
  assert.throws(()=>f.produto.buscar({de:'2026-02-30'}));assert.throws(()=>f.produto.buscar({de:'2026-10-28',ate:'2026-10-26'}));assert.throws(()=>f.service.listar({limite:1000}));
});
