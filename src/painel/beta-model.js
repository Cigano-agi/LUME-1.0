export const VERSAO_RELATO='assessor-beta-feedback-v1';
export const CASOS={instalacao:'Instalar e abrir',primeiroAcesso:'Entender o primeiro acesso',whatsapp:'Conectar e receber histórico',reconexao:'Pausar e reconectar',fontes:'Conferir uma fonte',ia:'Perguntar à IA (opcional)',dados:'Exportar ou apagar uma nota de teste',backup:'Conferir um backup de teste',compartilhamento:'Compartilhar um projeto de teste'};
export const ESTADOS={'nao-testado':'Não testei',sucesso:'Consegui sem ajuda',ajuda:'Consegui com ajuda',falha:'Não consegui','nao-aplicavel':'Não se aplica a esta rodada'};
export const hojeLocal=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
export function novoRelato(){return {schema:VERSAO_RELATO,criadoEm:new Date().toISOString(),participante:'',plataforma:'nao-informada',sistema:'',versaoAplicativo:'',inicioSemana:hojeLocal(),diasUso:[],casos:Object.fromEntries(Object.keys(CASOS).map(k=>[k,'nao-testado'])),primeiraAcao:{historicoDisponivel:false,resultado:'nao-testado',iniciadaEm:null,encerradaEm:null,segundos:null,fonteConferida:false,ajuda:'nao-informada'},feedback:{utilidade:'nao-informada',atrapalhou:'',faltou:'',nome:'nao-escolhi',outroNome:'',motivoNome:'',valorPercebido:''}};}
const objeto=(v,keys,label)=>{if(!v||Array.isArray(v)||typeof v!=='object'||Object.keys(v).sort().join('|')!==[...keys].sort().join('|'))throw Error(`Estrutura inválida: ${label}.`);};
const texto=(v,max,label)=>{if(typeof v!=='string'||v.length>max)throw Error(`Texto inválido: ${label}.`);};
const opcao=(v,values,label)=>{if(!values.includes(v))throw Error(`Opção inválida: ${label}.`);};
const dataValida=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const instante=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export function validarRelato(v,{hoje=hojeLocal()}={}) {
  objeto(v,Object.keys(novoRelato()),'relato');
  if(v.schema!==VERSAO_RELATO||!instante(v.criadoEm))throw Error('Versão ou data do relato inválida.');
  texto(v.participante,80,'participante');texto(v.sistema,120,'sistema');texto(v.versaoAplicativo,80,'versão');
  opcao(v.plataforma,['nao-informada','windows','macos','linux','outro'],'plataforma');
  if(!dataValida(v.inicioSemana)||v.inicioSemana>hoje)throw Error('Escolha uma data de início até hoje.');
  if(!Array.isArray(v.diasUso)||v.diasUso.length>3||new Set(v.diasUso).size!==v.diasUso.length)throw Error('Registre até três dias diferentes.');
  for(const d of v.diasUso)if(!dataValida(d)||d>hoje||d<v.inicioSemana||Date.parse(d)-Date.parse(v.inicioSemana)>6*86400000)throw Error('Os dias de uso precisam estar na primeira semana, sem datas futuras.');
  objeto(v.casos,Object.keys(CASOS),'etapas');for(const x of Object.values(v.casos))opcao(x,Object.keys(ESTADOS),'resultado de etapa');
  const a=v.primeiraAcao;
  objeto(a,['historicoDisponivel','resultado','iniciadaEm','encerradaEm','segundos','fonteConferida','ajuda'],'primeira ação');
  if(typeof a.historicoDisponivel!=='boolean'||typeof a.fonteConferida!=='boolean')throw Error('Confirmações inválidas.');
  opcao(a.resultado,['nao-testado','encontrada','nao-encontrada'],'primeira ação');opcao(a.ajuda,['nao-informada','sozinho','com-ajuda'],'ajuda');
  if(a.resultado==='nao-testado') {if(a.iniciadaEm!==null||a.encerradaEm!==null||a.segundos!==null)throw Error('Medição incompleta: finalize o cronômetro antes de exportar.');}
  else {
    if(!a.historicoDisponivel||!instante(a.iniciadaEm)||!instante(a.encerradaEm)||!Number.isSafeInteger(a.segundos)||a.segundos<0||a.segundos>86400||Date.parse(a.encerradaEm)<Date.parse(a.iniciadaEm)||a.segundos!==Math.floor((Date.parse(a.encerradaEm)-Date.parse(a.iniciadaEm))/1000))throw Error('Tempo da primeira ação inválido.');
  }
  objeto(v.feedback,['utilidade','atrapalhou','faltou','nome','outroNome','motivoNome','valorPercebido'],'feedback');
  const f=v.feedback;opcao(f.utilidade,['nao-informada','voltaria','talvez','nao-voltaria'],'utilidade');opcao(f.nome,['nao-escolhi','Lastro','Fio','Lume','Assessor','outro'],'nome');
  for(const key of ['atrapalhou','faltou','motivoNome','valorPercebido'])texto(f[key],1200,key);
  texto(f.outroNome,80,'outro nome');
  return structuredClone(v);
}
export function resumoRelato(v){const a=v.primeiraAcao;return {primeiraAcaoNoPrazo:a.resultado==='nao-testado'?null:a.resultado==='encontrada'&&a.fonteConferida&&a.ajuda==='sozinho'&&a.segundos<=300,tresDiasNaSemana:v.diasUso.length===3,etapasTestadas:Object.values(v.casos).filter(s=>!['nao-testado','nao-aplicavel'].includes(s)).length,etapasComFalha:Object.values(v.casos).filter(s=>s==='falha').length};}
