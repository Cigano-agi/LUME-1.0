// Prova local opcional com checkpoint verificado. Não avalia qualidade nem libera sugestões.
import {resolve} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {AcoesLume} from '../src/acoes-lume.js';
import {FilaLaya} from '../src/laya/fila.js';
import {criarLayaLocal} from '../src/laya/index.js';

const modelDir=resolve(process.argv[2]||'work/laya-onnx');
const db=abrirBanco(),laya=criarLayaLocal({modelDir,loadTimeoutMs:120000,timeoutMs:30000,idleMs:120000});
try{
  new ContextoApp(db);
  db.prepare('INSERT INTO conversas_app(id,nome) VALUES(?,?)').run('smoke@local','Conversa sintética');
  db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('smoke@local','smoke-historico','entrada','texto','{}','Pode revisar o documento antigo?','2026-09-25T11:00:00Z','2026-09-25','minha')`).run();
  const acoes=new AcoesLume(db);acoes.autorizar({conversa:'smoke@local',permitida:true});
  db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('smoke@local','smoke-1','entrada','texto','{}','Pode confirmar a data da reunião?','2026-09-25T12:00:00Z','2026-09-25','minha')`).run();
  const fila=new FilaLaya(db,{laya});
  const inicio=performance.now();await fila.passo();
  const estado=fila.estado();
  if(estado.abstidas!==1||estado.total!==1||db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n!==0)throw new Error('Fila local não se absteve como esperado.');
  const duracaoFriaMs=Math.round(performance.now()-inicio);
  const manual=fila.organizarConversa({conversa:'smoke@local',limite:50});
  const limite=Date.now()+30000;
  while(fila.estado().abstidas<2&&Date.now()<limite)await new Promise(resolve=>setTimeout(resolve,30));
  if(manual.selecionadas!==2||fila.estado().abstidas!==2||db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n!==0)throw new Error('Organizar agora não concluiu com abstenção local.');
  console.log(JSON.stringify({ok:true,local:true,modelo:laya.status().modelo,estado:'abstido',manualSelecionadas:manual.selecionadas,acoesCriadas:0,duracaoFriaMs}));
}finally{await laya.close();db.close();}
