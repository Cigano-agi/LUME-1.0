import test from 'node:test';
import assert from 'node:assert/strict';
import { prepararVista, renderizarVista, escaparHtml } from '../src/painel/notetaker-view.js';

const trecho = { id: 't1', inicio: '00:12:48', fim: '00:13:07', texto: 'Enviar proposta.', coberto: true };
const base = { estado: 'revisavel', titulo: 'Conversa de teste', fonte: { disponivel: true, persistida: true }, trechos: [trecho], transcricaoConfirmada:true, organizacaoAprovada: false };

test('copy exige prova de track ativo para dizer Gravando', () => {
  assert.equal(prepararVista({ estado: 'gravando', entradas: [{ nome: 'Microfone', ativo: false }] }).estado, 'interrompido');
  assert.match(renderizarVista({ estado: 'gravando', entradas: [{ nome: 'Microfone', ativo: false }] }), /Sessão interrompida/);
  assert.match(renderizarVista({ estado: 'gravando', entradas: [{ nome: 'Microfone', ativo: true }] }), /Gravando/);
});

test('fonte ausente impede criar ação comprovada e reprodução', () => {
  const html = renderizarVista({ ...base, fonte: { disponivel: false, persistida: false } });
  assert.match(html, /Áudio indisponível/);
  assert.doesNotMatch(html, /data-action="criar-acao"/);
  assert.doesNotMatch(html, /data-action="ouvir"/);
});

test('silêncio salvo é cobertura, lacuna não é', () => {
  const html = renderizarVista({ ...base, trechos: [
    { ...trecho, tipo: 'silencio', texto: '' },
    { id: 't2', inicio: '00:13:07', fim: '00:13:20', tipo: 'lacuna', coberto: false }
  ] });
  assert.match(html, /Tempo coberto, sem fala identificada/);
  assert.match(html, /Trecho não salvo/);
  assert.equal((html.match(/data-action="criar-acao"/g) || []).length, 0);
});

test('organização automática não aprovada aparece indisponível', () => {
  assert.match(renderizarVista(base), /organização automática indisponível/);
  assert.doesNotMatch(renderizarVista(base), /Sem próximos passos encontrados/);
  assert.match(renderizarVista({...base,proximosPassos:[{tipo:'money',titulo:'Exemplo'}],analiseConcluida:true}),/organização automática indisponível/);
});

test('cores semânticas trazem rótulos e fonte ausente é explícita', () => {
  const tipos=['pendency','project','person','link','deal','money'];
  const html=renderizarVista({...base,organizacaoAprovada:true,analiseConcluida:true,proximosPassos:tipos.map(tipo=>({tipo,titulo:'Item de teste'}))});
  for(const rotulo of ['Pendência','Projeto','Pessoa','Link','Venda','Dinheiro']) assert.match(html,new RegExp(rotulo));
  assert.match(html,/Fonte não informada/);
});

test('salvo até exige confirmação persistida', () => {
  assert.doesNotMatch(renderizarVista({estado:'gravando',entradas:[{ativo:true}],salvoAte:'10h18',cobertura:'18 min cobertos'}),/Salvo até|18 min cobertos/);
  assert.match(renderizarVista({estado:'gravando',entradas:[{ativo:true}],salvoAte:'10h18',salvamentoConfirmado:true}),/Salvo até/);
});

test('início exige entrada disponível selecionada e consentimento da sessão', () => {
  const dto={estado:'vazio',opcoesEntrada:[{id:'mic',nome:'Microfone',disponivel:true,selecionada:true}]};
  assert.doesNotMatch(renderizarVista(dto),/data-action="iniciar"/);
  assert.match(renderizarVista({...dto,consentimento:true}),/data-action="iniciar"/);
});

test('escapa texto e atributos fornecidos pelo DTO', () => {
  const html = renderizarVista({ ...base, titulo: '<img src=x onerror=alert(1)>', trechos: [{ ...trecho, id: '" onclick="x', texto: '<script>oi</script>' }] });
  assert.doesNotMatch(html, /<img|<script>|onclick="x/);
  assert.match(html, /&lt;script&gt;oi&lt;\/script&gt;/);
  assert.equal(escaparHtml('"&<>'), '&quot;&amp;&lt;&gt;');
});

test('estados de recuperação mostram causa e próximo gesto', () => {
  for (const estado of ['vazio', 'importando', 'pausado', 'interrompido', 'processando', 'modelo-ausente', 'erro']) {
    const html = renderizarVista({ estado, causa: 'Falha local', salvoAte: '10h18' });
    assert.ok(html.includes('nt-state'), estado);
    assert.ok(html.includes('Falha local') || estado === 'vazio', estado);
  }
  assert.match(renderizarVista({ estado: 'modelo-ausente' }), /Modelo local indisponível/);
});
