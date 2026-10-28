// Synthetic reproduction of candidate starvation seen in the private cohort.
// No real messages, database copies, accounts or network are used here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {OrganizadorConversas} from '../src/pessoal/organizador.js';

function fixture(t){
 const db=abrirBanco(),context=new ContextoApp(db),group='550000007777@g.us';let seq=0;
 new Desktop(db).aceitar({nome:'Synthetic retrieval review',aceito:true,versao:VERSAO_TERMOS});
 const org=new OrganizadorConversas(db,{agora:()=>new Date('2026-10-28T12:00:00Z'),chatgpt:{estado:async()=>{throw Error('No model call authorized in this test');}}});
 org.configurarEscopo({escopo:'todas',confirmar:true});
 t.after(async()=>{await org.encerrar();db.close();});
 const add=(text,date)=>context._registrarEvento({conversaId:group,origemId:'synthetic-'+(++seq),autorId:'550000007778@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:new Date(date)},'dirigida').id;
 const project=(id,text,nome)=>org.projetos.criarRascunho({nome,natureza:'incerto',fontes:[{eventoId:id,trecho:text}]}).id;
 return {db,org,add,project};
}

test('retrieval: older backfill IDs cannot crowd the latest eligible project out of the source budget',t=>{
 const f=fixture(t),baseText='Projeto Aurora: preparar o catalogo de pecas.',base=f.add(baseText,'2026-10-26T12:00:00Z'),wanted=f.project(base,baseText,'Aurora');
 for(let n=0;n<3;n++){const text='Projeto antigo '+n+': preparar outro trabalho independente.';f.project(f.add(text,'2026-10-25T0'+n+':00:00Z'),text,'Antigo '+n);}
 for(let n=0;n<8;n++)f.add('Conversa incidental sintetica '+n+'.','2026-10-27T0'+n+':00:00Z');
 const target=f.add('Revisar o mesmo catalogo de pecas combinado.','2026-10-28T11:00:00Z'),packet=f.org.contextual.montar(f.org.fonte(target,{remoto:true}));
 assert.ok(packet.candidatos.some(p=>p.id===wanted),'the most recent valid project must remain a candidate despite lower ingestion ID');
 assert.ok(packet.fontes.has(base),'the candidate retains its literal source');
 assert.ok(packet.fontes.size<=12);assert.ok([...packet.fontes.values()].reduce((n,e)=>n+e.texto.length,0)<=16000);
 assert.ok(packet.prova.fontes.length<=64);
});

test('retrieval: future projects cannot exhaust the bounded candidate query before eligible history',t=>{
 const f=fixture(t),text='Projeto Aurora: preparar o catalogo.',base=f.add(text,'2026-10-26T12:00:00Z'),wanted=f.project(base,text,'Aurora');
 const target=f.add('Revisar o catalogo combinado.','2026-10-27T12:00:00Z');
 for(let n=0;n<25;n++){const future='Projeto futuro '+n+': tarefa ainda nao discutida.';f.project(f.add(future,'2026-10-28T12:00:00Z'),future,'Futuro '+n);}
 const packet=f.org.contextual.montar(f.org.fonte(target,{remoto:true}));
 assert.deepEqual(packet.candidatos.map(p=>p.id),[wanted],'candidate query must apply the temporal boundary before LIMIT');
 assert.equal(packet.input.contexto.some(e=>e.data>'2026-10-27T12:00:00.000Z'),false);
});
