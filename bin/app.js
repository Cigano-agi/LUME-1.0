#!/usr/bin/env node
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync,existsSync } from 'node:fs';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import {reconciliarCicloFontes} from '../src/ciclo-captura.js';
import { Conexao } from '../src/transporte/socket.js';
import { HistoricoWhatsApp } from '../src/transporte/historico.js';
import { ColetorCaixas } from '../src/caixas.js';
import { criarServidor } from '../src/painel/servidor.js';
import { batimento, deveBater } from '../src/saude.js';

import { carregarEnv } from '../src/ambiente.js';

// O .env traz GEMINI_API_KEY, PUNK_RECORDS e ASSESSOR_DONO, escritos pelo
// instalador. Sem carregar aqui, a caixa do socio roda com o ambiente vazio.
carregarEnv();

const raiz=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dados=resolve(process.env.ASSESSOR_DATA_DIR||resolve(raiz,'data'));
const porta=Number(process.env.ASSESSOR_PORT||8787);
const FOLGA_BOOT_MS=3*60_000;
if(!Number.isInteger(porta)||porta<1||porta>65535) throw new Error('ASSESSOR_PORT inválida');
mkdirSync(dados,{recursive:true});
const db=abrirBanco(resolve(dados,'assessor.db'));
const contexto=new ContextoApp(db);
const historico=new HistoricoWhatsApp(db);
const authDir=resolve(dados,'wa-auth');
let conexao;
let backfillFeito=false;
const coletor=new ColetorCaixas(db,{
  conexao: { baixarMidia: (msg, formato, opcoes) => conexao.baixarMidia(msg, formato, opcoes) }
});
conexao=new Conexao({
  authDir,
  historico,
  aoDiagnostico: info => console.error(`[transporte] ${new Date().toISOString()} ${JSON.stringify(info)}`),
  aoLote: async lote => {
    await contexto.receber(lote);
    await coletor.processarLote(lote).catch(err => console.error('Erro no coletor de caixas:', err?.message));
  },
  aoAtualizarMensagens: updates => contexto.atualizarMensagens(updates),
  aoRemoverMensagens: evento => contexto.removerMensagens(evento),
  aoGrupos: async grupos => {
    await contexto.salvarGrupos(grupos);
    const resolucao=await coletor.atualizarGrupos(grupos);
    // Anexos que chegaram enquanto o coletor nao existia (ou com o processo parado) ja
    // estao em `eventos` com mediaKey preservada. Uma varredura por boot os recupera.
    if(resolucao?.resolvido && !backfillFeito){
      backfillFeito=true;
      coletor.backfillDoBanco({limite:1000})
        .then(r=>console.log('Backfill 2026:',JSON.stringify(r)))
        .catch(err=>console.error('Backfill 2026 falhou:',err?.message));
    }
  }
});
const servidor=criarServidor(db,{conexao,contexto,coletor});
let timer,timerFila,timerCiclo;
servidor.on('error',error=>{
  console.error(error.code==='EADDRINUSE'?`Porta ${porta} ocupada. Verifique o app já aberto.`:'Falha ao iniciar o painel.');
  db.close();process.exitCode=1;
});
servidor.listen(porta,'127.0.0.1',async()=>{
  console.log(`Assessor 2.0: http://127.0.0.1:${porta}`);
  // O batimento significa "ingerindo", nao "processo de pe". Era essa confusao que
  // deixava uma queda invisivel: em 10/09 o socket morreu as 17h04 e o batimento seguiu
  // por 1h30 jurando que estava tudo bem, entao o vigia nunca alarmou. Uma folga de boot
  // evita que a primeira conexao (que leva segundos) seja lida como queda.
  const bootAte=Date.now()+FOLGA_BOOT_MS;
  const bater=()=>{ if(deveBater(conexao.estado().estado,Date.now(),bootAte)) batimento(db,'principal'); };
  bater();timer=setInterval(bater,30000);
  const reconciliar=()=>{
    if(encerrando)return;
    try{if(!reconciliarCicloFontes(db,{limite:250}).restam)clearInterval(timerCiclo);}
    catch{console.error('Reconciliação da fila de fontes falhou; nova tentativa em um minuto.');
      clearInterval(timerCiclo);timerCiclo=setInterval(reconciliar,60000);timerCiclo.unref?.();}
  };
  timerCiclo=setInterval(reconciliar,1000);timerCiclo.unref?.();setImmediate(reconciliar);
  try { coletor.recuperarReinicio(); } catch (e) { console.error('Falha ao recuperar caixas:', e?.message); }
  // A fila precisa de alguem que a empurre: uma queda devolve o job para `pendente` e
  // nenhum lote novo vai chegar so por causa disso. Uma passada por vez, sem sobrepor.
  let rodando=false;
  timerFila=setInterval(async()=>{
    if(rodando||conexao.estado().estado!=='conectada')return;
    rodando=true;
    try{
      const r=await coletor.processarPendentes({limite:3});
      if(r.ok&&(r.recebidos||r.erros))console.log(`Fila de caixas: ${JSON.stringify(r)}`);
    }catch(e){console.error('Fila de caixas falhou:',e?.message);}
    finally{rodando=false;}
  },45000);
  timerFila.unref?.();
  if(existsSync(resolve(authDir,'creds.json'))) {
    try{await conexao.iniciar();}catch{console.error('Conexão requer atenção no painel.');}
  }
});
// Um ECONNRESET num fluxo de midia ja derrubou o processo inteiro em 08/09, levando
// junto a conexao do WhatsApp que levara minutos para estabilizar. Para um coletor que
// precisa ficar de pe, cair calado e pior do que seguir com o erro registrado: a fila
// e duravel e o job volta a ser tentado. Encerramento continua sendo por SIGINT/SIGTERM.
process.on('uncaughtException',erro=>{
  console.error(`[fatal-contido] ${new Date().toISOString()} ${erro?.stack||erro?.message||erro}`);
});
process.on('unhandledRejection',motivo=>{
  console.error(`[rejeicao-nao-tratada] ${new Date().toISOString()} ${motivo?.stack||motivo}`);
});
let encerrando=false;
async function encerrar(){
  if(encerrando)return;encerrando=true;clearInterval(timer);clearInterval(timerFila);clearInterval(timerCiclo);
  await conexao.parar();servidor.close(()=>db.close());
}
process.on('SIGINT',encerrar);process.on('SIGTERM',encerrar);
