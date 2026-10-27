import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarCofre } from '../desktop/segredos.cjs';
import { verify } from 'node:crypto';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopCompartilhamento } from '../src/desktop-compartilhamento.js';
import { verificarPacote } from '../src/compartilhamento.js';
import { prepararEsquemaTranscricao, gravarTranscricao } from '../src/transcricao.js';

for (const audio of [false, true]) test(`cofre integrado: exportar F10 atual e importar em outro perfil (${audio ? 'áudio' : 'texto'})`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lume-f10-integracao-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Somente a proteção do SO é simulada; identidade, assinatura e F10 são reais.
  const cifras = new Map();
  const safe = { isEncryptionAvailable: () => true,
    encryptString: s => { const id = `cifra-${cifras.size}`; cifras.set(id, s); return Buffer.from(id); },
    decryptString: b => cifras.get(b.toString()) };
  const cofre = criarCofre(dir, safe);
  const origem = abrirBanco(), destino = abrirBanco();
  t.after(() => { origem.close(); destino.close(); });
  new ContextoApp(origem); new ContextoApp(destino);
  new Desktop(origem); const recebido = new Desktop(destino);
  origem.prepare('INSERT INTO conversas_app VALUES(?,?)').run('grupo', 'Equipe sintética');
  origem.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('grupo','1','entrada',?,'{}',?,'2026-09-18T12:00:00.000Z','2026-09-18','minha')")
    .run(audio ? 'audio' : 'texto', audio ? null : 'Revisar orçamento amanhã.');
  if (audio) { prepararEsquemaTranscricao(origem); gravarTranscricao(origem, { conversaId: 'grupo', origemId: '1', textoOriginal: 'Transcrição: Revisar orçamento amanhã.' }); }
  const ui = new DesktopCompartilhamento(origem, { perfil: () => ({ nome: 'Origem' }), identidade: async (op, v) => criarCofre(dir, safe).executar(op, v) });
  const outra = new DesktopCompartilhamento(destino);
  const projeto = ui.f.criarProjeto({ nome: 'Beta', conversas: ['grupo'] }).id;
  const alvo = outra.f.criarProjeto({ nome: 'Recebidos' }).id;
  const identidade = await ui.criarIdentidade();
  const previa = ui.prepararExportacao({ projeto, destinatario: 'Sócio' });
  assert.equal(previa.conteudo.versao, 'assessor-f10-v2');
  const { pacote } = await ui.exportar({ id: previa.id, confirmar: true });
  verificarPacote(pacote);
  const importar = () => { const p = outra.prepararImportacao({ arquivo: pacote }); return outra.importar({ id: p.id, projeto: alvo, fingerprintConfirmada: identidade.fingerprint, confirmar: true }); };
  assert.equal(importar().novos, 1);
  assert.equal(importar().repetido, true);
  const fonte = recebido.buscar({ q: 'orçamento' }).mensagens[0];
  assert.equal(fonte.permissao, 'compartilhado');
  if (audio) {
    assert.equal(recebido.fonte(fonte.id).transcricao.textoOriginal, 'Transcrição: Revisar orçamento amanhã.');
    assert.equal(destino.prepare('SELECT texto FROM eventos').get().texto, null);
  }
  const adulterado = structuredClone(pacote); adulterado.conteudo.destinatario = 'Outra pessoa';
  assert.throws(() => outra.prepararImportacao({ arquivo: adulterado }), /Assinatura/);
  assert.equal(cofre.executar('f10-estado').fingerprint, identidade.fingerprint);
});

test('cofre: assinatura aceita só versões conhecidas e mantém limite de bytes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lume-f10-versoes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = criarCofre(dir, { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() });
  c.executar('f10-criar');
  for (const versao of ['assessor-f10-v1', 'assessor-f10-v2']) {
    const texto = JSON.stringify({ versao }); const s = c.executar('f10-assinar', texto);
    assert.equal(verify(null, Buffer.from(texto), s.chave_publica, Buffer.from(s.assinatura, 'base64')), true);
  }
  for (const v of [undefined, null, {}, '', '{}', 'null', '{', '{"versao":"assessor-f10-v3"}', JSON.stringify({ versao: 'assessor-f10-v2', extra: 'x'.repeat(8 * 1024 * 1024) })])
    assert.throws(() => c.executar('f10-assinar', v));
});

test('cofre: recusa persistir sem proteção e não aceita operações/caminhos arbitrários',t=>{
  const dir=mkdtempSync(join(tmpdir(),'assessor-cofre-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const cofre=criarCofre(dir,{isEncryptionAvailable:()=>false});
  assert.deepEqual(cofre.estado(),{disponivel:false,configurada:false});
  assert.throws(()=>cofre.executar('gravar','chave_sintetica_123456789'),/indisponível/);
});

test('identidade Ed25519: privada cifrada, fingerprint estável e assinatura real, sem retornar privada',t=>{
 const dir=mkdtempSync(join(tmpdir(),'assessor-f10-cofre-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const map=new Map();let id=0;
 const safe={isEncryptionAvailable:()=>true,encryptString:s=>{const v='CIFRA-'+ ++id;map.set(v,s);return Buffer.from(v);},decryptString:b=>map.get(b.toString())};
 const c=criarCofre(dir,safe);assert.equal(c.executar('f10-estado').criada,false);
 assert.throws(()=>c.executar('f10-assinar','{}'),/primeiro/);
 const identity=c.executar('f10-criar'),again=criarCofre(dir,safe).executar('f10-estado');assert.equal(identity.fingerprint,again.fingerprint);
 assert.equal(readFileSync(join(dir,'compartilhamento.seguro'),'utf8'),'CIFRA-1');assert.ok(!JSON.stringify(identity).includes('PRIVATE'));
 const content=JSON.stringify({versao:'assessor-f10-v1'}),sig=c.executar('f10-assinar',content);assert.equal(verify(null,Buffer.from(content),sig.chave_publica,Buffer.from(sig.assinatura,'base64')),true);
 c.executar('remover');assert.equal(c.executar('f10-estado').fingerprint,identity.fingerprint);
 assert.throws(()=>c.executar('f10-assinar','{}'),/inválido/);
});
test('cofre: só armazena retorno cifrado; troca e remoção são verificáveis (cifrador simulado)',t=>{
  const dir=mkdtempSync(join(tmpdir(),'assessor-cofre-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const map=new Map();let index=0;
  const safe={isEncryptionAvailable:()=>true,encryptString:s=>{const id='CIFRA-'+ ++index;map.set(id,s);return Buffer.from(id);},decryptString:b=>map.get(b.toString())};
  const cofre=criarCofre(dir,safe),key='chave_sintetica_123456789';
  cofre.executar('gravar',key);assert.equal(readFileSync(join(dir,'gemini.seguro'),'utf8'),'CIFRA-1');assert.equal(cofre.executar('ler'),key);
  cofre.executar('gravar',key+'2');assert.equal(cofre.executar('ler'),key+'2');assert.throws(()=>cofre.executar('../segredo'),/inválida/);
  cofre.executar('remover');assert.equal(cofre.estado().configurada,false);assert.throws(()=>cofre.executar('ler'),/Configure/);
});

test('Telegram: token fica cifrado fora do banco e pode ser revogado',t=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-telegram-cofre-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const token='123456789:'+'A'.repeat(40);
  const safe={isEncryptionAvailable:()=>true,encryptString:()=>Buffer.from('CIFRADO'),decryptString:()=>token};
  const cofre=criarCofre(dir,safe);
  assert.deepEqual(cofre.executar('telegram-estado'),{disponivel:true,configurada:false});
  assert.throws(()=>cofre.executar('telegram-gravar','invalido'),/inválido/);
  cofre.executar('telegram-gravar',token);
  assert.equal(readFileSync(join(dir,'telegram.seguro'),'utf8'),'CIFRADO');
  assert.equal(cofre.executar('telegram-ler'),token);
  cofre.executar('telegram-remover');
  assert.equal(cofre.executar('telegram-estado').configurada,false);
});
