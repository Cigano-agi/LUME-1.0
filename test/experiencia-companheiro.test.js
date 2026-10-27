import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {prepararPessoal} from '../src/pessoal/esquema.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';
import {pessoalPost} from '../src/pessoal/http.js';

const id='acao:11111111-1111-4111-8111-111111111111';
function fixture(t){const db=abrirBanco(':memory:');prepararPessoal(db);t.after(()=>db.close());const states=[];
 const service=new CompanheiroPessoal(db,{pessoal:{ativa:()=>true,validarAviso:()=>false},conexao:{estado:()=>({estado:'conectada'})},publicar:s=>states.push(s)});
 service.experiencia={companheiro:()=>({id,assunto:'Catálogo sintético',pessoa:'Pessoa de teste',motivo:'Confira a fonte.',fonteId:1,grupo:'precisa',estado:'sugerido',atualizadoEm:'2026-10-26T12:00:00.000Z',prazo:null})};return{db,service,states};}
test('companhia projeta assunto existente e pausa/som/volume/tema persistem sem alterar atendimento',async t=>{
 const f=fixture(t);await pessoalPost({companheiro:f.service},'/api/v3/pessoal/companheiro',{enabled:true,som:false,volume:.2,tema:'dark',movimento:'reduce'});
 assert.equal(f.states.at(-1).assunto.id,id);assert.equal(f.states.at(-1).estado,'atencao');assert.equal(f.states.at(-1).som,false);
 f.service.configurar({pausado:true,som:true});assert.equal(f.states.at(-1).estado,'pausado');assert.equal(f.states.at(-1).assunto,null);assert.equal(f.states.at(-1).som,false);assert.equal(f.service.pessoal.ativa(),true);
 const restored=new CompanheiroPessoal(f.db).estado();assert.equal(restored.pausado,true);assert.equal(restored.tema,'dark');assert.equal(restored.volume,.2);
});
test('adiar remove assunto só até prazo e campos extras não abrem capacidades',async t=>{
 const f=fixture(t);f.service.configurar({enabled:true,adiadoId:id,adiadoAte:new Date(Date.now()+60000).toISOString()});assert.equal(f.states.at(-1).assunto,null);
 f.service.configurar({adiadoAte:'2000-01-01T00:00:00.000Z'});assert.equal(f.states.at(-1).assunto.id,id);
 for(const patch of [{volume:-1},{volume:1.1},{tema:'url'},{movimento:true},{pausado:'true'},{adiadoId:'https://evil.invalid'},{}])assert.throws(()=>f.service.configurar(patch));
 await assert.rejects(()=>pessoalPost({companheiro:f.service},'/api/v3/pessoal/companheiro',{enviar:true}));
});
test('aparência persiste sem janela nativa, mas ativação e pausa continuam indisponíveis',t=>{
 const f=fixture(t);f.service.disponivel=false;
 const result=f.service.configurar({tema:'dark',movimento:'reduce',som:false,volume:.2});
 assert.equal(result.tema,'dark');assert.equal(result.disponivel,false);assert.equal(result.enabled,false);
 for(const patch of [{enabled:true},{pausado:true},{adiadoId:id},{tema:'light',enabled:false}])assert.throws(()=>f.service.configurar(patch));
 assert.equal(f.service.estado().tema,'dark');
});
