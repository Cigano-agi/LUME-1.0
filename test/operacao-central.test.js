import test from 'node:test';
import assert from 'node:assert/strict';
import { CentralOperacional, compararVersoes, estadoDaInstalacao, hashSegredo, validarPulso, validarRegistro } from '../src/operacao-central.js';
import { criarSessaoAdmin, senhaAdminValida, sessaoAdminValida } from '../api/_central/admin.js';

const PEPPER='pepper-de-teste-com-tamanho-suficiente-123';
const AGORA=new Date('2026-09-18T18:00:00.000Z');
const base={instalacaoId:'b84c33d7-35c6-4a89-bf3f-7f9dc7c8b133',versao:'3.0.0-alpha.8',canal:'beta',plataforma:'win32',arquitetura:'x64'};
const pulseBase={versao:base.versao,canal:base.canal,plataforma:base.plataforma,arquitetura:base.arquitetura};

function repositorio(){
  const convites=new Map(),instalacoes=new Map();
  return {
    convites,instalacoes,
    async criarConvite(item){convites.set(item.codigoHash,{...item});},
    async revogarConvite(id,agora){const item=[...convites.values()].find(i=>i.id===id&&!i.usadoEm&&!i.revogadoEm);if(!item)return false;item.revogadoEm=agora;return true;},
    async consumirConvite({conviteHash,instalacaoId,tokenHash,dados,agora}){
      const convite=convites.get(conviteHash);if(!convite||convite.revogadoEm||(convite.usadoEm&&convite.usadoPor!==instalacaoId))return null;
      convite.usadoEm=agora;convite.usadoPor=instalacaoId;
      const anterior=instalacoes.get(instalacaoId);if(anterior?.revogadoEm)return null;
      const item={id:instalacaoId,rotulo:convite.rotulo,tokenHash,plataforma:dados.plataforma,arquitetura:dados.arquitetura,canal:dados.canal,versao:dados.versao,estadoAtualizacao:'em_dia',codigoErro:null,whatsappEstado:'nao_informado',criadoEm:anterior?.criadoEm||agora,ultimoContatoEm:agora,ultimoPulsoEm:anterior?.ultimoPulsoEm||null,revogadoEm:null};instalacoes.set(item.id,item);return item;
    },
    async registrarPulso({tokenHash,dados,agora}){const item=[...instalacoes.values()].find(i=>i.tokenHash===tokenHash&&!i.revogadoEm);if(!item)return null;Object.assign(item,dados,{ultimoContatoEm:agora,ultimoPulsoEm:agora});return item;},
    async listarInstalacoes(){return [...instalacoes.values()].map(({tokenHash,...item})=>({...item}));},
    async revogarInstalacao(id,agora){const item=instalacoes.get(id);if(!item||item.revogadoEm)return false;item.revogadoEm=agora;return true;}
  };
}

test('contrato operacional aceita somente metadados enumerados',()=>{
  assert.deepEqual(validarRegistro({convite:'LUME-ABCDEFGHIJKL',...base}),{convite:'LUME-ABCDEFGHIJKL',...base});
  assert.equal(validarPulso({...pulseBase,estadoAtualizacao:'em_dia'}).whatsappEstado,'nao_informado');
  for(const extra of [
    {mensagem:'conteudo privado'},
    {jid:'5511@s.whatsapp.net'},
    {stack:'caminho privado'}
  ])assert.throws(()=>validarPulso({...pulseBase,estadoAtualizacao:'em_dia',...extra}),/CAMPOS_INVALIDOS|CONTEUDO/);
  assert.throws(()=>validarPulso({...pulseBase,estadoAtualizacao:'inventado'}),/ESTADO_ATUALIZACAO_INVALIDO/);
  assert.throws(()=>validarPulso({...pulseBase,estadoAtualizacao:'erro',codigoErro:'TEXTO_ARBITRARIO'}),/CODIGO_ERRO_INVALIDO/);
  assert.throws(()=>validarRegistro({convite:'LUME-ABCDEFGHIJKL',...base,plataforma:'linux'}),/PLATAFORMA_INVALIDA/);
});

test('convite registra uma instalação, pulso atualiza e revogação não toca dados locais',async()=>{
  const repo=repositorio(),central=new CentralOperacional({repositorio:repo,pepper:PEPPER,agora:()=>AGORA,versaoAtual:'3.0.0-alpha.9'});
  const convite=await central.criarConvite('Diogo Kaleo');
  const registro=await central.registrar({convite:convite.codigo,...base});assert.equal(registro.instalacaoId,base.instalacaoId);assert.ok(registro.token.length>30);
  assert.equal((await central.listar())[0].estado,'apenas_feedback');
  await central.pulso(registro.token,{versao:'3.0.0-alpha.8',canal:'beta',plataforma:'win32',arquitetura:'x64',estadoAtualizacao:'disponivel',whatsappEstado:'pareando'});
  const lista=await central.listar();assert.equal(lista.length,1);assert.equal(lista[0].rotulo,'Diogo Kaleo');assert.equal(lista[0].estado,'desatualizado');assert.equal('tokenHash' in lista[0],false);
  await assert.rejects(central.registrar({convite:convite.codigo,...base,instalacaoId:'35ebef5e-ad64-43c2-84f7-a7727013a8fc'}),/CONVITE_INVALIDO_OU_USADO/);
  await central.revogar(base.instalacaoId);await assert.rejects(central.pulso(registro.token,{...pulseBase,estadoAtualizacao:'em_dia'}),/TOKEN_INVALIDO/);
});

test('convite ainda não usado pode ser revogado pelo identificador',async()=>{
  const repo=repositorio(),central=new CentralOperacional({repositorio:repo,pepper:PEPPER,agora:()=>AGORA,versaoAtual:'3.1.0-beta.1'});
  const convite=await central.criarConvite('Tester');
  assert.deepEqual(await central.revogarConvite(convite.id),{revogado:true});
  await assert.rejects(central.registrar({convite:convite.codigo,...base}),/CONVITE_INVALIDO_OU_USADO/);
  await assert.rejects(central.revogarConvite(convite.id),/CONVITE_NAO_ENCONTRADO/);
});

test('classificação usa versão semântica e horário do servidor',()=>{
  assert.ok(compararVersoes('3.0.0-alpha.10','3.0.0-alpha.8')>0);assert.ok(compararVersoes('3.0.0','3.0.0-alpha.99')>0);
  assert.equal(estadoDaInstalacao({ultimoContatoEm:'2026-09-18T17:00:00Z',ultimoPulsoEm:null,versao:'3.0.0-alpha.8',estadoAtualizacao:'em_dia'},{agora:AGORA,versaoAtual:'3.0.0-alpha.8'}),'apenas_feedback');
  assert.equal(estadoDaInstalacao({revogadoEm:'2026-09-18T18:00:00Z',ultimoPulsoEm:null,versao:'3.0.0-alpha.8',estadoAtualizacao:'em_dia'},{agora:AGORA,versaoAtual:'3.0.0-alpha.8'}),'revogada');
  assert.equal(estadoDaInstalacao({ultimoPulsoEm:'2026-09-16T00:00:00Z',versao:'3.0.0-alpha.8',estadoAtualizacao:'em_dia'},{agora:AGORA,versaoAtual:'3.0.0-alpha.8'}),'sem_contato');
  assert.equal(estadoDaInstalacao({ultimoPulsoEm:'2026-09-18T17:00:00Z',versao:'3.0.0-alpha.8',estadoAtualizacao:'erro'},{agora:AGORA,versaoAtual:'3.0.0-alpha.8'}),'erro_atualizacao');
});

test('sessão administrativa é curta, assinada e comparada em tempo constante',()=>{
  const segredo='senha-administrativa-de-teste-123456';const token=criarSessaoAdmin(segredo,AGORA.getTime());
  assert.equal(sessaoAdminValida(`x=1; lume_admin=${token}`,segredo,AGORA.getTime()+1000),true);
  assert.equal(sessaoAdminValida(`lume_admin=${token}x`,segredo,AGORA.getTime()+1000),false);
  assert.equal(sessaoAdminValida(`lume_admin=${token}`,segredo,AGORA.getTime()+9*60*60*1000),false);
  assert.equal(senhaAdminValida(segredo,segredo),true);assert.equal(senhaAdminValida('errada',segredo),false);
  assert.notEqual(hashSegredo('convite',PEPPER),'convite');
});
