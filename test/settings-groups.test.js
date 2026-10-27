import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('Ajustes tem três escolhas, dezessete cartões estáveis e atalhos diretos',()=>{
  const html=readFileSync('src/painel/app.html','utf8');
  const app=readFileSync('src/painel/app.js','utf8');
  const sources=['dados.js','compartilhamento.js','tarefas.js','acoes.js','ia.js','lembretes.js','atualizacoes.js','central.js','novidades.js','mcp.js'].map(file=>readFileSync('src/painel/'+file,'utf8')).join('\n');
  assert.equal((html.match(/class="settings-choice"/g)||[]).length,3);
  for(const [id,label] of [['connections','Conexões'],['work','Como o Lume trabalha'],['data','Dados e aplicativo']]){
    assert.match(html,new RegExp(`id="settings-choice-${id}"[\\s\\S]*?>[\\s\\S]*?<b>${label}</b>`));
    assert.match(html,new RegExp(`id="settings-group-${id}"[\\s\\S]*?data-settings-group-panel="${id}"`));
    assert.match(html,new RegExp(`id="settings-group-${id}-cards"`));
  }
  const catalog=app.match(/const ajustesCatalogo=Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1]||'';
  assert.equal((catalog.match(/grupo:/g)||[]).length,17);
  for(const id of ['settings-whatsapp','mcp-panel','telegram-hoje-panel','central-panel','settings-reading','settings-ai','settings-semantic','settings-actions','settings-tasks','lembretes-panel','settings-note','settings-guide','dados-panel','f10-panel','atualizacoes-panel','novidades-panel','settings-about'])assert.match(catalog,new RegExp(`'${id}'`));
  assert.doesNotMatch(sources,/\$\('settings'\)[^\n]*\.(?:after|append|insertBefore)\(/);
  assert.match(app,/window\.abrirAjuste=async id/);
  assert.match(app,/window\.abrirAjuste\('settings-whatsapp'\)/);
  assert.match(readFileSync('src/painel/primeiros-passos.js','utf8'),/guide-claude[\s\S]*abrirAjuste\('mcp-panel'\)/);
});
