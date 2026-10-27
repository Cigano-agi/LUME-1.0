import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {AcoesLume} from '../src/acoes-lume.js';
import {Privacidade} from '../src/privacidade.js';
import {Politica} from '../src/autorizacao.js';

const GROUP='grupo-audit-sintetico@g.us';
const OWNER='dono-audit@s.whatsapp.net';

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'lume-audit-grupo-'));
  const db=abrirBanco(join(dir,'dados.sqlite'));
  const app=new ContextoApp(db,{donoId:OWNER});
  new Desktop(db);
  const acoes=new AcoesLume(db);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  return {db,app,acoes};
}

const msg=(id,text,{mention=false}={})=>({
  key:{remoteJid:GROUP,id,fromMe:false,participant:`autor-${id}@s.whatsapp.net`},
  messageTimestamp:1791200000,
  message:mention?{extendedTextMessage:{text,contextInfo:{mentionedJid:[OWNER]}}}:{conversation:text}
});

test('captura local de grupo preserva fontes sem ampliar exportação, grant ou envio',t=>{
  const {db,app,acoes}=setup(t);
  const lote=[msg('dirigida','Fonte dirigida sintética.',{mention:true}),msg('terceiro','Fonte de terceiro sintética.')];
  const recebido=app.receber({messages:lote,type:'notify'});
  assert.equal(recebido.novas,2);

  const fontes=db.prepare('SELECT id,origem_id,permissao FROM eventos WHERE conversa_id=? ORDER BY origem_id').all(GROUP);
  assert.equal(fontes.length,2,'captura guarda fontes do grupo, mesmo sem cadastro anterior');
  assert.deepEqual(fontes.map(f=>f.permissao),['dirigida','terceiro']);

  const exportado=new Privacidade(db).exportar({conversa:GROUP,confirmar:true}).conteudo;
  assert.deepEqual(exportado.eventos.map(e=>e.origem_id),['dirigida'],
    'exportação pessoal padrão inclui somente fontes dirigidas/permitidas');
  assert.ok(!JSON.stringify(exportado).includes('Fonte de terceiro sintética.'));

  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_acoes_conversas').get().n,0,
    'captura não cria autorização para executor/MCP');
  assert.equal(acoes.conversas().find(c=>c.id===GROUP).autorizada,0);

  const politica=new Politica(db);
  assert.equal(politica.podeLer(GROUP),false,
    'captura não cria autorização de leitura/atendimento na política de respostas');
  assert.equal(politica.podeEnviar(GROUP).permitido,false);
});
