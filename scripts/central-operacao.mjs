import { criarRepositorioNeon } from '../api/_central/repositorio-neon.js';
import { criarConviteRemoto, executarRetencao, preflightCentral, revogarConviteRemoto, verificarCentralRemota } from './central-operacao-lib.mjs';

const argumentos=process.argv.slice(2);
const comando=argumentos.shift();
const opcao=nome=>{const i=argumentos.indexOf(nome);return i>=0?argumentos[i+1]:undefined;};
const imprimir=objeto=>console.log(JSON.stringify(objeto,null,2));

try{
  if(comando==='preflight'){
    const resultado=await preflightCentral();
    imprimir({...resultado,mensagem:'Pré-voo local aprovado. Conclua as verificações externas antes do deploy de produção.'});
  }else if(comando==='smoke'){
    imprimir(await verificarCentralRemota());
  }else if(comando==='invite'){
    const convite=await criarConviteRemoto(opcao('--label'));
    imprimir({id:convite.id,rotulo:convite.rotulo,codigo:convite.codigo,mensagem:'Envie este cÃ³digo apenas ao tester indicado.'});
  }else if(comando==='invite-revoke'){
    imprimir(await revogarConviteRemoto(opcao('--id')));
  }else if(comando==='retention'){
    const dias=Number(process.env.LUME_RETENTION_DAYS);
    const aplicar=argumentos.includes('--apply');
    const repositorio=criarRepositorioNeon(process.env.DATABASE_URL);
    imprimir(await executarRetencao({repositorio,dias,aplicar,confirmacao:process.env.LUME_CENTRAL_MAINTENANCE_APPROVED}));
  }else{
    throw Object.assign(new Error('USO_INVALIDO'),{codigo:'USO_INVALIDO'});
  }
}catch(error){
  console.error(`Central: ${error?.codigo||'FALHA_OPERACIONAL'}`);
  process.exitCode=1;
}
