import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {prepararEsquemaFinanceiro} from '../src/financeiro.js';
import {NegociosDesktop,NEGOCIOS_BACKUP} from '../src/negocios-desktop.js';
import {Privacidade} from '../src/privacidade.js';
import {Backup} from '../src/backup.js';
import {Compartilhamento,assinarPacote,fingerprint} from '../src/compartilhamento.js';

function env(t){const db=abrirBanco();t.after(()=>db.close());const e={db,...perfilGrafo(db)};new DesktopIA(db);e.n=new NegociosDesktop(db,{agora:()=>new Date('2026-09-18T02:00:00Z')});e.p=new Privacidade(db);e.b=new Backup(db);e.conversa('a','Conversa teste');e.f=e.evento('a','p');e.save=(changes={},fonte=e.f)=>e.n.salvar({previa:e.n.preparar({fonte}).id,confirmar:true,titulo:'Site da Ana',etapa:'interesse',...changes});return e;}
const count=(e,t)=>e.db.prepare(`SELECT count(*) n FROM ${t}`).get().n;

test('negócios: só confirmação escreve, revisão registra histórico e não confirma pagamento',t=>{
 const e=env(t),p=e.n.preparar({fonte:e.f});prepararEsquemaFinanceiro(e.db);assert.equal(count(e,'desktop_negocios'),0);assert.equal(p.negocio,null);
 assert.throws(()=>e.n.salvar({previa:p.id,titulo:'Teste',etapa:'interesse'}),/confirme/);e.save();
 e.save({etapa:'proposta',valor_centavos:250000,proximo_contato:'2026-09-20'});let n=e.n.listar().negocios[0];assert.equal(n.revisao,2);assert.equal(n.valor_centavos,250000);assert.equal(e.n.preparar({fonte:e.f}).historico.length,2);
 assert.throws(()=>e.save({etapa:'fechado',proximo_contato:'2026-09-21'}),/Retire/);e.save({etapa:'fechado'});assert.equal(e.n.listar({contatos:true}).pagina.total,0);assert.equal(count(e,'eventos_financeiros'),0);
});
test('negócios: leitura controla prévia, lista, valor e escrita após revogação',t=>{
 const e=env(t);e.save({titulo:'PRIVADO',valor_centavos:990000});const p=e.n.preparar({fonte:e.f});
 e.db.prepare("UPDATE eventos SET permissao='compartilhado' WHERE id=?").run(e.f);
 assert.equal(e.n.listar().pagina.total,0);assert.ok(!JSON.stringify(e.n.listar()).includes('PRIVADO'));assert.throws(()=>e.n.preparar({fonte:e.f}),/indisponível/);
 assert.throws(()=>e.n.salvar({previa:p.id,confirmar:true,titulo:'Alterar',etapa:'proposta'}),/indisponível/);
 assert.equal(e.p.exportar({confirmar:true}).conteudo.derivados.desktop_negocios.length,0);
 assert.equal(e.p.exportar({confirmar:true,incluirOcultas:true}).conteudo.derivados.desktop_negocios.length,1);
});
test('negócio de grupo é local e não amplia exportação sem concessão',t=>{
 const e=env(t);
 e.conversa('grupo@g.us','Grupo de teste');const fonte=e.evento('grupo@g.us','p');
 e.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(fonte);
 e.save({titulo:'NEGOCIO_GRUPO',valor_centavos:45000},fonte);
 assert.equal(e.n.listar().pagina.total,1);
 assert.equal(e.p.exportar({confirmar:true}).conteudo.derivados.desktop_negocios.length,0);
 assert.equal(e.p.exportar({confirmar:true,incluirOcultas:true}).conteudo.derivados.desktop_negocios.length,1);
});
test('negócios: fonte alterada oculta dados antigos, exige recomeço explícito e limpa histórico',t=>{
 const e=env(t);e.save({titulo:'VALOR_ANTIGO',valor_centavos:90000});const old=e.n.preparar({fonte:e.f});
 e.db.prepare("UPDATE eventos SET texto='Proposta cancelada' WHERE id=?").run(e.f);
 assert.equal(e.n.listar().negocios.length,0);assert.deepEqual(e.n.listar().revisoes.map(r=>r.evento_id),[e.f]);
 assert.equal(e.p.exportar({confirmar:true}).conteudo.derivados.desktop_negocios.length,0);
 assert.throws(()=>e.n.salvar({previa:old.id,confirmar:true,titulo:'Old',etapa:'fechado'}),/mudou/);
 const fresh=e.n.preparar({fonte:e.f});assert.equal(fresh.revisar,true);assert.ok(!JSON.stringify(fresh).includes('VALOR_ANTIGO'));
 assert.throws(()=>e.n.salvar({previa:fresh.id,confirmar:true,titulo:'Cancelado',etapa:'encerrado'}),/recomeço/);
 e.n.salvar({previa:fresh.id,confirmar:true,revisar:true,titulo:'Cancelado',etapa:'encerrado'});
 assert.equal(e.n.listar().negocios[0].valor_centavos,null);assert.equal(count(e,'desktop_negocios_historico'),1);assert.equal(e.n.preparar({fonte:e.f}).historico[0].revisao,2);
});
test('negócios: duas revisões concorrentes não sobrescrevem decisão e prévia expira',t=>{
 const e=env(t),p=e.n.preparar({fonte:e.f}),other=e.n.preparar({fonte:e.f});
 const fields={confirmar:true,titulo:'Decisão nova',etapa:'proposta'};e.n.salvar({previa:p.id,...fields});assert.throws(()=>e.n.salvar({previa:other.id,...fields,titulo:'Perdida'}),/mudou/);
 assert.throws(()=>e.n.salvar({previa:p.id,...fields}),/expirada/);const exp=e.n.preparar({fonte:e.f});e.n.agora=()=>new Date('2026-09-18T03:00:00Z');assert.throws(()=>e.n.salvar({previa:exp.id,...fields}),/expirada/);
 assert.equal(e.n.listar().negocios[0].titulo,'Decisão nova');assert.equal(count(e,'desktop_negocios_historico'),1);
});
test('negócios: valida dinheiro, datas reais, etapas e parâmetros antes da escrita',t=>{
 const e=env(t);for(const v of [{titulo:''},{titulo:'x'.repeat(161)},{titulo:'A\nB'},{etapa:'pago'},{etapa:'__proto__'},{valor_centavos:-1},{valor_centavos:1.3},{valor_centavos:Infinity},{valor_centavos:'30'},{proximo_contato:'2026-02-30'},{proximo_contato:'2026-9-1'},{proximo_contato:'1999-12-31'}])assert.throws(()=>e.save(v),JSON.stringify(v));
 for(const f of [{pagina:0},{pagina:NaN},{conversa:3},{etapa:'toString'},{contatos:'yes'}])assert.throws(()=>e.n.listar(f));
 assert.equal(count(e,'desktop_negocios'),0);e.save({valor_centavos:0,proximo_contato:'2028-02-29'});assert.equal(e.n.listar().negocios[0].valor_centavos,0);
});
test('negócios: páginas sem repetição, filtros e datas respeitam dia de São Paulo',t=>{
 const e=env(t);for(let i=0;i<15;i++)e.save({titulo:'N'+i,etapa:i%2?'proposta':'interesse',proximo_contato:i<12?'2026-09-'+String(10+i).padStart(2,'0'):null},i===0?e.f:e.evento('a','p'));
 const ids=[];for(let pagina=1;pagina<=3;pagina++)ids.push(...e.n.listar({pagina}).negocios.map(n=>n.id));assert.equal(new Set(ids).size,15);assert.equal(ids.length,15);
 assert.equal(e.n.listar({contatos:true}).pagina.total,12);assert.equal(e.n.listar({etapa:'proposta'}).pagina.total,7);assert.equal(e.n.listar({pagina:999}).pagina.numero,3);assert.equal(e.n.listar().hoje,'2026-09-17');
 assert.equal(e.n.listar({conversa:'ausente'}).pagina.total,0);
 e.db.exec("UPDATE eventos SET texto='Fonte alterada'");const revisoes=[];
 for(let paginaRevisoes=1;paginaRevisoes<=3;paginaRevisoes++){const p=e.n.listar({paginaRevisoes});assert.equal(p.pagina.total,0);assert.equal(p.paginaRevisoes.total,15);revisoes.push(...p.revisoes.map(r=>r.evento_id));}
 assert.equal(new Set(revisoes).size,15);assert.equal(revisoes.length,15);assert.equal(e.n.listar({paginaRevisoes:999}).paginaRevisoes.numero,3);assert.throws(()=>e.n.listar({paginaRevisoes:0}));
});
test('negócios: exclusão por fonte/conversa/acervo apaga histórico e prévia detecta edição',t=>{
 for(const filtro of ['fonte','conversa','tudo']){
  const e=env(t);e.save();let p=e.p.preparar(filtro==='fonte'?{fonte:e.f}:filtro==='conversa'?{conversa:'a'}:{tudo:true});assert.equal(p.contagens.desktop_negocios,1);assert.equal(p.contagens.desktop_negocios_historico,1);
  e.save({titulo:'Nome mudou'});assert.throws(()=>e.p.excluir({id:p.id,confirmar:'APAGAR'}),/mudaram/);
  p=e.p.preparar(filtro==='fonte'?{fonte:e.f}:filtro==='conversa'?{conversa:'a'}:{tudo:true});const r=e.p.excluir({id:p.id,confirmar:'APAGAR'});assert.equal(r.contagens.desktop_negocios_historico,2);
  for(const table of NEGOCIOS_BACKUP)assert.equal(count(e,table),0);assert.throws(()=>e.n.preparar({fonte:e.f}),/indisponível/);
 }
});
test('negócios: exportação legível inclui histórico permitido e recorte exato',t=>{
 const e=env(t);e.save();e.save({etapa:'proposta',valor_centavos:120000});e.conversa('b');e.save({titulo:'Outro'},e.evento('b','p'));
 const d=e.p.exportar({confirmar:true,conversa:'a'}).conteudo.derivados;assert.equal(d.desktop_negocios.length,1);assert.equal(d.desktop_negocios_historico.length,2);assert.equal(d.desktop_negocios_historico[0].valor_centavos,null);assert.equal(d.desktop_negocios_historico[1].valor_centavos,120000);
});
test('negócios: backup v6 cifrado restaura decisões e não restaura permissão ampliada',async t=>{
 const e=env(t),dest=env(t);dest.db.exec('DELETE FROM eventos;DELETE FROM conversas_app');e.save({etapa:'proposta',valor_centavos:89999,proximo_contato:'2026-09-22'});e.save({etapa:'conversa',valor_centavos:89999,proximo_contato:'2026-09-23'});
 const senha='Senha longa sintética',out=await e.b.criar({senha,confirmar:true});assert.ok(!JSON.stringify(out).includes('Site da Ana'));
 const p=await dest.b.preparar({arquivo:JSON.stringify(out.pacote),senha});dest.b.restaurar({id:p.id,confirmarMeuBackup:true});assert.equal(dest.n.listar().negocios[0].proximo_contato,'2026-09-23');assert.equal(dest.n.preparar({fonte:e.f}).historico.length,2);
 assert.equal(dest.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('negócios: migra conjuntos fechados v1/v2/v3, recusa v5 parcial e histórico adulterado',t=>{
 const e=env(t);e.save();const base=e.b.capturar();assert.equal(base.versao,'assessor-acervo-v7');
 for(const v of [1,2,3]){const c=structuredClone(base);c.versao='assessor-acervo-v'+v;for(const table of [...NEGOCIOS_BACKUP,'lume_comandos','lume_tags','lume_tags_entidades','lume_comando_tarefas','lume_comando_lembretes','whatsapp_labels','whatsapp_label_associacoes','whatsapp_label_observacoes','lume_acoes','lume_acoes_historico'])delete c.tabelas[table];if(v===1)for(const table of Object.keys(c.tabelas))if(table.startsWith('desktop_tarefas_'))delete c.tabelas[table];e.b.validar(c);assert.equal(c.versao,'assessor-acervo-v7');assert.deepEqual(c.tabelas.desktop_negocios,[]);}
 const parcialV5=structuredClone(base);parcialV5.versao='assessor-acervo-v5';for(const table of ['whatsapp_labels','whatsapp_label_associacoes','whatsapp_label_observacoes'])delete parcialV5.tabelas[table];delete parcialV5.tabelas.desktop_negocios_historico;assert.throws(()=>e.b.validar(parcialV5));
 for(const mutate of [c=>delete c.tabelas.desktop_negocios_historico,c=>c.tabelas.desktop_negocios_historico=[],c=>c.tabelas.desktop_negocios_historico[0].valor_centavos=42,c=>c.tabelas.desktop_negocios[0].evento_id=999,c=>c.tabelas.desktop_negocios_historico.push({...c.tabelas.desktop_negocios_historico[0]})]){const c=structuredClone(base);mutate(c);assert.throws(()=>e.b.validar(c));}
});
test('negócios: fonte F10 permite acompanhamento local, remoção da origem alcança histórico',t=>{
 const a=env(t),b=env(t);a.db.exec("UPDATE eventos SET autor_e_dono=1,recebido_em='2026-09-17T12:00:00.000Z'");a.save();const af=new Compartilhamento(a.db),bf=new Compartilhamento(b.db,{privacidade:b.p}),ap=af.criarProjeto({nome:'A',conversas:['a']}).id,bp=bf.criarProjeto({nome:'B'}).id,key=generateKeyPairSync('ed25519');
 const pacote=af.prepararExportacao({projeto:ap,pessoa:'A',maquina:'PC',destinatario:'B'});assert.ok(!JSON.stringify(pacote).includes('Site da Ana'));
 b.db.exec('DELETE FROM eventos');bf.importar(assinarPacote(pacote,key.privateKey),{projeto:bp,fingerprintConfirmada:fingerprint(key.publicKey)});
 const e=b.db.prepare("SELECT id FROM eventos WHERE permissao='compartilhado'").get();b.save({titulo:'Meu acompanhamento'},e.id);assert.equal(b.n.listar().pagina.total,1);
 const p=bf.prepararRemocao({fingerprint:fingerprint(key.publicKey)});assert.equal(p.contagens.desktop_negocios,1);bf.removerOrigem({id:p.id,fingerprint:fingerprint(key.publicKey),confirmar:'REMOVER'});assert.equal(b.n.listar().pagina.total,0);assert.equal(count(b,'desktop_negocios_historico'),0);
});
