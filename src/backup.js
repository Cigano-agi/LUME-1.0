import {randomBytes,randomUUID,scrypt,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {exigirPessoalSemConteudo} from './pessoal/preservacao.js';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {eventoExcluido,chaveExclusao} from './exclusoes.js';
import {fingerprint} from './compartilhamento.js';
import {prepararEsquemaTranscricao} from './transcricao.js';
import {prepararMetadadosAudio,validarMetadadosAudio} from './audio-desktop-arquivos.js';
import {prepararEsquemaFinanceiro} from './financeiro.js';
import {prepararEsquemaRascunho} from './rascunho.js';
import {prepararTarefas,TAREFAS_BACKUP,validarBackupTarefas} from './tarefas-esquema.js';
import {prepararAcoesLume,ACOES_BACKUP,validarBackupAcoes} from './acoes-lume.js';
import {validarRespostasTranscricao,tratarTranscricao} from './qualidade-transcricao.js';
import {prepararNegocios,NEGOCIOS_BACKUP,validarBackupNegocios} from './negocios-desktop.js';
import {prepararComandosWhatsapp,TABELAS_COMANDOS,validarBackupComandos} from './comandos-whatsapp.js';
import {invalidarWhatsAppLabels,prepararWhatsAppLabels,TABELAS_WHATSAPP_LABELS,validarBackupWhatsAppLabels} from './whatsapp-labels.js';
import {CICLO_COLUNAS,CICLO_TABELAS,cicloRegistroId,prepararProcedenciaCiclo} from './privacidade.js';
import {prepararExecucoes} from './execucao/esquema.js';
import {prepararProjetosComerciais} from './projetos-comerciais/esquema.js';
import {estadoFonteParaBackup,finalizarRestauracaoProjetos} from './projetos-comerciais/importacao.js';
import * as historicoModulo from './transporte/historico.js';
import * as vendasModulo from './vendas/servico.js';

const derive=promisify(scrypt);
export const LIMITE_BACKUP=256*1024*1024;
const MAX_CLARO=512*1024*1024;
const hash=b=>createHash('sha256').update(b).digest('hex');
const TABELAS=['conversas_app','grupos_app','grupo_participantes','pessoas','pessoa_identificadores','eventos','itens_crm','transcricoes','eventos_financeiros','rascunhos','f10_projetos','f10_conversas','f10_origens','f10_procedencias','f10_recebidos','f10_revogadas','f10_conversas_importadas','priv_vinculos','priv_excluidos','priv_conversas_excluidas','desktop_ia_gastos'];
const TABELAS_ALPHA5=[...TABELAS];
TABELAS.push(...TAREFAS_BACKUP);
const TABELAS_V3=[...TABELAS];
TABELAS.push(...NEGOCIOS_BACKUP);
const TABELAS_V4=[...TABELAS];
TABELAS.push(...TABELAS_COMANDOS);
const TABELAS_V5=[...TABELAS];
TABELAS.push(...TABELAS_WHATSAPP_LABELS);
const TABELAS_V6=[...TABELAS];
TABELAS.push(...ACOES_BACKUP);
const TABELAS_V8=[...TABELAS,...CICLO_TABELAS];
const TRANSCRICAO_COLUNAS=['id','conversa_id','origem_id','arquivo','quando','texto','estado','motivo','modelo','duracao_ms','criado_em','texto_original','respostas_json','audio_metadados_json'];
// Um app recém-aberto já registra sua conexão, mesmo com acervo vazio.
const TRANSITORIAS_CICLO=new Set(['wa_cobertura','wa_interrupcoes','wa_retomadas']);
const tabelasConteudo=c=>c.versao==='assessor-acervo-v8'?TABELAS_V8:TABELAS;
function prepararCiclo(db){
  if(typeof historicoModulo.prepararHistoricoWhatsApp!=='function'||typeof vendasModulo.prepararVendasJev!=='function')throw new Error('O suporte ao esquema de histórico e vendas precisa ser atualizado antes de restaurar o ciclo.');
  prepararExecucoes(db);historicoModulo.prepararHistoricoWhatsApp(db);vendasModulo.prepararVendasJev(db);prepararProjetosComerciais(db);prepararProcedenciaCiclo(db);
}
const objeto=(v,required,optional=[])=>v&&typeof v==='object'&&!Array.isArray(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const string=(v,max,min=1)=>typeof v==='string'&&v.length>=min&&v.length<=max;
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const inteiro=v=>Number.isSafeInteger(v)&&v>0;
const data=v=>string(v,64)&&Number.isFinite(Date.parse(v));
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const digest=v=>hash(Buffer.from(JSON.stringify(v)));
const erroCiclo=()=>{throw new Error('Ciclo de conversas incompatível no backup.');};
function jsonCiclo(v,max){if(!string(v,max))erroCiclo();try{return JSON.parse(v);}catch{erroCiclo();}}
function validarCiclo(t){
  const eventos=new Map(t.eventos.map(e=>[e.id,e])),acoes=new Map(t.lume_acoes.map(a=>[a.id,a]));
  const indices={};
  for(const tabela of CICLO_TABELAS){
    const ids=new Set();for(const row of t[tabela]){const key=tabela==='lume_ciclo_importacoes'?JSON.stringify([row.tabela,row.registro_id]):cicloRegistroId(tabela,row);if(ids.has(key))erroCiclo();ids.add(key);}indices[tabela]=ids;
  }
  const clientes={claude:'claude-desktop',codex:'codex',hermes:'hermes'};
  const estados=['aguardando_assistente','em_andamento','resultado_informado','verificado','revogada'];
  const permitida=a=>objeto(a,['escopo','envio','publicacao','gastos','alterar_estado_comercial'],['estado'])&&a.escopo==='preparar_material'&&['envio','publicacao','gastos','alterar_estado_comercial'].every(k=>a[k]===false)&&(a.estado===undefined||['pendente','revogada_importada'].includes(a.estado));
  for(const c of t.lume_execucao_contextos){
    if(!uuid(c.id)||!acoes.has(c.acao_id)||!data(c.criado_em)||!data(c.expira_em))erroCiclo();
    const p=jsonCiclo(c.pacote,40000),i=jsonCiclo(c.integridade,500);
    if(!objeto(i,['acao','fonte'])||!sha(i.acao)||!sha(i.fonte)||!objeto(p,['id','acao_id','tarefa','resumo','fontes','timeline','autorizacao','instrucoes','criado_em','expira_em'],['avisos'])||p.id!==c.id||p.acao_id!==c.acao_id||p.criado_em!==c.criado_em||p.expira_em!==c.expira_em||!string(p.tarefa,500)||!string(p.resumo,500)||!string(p.instrucoes,1500)||!permitida(p.autorizacao)||!Array.isArray(p.fontes)||p.fontes.length!==1||!Array.isArray(p.timeline)||p.timeline.length>10||p.avisos!==undefined&&(!Array.isArray(p.avisos)||p.avisos.length>5||p.avisos.some(v=>!string(v,500))))erroCiclo();
    for(const f of p.fontes)if(!objeto(f,['id','trecho','conversa','autor','em'],['parcial'])||f.id!=='fonte_1'||!string(f.trecho,1200)||!string(f.conversa,500)||!string(f.autor,100)||!data(f.em)||f.parcial!==undefined&&typeof f.parcial!=='boolean')erroCiclo();
    for(const h of p.timeline)if(!objeto(h,['tipo','estado','em','texto','verificacao'])||h.tipo!=='acao'||!['sugerido','confirmado','estacionado','resolvido','descartado'].includes(h.estado)||!data(h.em)||!string(h.texto,500,0)||h.verificacao!=='registro_local')erroCiclo();
  }
  const inicios=new Set();
  for(const x of t.lume_execucoes){
    if(!uuid(x.id)||!indices.lume_execucao_contextos.has(x.contexto_id)||!Object.hasOwn(clientes,x.assistente)||x.cliente_id!==clientes[x.assistente]||!estados.includes(x.estado)||!string(x.chave_inicio,100,8)||!/^[A-Za-z0-9_-]+$/.test(x.chave_inicio)||inicios.has(x.chave_inicio)||x.assinatura_inicio!==digest([x.contexto_id,x.assistente])||!data(x.autorizada_em)||!data(x.atualizada_em))erroCiclo();inicios.add(x.chave_inicio);
  }
  const chaves=new Set();
  for(const e of t.lume_execucao_eventos){
    const key=JSON.stringify([e.execucao_id,e.chave]);
    if(!inteiro(e.id)||!indices.lume_execucoes.has(e.execucao_id)||!string(e.chave,100,8)||!/^[A-Za-z0-9_-]+$/.test(e.chave)||chaves.has(key)||!['autorizacao','inicio','progresso','resultado','verificacao','revogacao'].includes(e.tipo)||!['local:owner','claude-desktop','codex','hermes','backup:importacao'].includes(e.ator)||!data(e.criado_em))erroCiclo();chaves.add(key);
    const d=jsonCiclo(e.dados,15000);
    const valido=e.tipo==='autorizacao'?objeto(d,['texto','autorizacao'])&&string(d.texto,1000)&&permitida(d.autorizacao):e.tipo==='resultado'?objeto(d,['resumo','artefatos'])&&string(d.resumo,4000)&&Array.isArray(d.artefatos)&&d.artefatos.length<=10&&d.artefatos.every(v=>string(v,500)):e.tipo==='verificacao'?objeto(d,['nota'])&&string(d.nota,1000):objeto(d,['texto'])&&string(d.texto,1000);
    if(!valido||e.assinatura!==digest([e.tipo,e.ator,d]))erroCiclo();
  }
  if(t.wa_cobertura.length>1)erroCiclo();
  for(const c of t.wa_cobertura)if(c.id!==1||!['desconectada','conectada','conectando','aguardando_qr','auth_invalida','substituida','erro','reconectando'].includes(c.estado)||!data(c.observado_em)||c.ultimo_lote_em!==null&&!data(c.ultimo_lote_em)||c.ultimo_historico_em!==null&&!data(c.ultimo_historico_em))erroCiclo();
  for(const i of t.wa_interrupcoes)if(!uuid(i.id)||!data(i.inicio)||i.fim!==null&&!data(i.fim)||!['aplicativo_fechado','reinicio','conexao_interrompida'].includes(i.motivo))erroCiclo();
  for(const r of t.wa_recuperacoes)if(!uuid(r.id)||!string(r.conversa_id,160)||!['retomar','anteriores'].includes(r.modo)||!['solicitando','aguardando_historico','falhou','interrompida'].includes(r.estado)||!data(r.pedido_em)||!data(r.atualizado_em)||![0,1].includes(r.recibo)||r.erro!==null&&!['APLICATIVO_REINICIADO','BACKUP_RESTAURADO','HISTORICO_INDISPONIVEL','HISTORICO_CANCELADO','HISTORICO_SEM_ANCORA','HISTORICO_FONTE_ALTERADA','HISTORICO_FALHA'].includes(r.erro)||r.evento_id!==null&&eventos.get(r.evento_id)?.conversa_id!==r.conversa_id)erroCiclo();
  for(const r of t.wa_retomadas)if(!indices.wa_interrupcoes.has(r.interrupcao_id)||!string(r.conversa_id,160)||!t.eventos.some(e=>e.conversa_id===r.conversa_id))erroCiclo();
  for(const r of t.lume_vendas_avaliacoes){
    const v=jsonCiclo(r.resultado,20000);
    if(!uuid(r.id)||!string(r.conversa_id,160)||!sha(r.assinatura)||!data(r.avaliado_em)||!objeto(v,['id','temperatura','etapa','criterio','criterio_etapa','confianca','origem','avaliado_em','fontes','desatualizada'],['confianca_etapa','probabilidades','revisao','modelo','calibracao','custo_usd','criterios_versao','solicitacao_id','consentimento','importacao','recorte','aviso'])||v.id!==r.id||v.avaliado_em!==r.avaliado_em||!['frio','morno','quente','insuficiente'].includes(v.temperatura)||!['interesse','proposta','conversa','fechado','encerrado','insuficiente'].includes(v.etapa)||!string(v.criterio,1000)||!string(v.criterio_etapa,1000)||!['manual','jev'].includes(v.origem)||typeof v.desatualizada!=='boolean'||!Array.isArray(v.fontes)||!v.fontes.length||v.fontes.length>20||new Set(v.fontes).size!==v.fontes.length||!v.fontes.every(id=>eventos.get(id)?.conversa_id===r.conversa_id))erroCiclo();
    if(v.aviso!==undefined&&!string(v.aviso,1000))erroCiclo();
    if(v.recorte!==undefined){
      const c=v.recorte;
      if(!objeto(c,['escopo','total','selecionadas','inicio_em','fim_em','contexto_omitido','contexto_omitido_possivel','assinatura_janela','revisao','aviso'])||
        c.escopo!=='mensagens_selecionadas'||!inteiro(c.total)||c.total>20||c.selecionadas!==v.fontes.length||c.selecionadas>c.total||
        !data(c.inicio_em)||!data(c.fim_em)||Date.parse(c.inicio_em)>Date.parse(c.fim_em)||
        c.contexto_omitido!==(c.selecionadas<c.total)||c.contexto_omitido_possivel!==true||!sha(c.assinatura_janela)||
        c.revisao!==null&&!sha(c.revisao)||!string(c.aviso,1000))erroCiclo();
    }
    if(v.criterios_versao!==undefined&&v.criterios_versao!=='vendas-1'||v.solicitacao_id!==undefined&&v.solicitacao_id!==null&&(!string(v.solicitacao_id,160)||!/^gen-dec-[A-Za-z0-9-]{1,150}$/.test(v.solicitacao_id)))erroCiclo();
    if(v.consentimento!==undefined&&(!objeto(v.consentimento,['confirmado_em','provedor','modelo','assinatura_recorte'])||!data(v.consentimento.confirmado_em)||v.consentimento.provedor!=='OpenRouter / TypeSafe'||!['typesafe/jev-1.13','typesafe/jev-1.14'].includes(v.consentimento.modelo)||v.consentimento.assinatura_recorte!==r.assinatura))erroCiclo();
    if(v.importacao!==undefined&&(!objeto(v.importacao,['em','backup_sha256','consentimento_transferido'])||!data(v.importacao.em)||!sha(v.importacao.backup_sha256)||v.importacao.consentimento_transferido!==false||v.desatualizada!==true))erroCiclo();
    for(const k of ['confianca','confianca_etapa'])if(v[k]!==undefined&&v[k]!==null&&(!Number.isFinite(v[k])||v[k]<0||v[k]>1))erroCiclo();
    if(v.modelo!==undefined&&(!string(v.modelo,100)||!/^typesafe\/jev-1\.(?:13|14)(?:-\d{8})?$/.test(v.modelo))||v.calibracao!==undefined&&v.calibracao!=='nao_validada_no_lume'||v.revisao!==undefined&&!['necessaria','sugerida'].includes(v.revisao)||v.custo_usd!==undefined&&v.custo_usd!==null&&(!Number.isFinite(v.custo_usd)||v.custo_usd<0))erroCiclo();
    if(v.probabilidades!==undefined){
      if(!objeto(v.probabilidades,['temperatura','etapa']))erroCiclo();
      for(const [k,keys] of [['temperatura',['frio','morno','quente','insuficiente']],['etapa',['interesse','proposta','conversa','fechado','encerrado','insuficiente']]])if(!objeto(v.probabilidades[k],keys)||Object.values(v.probabilidades[k]).some(p=>!Number.isFinite(p)||p<0||p>1))erroCiclo();
    }
  }
  const projetos=new Map(t.lume_projetos_comerciais.map(p=>[p.id,p])),fontes=new Map(t.lume_projetos_fontes.map(f=>[f.id,f])),selecoes=new Set(),chavesProjetos=new Set();
  for(const p of projetos.values()){
    if(!uuid(p.id)||!string(p.nome,160)||!['acordo_citado','proposta','incerto'].includes(p.natureza)||!['rascunho','confirmado','arquivado'].includes(p.estado)||!sha(p.chave)||chavesProjetos.has(p.chave)||!sha(p.assinatura_criacao)||!inteiro(p.bases_total)||p.bases_total>32||!data(p.criado_em)||!data(p.atualizado_em)||t.lume_projetos_fontes.filter(f=>f.projeto_id===p.id&&f.base===1).length!==p.bases_total)erroCiclo();chavesProjetos.add(p.chave);
  }
  for(const f of fontes.values()){
    const selecao=JSON.stringify([f.projeto_id,f.evento_id,f.selecao,f.inicio,f.tamanho]);
    if(!uuid(f.id)||!projetos.has(f.projeto_id)||!eventos.has(f.evento_id)||!sha(f.assinatura)||!Number.isSafeInteger(f.inicio)||f.inicio<0||!inteiro(f.tamanho)||f.inicio+f.tamanho>10000000||!['evento','trecho'].includes(f.selecao)||![0,1].includes(f.base)||![0,1].includes(f.removida)||![0,1].includes(f.invalidada)||!data(f.criada_em)||selecoes.has(selecao))erroCiclo();selecoes.add(selecao);
  }
  for(const h of t.lume_projetos_historico)if(!inteiro(h.id)||!projetos.has(h.projeto_id)||!['criado','confirmado','arquivado','restaurado','fonte_vinculada','fonte_desvinculada','importado_revisado'].includes(h.tipo)||h.fonte_id!==null&&fontes.get(h.fonte_id)?.projeto_id!==h.projeto_id||!data(h.quando))erroCiclo();
  for(const p of t.lume_ciclo_importacoes){
    if(!Object.hasOwn(CICLO_COLUNAS,p.tabela)||p.tabela==='lume_ciclo_importacoes'||!indices[p.tabela].has(p.registro_id)||!sha(p.backup_sha256)||!data(p.importado_em)||p.estado_original!==null&&!string(p.estado_original,100))erroCiclo();
    if(p.tabela==='lume_projetos_fontes'&&p.estado_original!==null){
      const e=jsonCiclo(p.estado_original,100);
      if(!objeto(e,['versao','invalidada','removida'])||e.versao!==1||![0,1].includes(e.invalidada)||![0,1].includes(e.removida))erroCiclo();
    }
  }
}
const MESCLAVEIS=new Set(['priv_excluidos','priv_conversas_excluidas','f10_revogadas','desktop_ia_gastos','desktop_tarefas_lotes']);
function senhaValida(s){if(typeof s!=='string'||s.length<12||s.length>256)throw new Error('Use uma senha de 12 a 256 caracteres e guarde-a fora do aplicativo.');}
async function chave(s,salt){senhaValida(s);return derive(s,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
export async function cifrarBackup(conteudo,senha){
 senhaValida(senha);const claro=Buffer.from(JSON.stringify(conteudo));if(claro.length>MAX_CLARO)throw new Error('Acervo acima do limite de 512 MB deste formato de backup. Nenhuma cópia parcial foi criada.');
 const salt=randomBytes(16),iv=randomBytes(12),key=await chave(senha,salt);
 try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('assessor-backup-v1'));const bytes=Buffer.concat([cipher.update(gzipSync(claro)),cipher.final()]);
  const out={formato:'assessor-backup-v1',kdf:'scrypt-32768-8-1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),dados:bytes.toString('base64')};
  if(Buffer.byteLength(JSON.stringify(out))>LIMITE_BACKUP)throw new Error('Backup acima de 256 MB. Nenhuma cópia parcial foi criada.');return out;
 }finally{key.fill(0);claro.fill(0);}
}
export async function abrirBackup(arquivo,senha){
 senhaValida(senha);if(typeof arquivo!=='string'||Buffer.byteLength(arquivo)>LIMITE_BACKUP)throw new Error('Arquivo de backup acima do limite ou inválido.');
 let o;try{o=JSON.parse(arquivo);}catch{throw new Error('Arquivo de backup inválido.');}
 if(!o||Object.keys(o).sort().join(',')!=='dados,formato,iv,kdf,salt,tag'||o.formato!=='assessor-backup-v1'||o.kdf!=='scrypt-32768-8-1')throw new Error('Formato de backup não reconhecido.');
 const bin=(v,n)=>{if(typeof v!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(v))throw new Error('Backup inválido.');const b=Buffer.from(v,'base64');if(n&&b.length!==n||b.toString('base64')!==v)throw new Error('Backup inválido.');return b;};
 const salt=bin(o.salt,16),iv=bin(o.iv,12),tag=bin(o.tag,16),ciphertext=bin(o.dados),key=await chave(senha,salt);
 try{const d=createDecipheriv('aes-256-gcm',key,iv);d.setAAD(Buffer.from('assessor-backup-v1'));d.setAuthTag(tag);const compressed=Buffer.concat([d.update(ciphertext),d.final()]);const plain=gunzipSync(compressed,{maxOutputLength:MAX_CLARO});try{return JSON.parse(plain.toString('utf8'));}finally{plain.fill(0);compressed.fill(0);}}
 catch{throw new Error('Senha incorreta, arquivo alterado ou backup inválido. Nada foi restaurado.');}finally{key.fill(0);}
}
export class Backup {
 constructor(db,{arquivos=null,perfil=()=>({nome:''})}={}){this.db=db;this.arquivos=arquivos;this.perfil=perfil;this.revisao=0;this.previa=null;this.ocupado=false;}
 invalidar(){this.revisao++;this.previa=null;}
 tem(t){return Boolean(this.db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(t));}
 capturar(){
  exigirPessoalSemConteudo(this.db);
  if(this.tem('wa_fila_retomada')&&this.db.prepare('SELECT 1 FROM wa_fila_retomada LIMIT 1').get())
    throw new Error('Há pedidos de histórico na fila. Use o backup v10 para preservá-los.');
  if(this.tem('ciclo_midias')&&this.db.prepare('SELECT 1 FROM ciclo_midias LIMIT 1').get())
    throw new Error('Este perfil contém originais geridos. Use o backup v10 para preservá-los.');
  if(this.tem('notetaker_sessoes')&&this.db.prepare('SELECT 1 FROM notetaker_sessoes LIMIT 1').get())throw new Error('Backup de reunião exige formato v9; este perfil de teste não pode criar backup v8.');
  prepararEsquemaTranscricao(this.db);
  prepararMetadadosAudio(this.db);
  prepararComandosWhatsapp(this.db);
  prepararWhatsAppLabels(this.db);
  prepararAcoesLume(this.db);
  // Não transforma cadastros de execução em permissões de pasta no receptor.
  for(const t of ['projetos','caixas_jobs','caixas_inventario','linha_tempo'])if(this.tem(t)&&this.db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())throw new Error('Este perfil contém dados de execução/importação legada. O backup desktop precisa mapear esses dados antes de gerar uma cópia completa.');
  const ciclo=CICLO_TABELAS.some(t=>this.tem(t)&&this.db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())||Boolean(this.db.prepare('SELECT 1 FROM transcricoes WHERE audio_metadados_json IS NOT NULL LIMIT 1').get());
  if(ciclo)prepararCiclo(this.db);
  const selecionadas=ciclo?TABELAS_V8:TABELAS,tabelas={},arquivos=[],cache=new Map();
  const guardarArquivo=path=>{
    if(cache.has(path))return cache.get(path);
    if(!existsSync(path))throw new Error('Um anexo está ausente. Confira os arquivos antes do backup.');
    if(lstatSync(path).size>64*1024*1024)throw new Error('Anexo acima de 64 MB. Este formato não criou cópia parcial.');const b=readFileSync(path);
    if(b.length>64*1024*1024||arquivos.length>=10000)throw new Error('Limite de anexos excedido. Nenhuma cópia parcial foi criada.');
    const id=arquivos.length;cache.set(path,id);arquivos.push({id,hash:hash(b),dados:b.toString('base64')});return id;
  };
  this.db.exec('BEGIN');
  try{for(const t of selecionadas){
    if(CICLO_COLUNAS[t]&&this.db.prepare(`PRAGMA table_info(${t})`).all().map(c=>c.name).sort().join('|')!==[...CICLO_COLUNAS[t]].sort().join('|'))erroCiclo();
    tabelas[t]=this.tem(t)?this.db.prepare(`SELECT * FROM ${t}`).all():[];
    if(t==='transcricoes')for(const row of tabelas[t]){
      if(!ciclo)delete row.audio_metadados_json;
      if(row.arquivo){
        if(!this.arquivos)throw new Error('Gestão de anexos indisponível.');const path=this.arquivos.conferir(row.arquivo);
        row.arquivo='anexo:'+guardarArquivo(path);
      }
    }
  }
  if(ciclo){
    const fontes=new Map(tabelas.lume_projetos_fontes.map(f=>[f.id,f]));
    for(const p of tabelas.lume_ciclo_importacoes)if(p.tabela==='lume_projetos_fontes'&&fontes.has(p.registro_id))p.estado_original=estadoFonteParaBackup(this.db,fontes.get(p.registro_id));
  }
  for(const path of this.arquivos?.listarAnexos()||[])guardarArquivo(path);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  return {versao:ciclo?'assessor-acervo-v8':'assessor-acervo-v7',criadoEm:new Date().toISOString(),dono:this.perfil().nome,tabelas,arquivos};
 }
 async criar({senha,confirmar}={}){if(confirmar!==true)throw new Error('Confirme a criação do backup.');if(this.ocupado)throw new Error('Aguarde o backup em andamento.');this.ocupado=true;const revision=this.revisao;
  try{const content=this.capturar();this.validar(content);if(content.versao==='assessor-acervo-v7')for(const row of content.tabelas.transcricoes)delete row.audio_metadados_json;const pacote=await cifrarBackup(content,senha);if(revision!==this.revisao)throw new Error('Operação cancelada por alteração dos dados.');return{nome:`assessor-backup-${randomUUID()}.json`,pacote,total:content.tabelas.eventos.length,aviso:'Guarde a senha separadamente. Sem ela não é possível restaurar. Sessão WhatsApp, chaves e autorizações não estão incluídas.'};}finally{this.ocupado=false;}}
 validar(c){
  const versoes=['assessor-acervo-v1','assessor-acervo-v2','assessor-acervo-v3','assessor-acervo-v4','assessor-acervo-v5','assessor-acervo-v6','assessor-acervo-v7','assessor-acervo-v8'];
  const esperadas=c?.versao==='assessor-acervo-v8'?TABELAS_V8:c?.versao==='assessor-acervo-v1'?TABELAS_ALPHA5:c?.versao==='assessor-acervo-v4'?TABELAS_V4:c?.versao==='assessor-acervo-v5'?TABELAS_V5:c?.versao==='assessor-acervo-v6'?TABELAS_V6:c?.versao==='assessor-acervo-v7'?TABELAS:TABELAS_V3;
  if(!c||typeof c!=='object'||Object.keys(c).sort().join(',')!=='arquivos,criadoEm,dono,tabelas,versao'||!versoes.includes(c.versao)||typeof c.dono!=='string'||c.dono.length>80||!Number.isFinite(Date.parse(c.criadoEm))||!c.tabelas||Object.keys(c.tabelas).sort().join('|')!==[...esperadas].sort().join('|')||!Array.isArray(c.arquivos)||c.arquivos.length>10000)throw new Error('Conteúdo do backup inválido.');
  // Só o conjunto fechado da alpha.5 é migrado. Tabelas faltantes na v2 são erro.
  if(c.versao==='assessor-acervo-v1'){for(const t of TAREFAS_BACKUP)c.tabelas[t]=[];c.versao='assessor-acervo-v2';}
  prepararEsquemaTranscricao(this.db);prepararEsquemaFinanceiro(this.db);prepararEsquemaRascunho(this.db);prepararTarefas(this.db);prepararNegocios(this.db);prepararComandosWhatsapp(this.db);prepararWhatsAppLabels(this.db);prepararAcoesLume(this.db);
  prepararMetadadosAudio(this.db);
  if(c.versao==='assessor-acervo-v8')prepararCiclo(this.db);
  if(c.versao==='assessor-acervo-v2'){
    const antigos=TRANSCRICAO_COLUNAS.filter(c=>!['texto_original','respostas_json','audio_metadados_json'].includes(c)).sort().join('|');
    if(!Array.isArray(c.tabelas.transcricoes))throw new Error('Tabela do backup inválida.');
    for(const row of c.tabelas.transcricoes){if(!row||Object.keys(row).sort().join('|')!==antigos)throw new Error('Campos legados de transcrição incompatíveis.');row.texto_original=null;row.respostas_json=null;}
    c.versao='assessor-acervo-v3';
  }
  if(c.versao==='assessor-acervo-v3'){for(const t of NEGOCIOS_BACKUP)c.tabelas[t]=[];c.versao='assessor-acervo-v4';}
  if(c.versao==='assessor-acervo-v4'){for(const t of TABELAS_COMANDOS)c.tabelas[t]=[];c.versao='assessor-acervo-v5';}
  if(c.versao==='assessor-acervo-v5'){for(const t of TABELAS_WHATSAPP_LABELS)c.tabelas[t]=[];c.versao='assessor-acervo-v6';}
  if(c.versao==='assessor-acervo-v6'){for(const t of ACOES_BACKUP)c.tabelas[t]=[];c.versao='assessor-acervo-v7';}
  // Só a forma exata anterior à coluna local recebe NULL; campos arbitrários falham.
  const transcricaoAnterior=TRANSCRICAO_COLUNAS.filter(c=>c!=='audio_metadados_json').sort().join('|');
  if(!Array.isArray(c.tabelas.transcricoes))throw new Error('Tabela do backup inválida.');
  for(const row of c.tabelas.transcricoes)if(row&&Object.keys(row).sort().join('|')===transcricaoAnterior)row.audio_metadados_json=null;
  // Backups v7 criados durante a implementação da 0.6 precedem os recibos de aviso.
  const camposAcoesAntesAvisos='atualizada_em|autor_id|chave|criada_em|estado|evento_id|fonte_assinatura|fuso|id|lembrar_em|prazo_citado|responsavel_id|resumo|tipo|trecho|trecho_inicio';
  for(const row of c.tabelas.lume_acoes||[])if(row&&Object.keys(row).sort().join('|')===camposAcoesAntesAvisos){row.aviso_para=null;row.aviso_em=null;row.aviso_resultado=null;}
  for(const [t,rows] of Object.entries(c.tabelas)){
    if(!Array.isArray(rows)||rows.length>1000000)throw new Error('Tabela do backup inválida.');
    const permitidas=t==='transcricoes'?TRANSCRICAO_COLUNAS:CICLO_COLUNAS[t];
    const columns=(permitidas?[...permitidas]:this.db.prepare(`PRAGMA table_info(${t})`).all().map(x=>x.name)).sort().join('|');
    if(permitidas&&this.db.prepare(`PRAGMA table_info(${t})`).all().map(x=>x.name).sort().join('|')!==columns)erroCiclo();
    for(const row of rows)if(!row||typeof row!=='object'||Object.keys(row).sort().join('|')!==columns||Object.values(row).some(v=>v!==null&&!['string','number'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v)))throw new Error('Campos incompatíveis no backup.');
  }
  for(const [i,f] of c.arquivos.entries()){if(!f||Object.keys(f).sort().join(',')!=='dados,hash,id'||f.id!==i||typeof f.dados!=='string'||f.dados.length>90*1024*1024||typeof f.hash!=='string')throw new Error('Anexo do backup inválido.');const b=Buffer.from(f.dados,'base64');if(b.length>64*1024*1024||b.toString('base64')!==f.dados||hash(b)!==f.hash)throw new Error('Anexo do backup foi alterado ou excede o limite.');}
  for(const r of c.tabelas.transcricoes)if(r.arquivo!==null&&(!/^anexo:\d+$/.test(r.arquivo)||!c.arquivos[Number(r.arquivo.slice(6))]))throw new Error('Referência de anexo inválida.');
  for(const r of c.tabelas.transcricoes){
    if(r.audio_metadados_json!==null){
      if(c.versao!=='assessor-acervo-v8')throw new Error('Metadados de áudio local exigem backup v8.');
      const m=jsonCiclo(r.audio_metadados_json,1024*1024);validarMetadadosAudio(m);
      if(r.modelo!=='whisper.cpp/'+m.versaoMotor||(r.arquivo!==null&&c.arquivos[Number(r.arquivo.slice(6))]?.hash!==m.audioSha256))throw new Error('Motor ou hash do áudio local incompatível com o anexo.');
      if(!m||m.fonte.conversaId!==r.conversa_id||m.fonte.origemId!==r.origem_id||!c.tabelas.eventos.some(e=>e.conversa_id===r.conversa_id&&e.origem_id===r.origem_id)||(m.trechos.length?m.trechos.map(t=>t.texto.trim()).join(' '):'(sem fala)')!==r.texto_original)throw new Error('Metadados de áudio local incompatíveis com a fonte.');
    }
    if(r.texto_original===null){if(r.respostas_json!==null)throw new Error('Original de transcrição ausente.');continue;}
    let respostas;try{respostas=JSON.parse(r.respostas_json);}catch{throw new Error('Respostas de transcrição inválidas.');}
    if(typeof r.texto_original!=='string'||!validarRespostasTranscricao(respostas)||respostas.at(-1).textoOriginal!==r.texto_original||r.texto!==(r.estado==='erro'?null:tratarTranscricao(r.texto_original)))throw new Error('Original e texto tratado de transcrição incompatíveis.');
  }
  for(const e of c.tabelas.eventos){if(e.projeto_id!==null||!['minha','dirigida','terceiro','compartilhado',null].includes(e.permissao))throw new Error('Permissão ou projeto incompatível no backup.');}
  const excluidos=new Set(c.tabelas.priv_excluidos.map(r=>r.hash)),revogadas=new Set(c.tabelas.f10_revogadas.map(r=>r.fingerprint));
  if(c.tabelas.eventos.some(e=>excluidos.has(chaveExclusao(e.conversa_id,e.origem_id))))throw new Error('Backup contraditório: fonte marcada como excluída.');
  for(const r of c.tabelas.f10_origens)if(revogadas.has(r.fingerprint)||fingerprint(r.chave_publica)!==r.fingerprint)throw new Error('Identidade compartilhada inválida no backup.');
  for(const r of c.tabelas.desktop_ia_gastos)if(typeof r.id!=='string'||!r.id||!Number.isSafeInteger(r.reservado_micros)||r.reservado_micros<0||!/^\d{4}-\d\d-\d\d$/.test(r.dia)||!['reservado','concluido','incerto'].includes(r.estado))throw new Error('Registro de gasto inválido.');
  validarBackupTarefas(c.tabelas);
  validarBackupAcoes(c.tabelas);
  validarBackupNegocios(c.tabelas);
  validarBackupComandos(c.tabelas);
  validarBackupWhatsAppLabels(c.tabelas);
  if(c.versao==='assessor-acervo-v8')validarCiclo(c.tabelas);
 }
 async preparar({arquivo,senha}={}){if(this.ocupado)throw new Error('Aguarde a operação atual.');this.previa=null;this.ocupado=true;const revision=this.revisao;
  try{const conteudo=await abrirBackup(arquivo,senha);this.validar(conteudo);if(revision!==this.revisao)throw new Error('Prévia cancelada.');const id=randomUUID();this.previa={id,conteudo,expira:Date.now()+300000};return{id,dono:conteudo.dono,criadoEm:conteudo.criadoEm,total:conteudo.tabelas.eventos.length,anexos:conteudo.arquivos.length,aviso:'Restauração exige acervo vazio e confirmação de que este backup é seu. Captura, IA e indexação ficam pausadas. Exclusões e gastos existentes são preservados.'};}finally{this.ocupado=false;}}
 restaurar({id,confirmarMeuBackup}={}){
  exigirPessoalSemConteudo(this.db);
  const p=this.previa;if(!p||p.id!==id||p.expira<Date.now())throw new Error('Prévia de backup expirada.');if(confirmarMeuBackup!==true)throw new Error('Confirme que este backup pertence a você.');
  const c=p.conteudo;this.previa=null;invalidarWhatsAppLabels(this.db);this.validar(c);
  const selecionadas=tabelasConteudo(c);
  // Nem um arquivo antigo pode ser mesclado por engano a um ciclo já existente.
  for(const t of TABELAS_V8.filter(t=>!MESCLAVEIS.has(t)&&!TRANSITORIAS_CICLO.has(t)))if(this.tem(t)&&this.db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())throw new Error('Restaure em um perfil com acervo vazio. Exporte ou faça backup do conteúdo atual antes de apagá-lo.');
  if(c.tabelas.eventos.some(e=>eventoExcluido(this.db,e.conversa_id,e.origem_id)))throw new Error('O backup contém fontes excluídas neste perfil. A restauração não reverte essa exclusão.');
  if(c.tabelas.f10_origens.some(o=>this.db.prepare('SELECT 1 FROM f10_revogadas WHERE fingerprint=?').get(o.fingerprint)))throw new Error('O backup contém origem revogada neste perfil.');
  if(c.arquivos.length&&!this.arquivos)throw new Error('Gestão de anexos indisponível.');
  const criados=[],reciboId=randomUUID();let commit=false,journal=false;this.db.exec('BEGIN IMMEDIATE;PRAGMA defer_foreign_keys=ON');
  try{
    exigirPessoalSemConteudo(this.db);
    for(const t of TABELAS_V8.filter(t=>!MESCLAVEIS.has(t)&&!TRANSITORIAS_CICLO.has(t)))if(this.tem(t)&&this.db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())throw new Error('O acervo mudou. Restaure em perfil vazio.');
    if(c.tabelas.eventos.some(e=>eventoExcluido(this.db,e.conversa_id,e.origem_id)))throw new Error('Há fontes excluídas neste perfil.');
    if(c.tabelas.f10_origens.some(o=>this.db.prepare('SELECT 1 FROM f10_revogadas WHERE fingerprint=?').get(o.fingerprint)))throw new Error('O backup contém origem revogada neste perfil.');
    for(const t of TRANSITORIAS_CICLO)if(this.tem(t))this.db.exec(`DELETE FROM ${t}`);
    if(c.arquivos.length){this.arquivos.iniciarRestauracao(reciboId,c.arquivos.length);journal=true;}
    if(c.arquivos.length)mkdirSync(this.arquivos.anexos,{recursive:true});
    for(const f of c.arquivos){const path=this.arquivos.conferir(join(this.arquivos.anexos,`restaurado-${reciboId}-${f.id}.bin`));writeFileSync(path,Buffer.from(f.dados,'base64'),{flag:'wx',mode:0o600});criados.push(path);}
    for(const t of selecionadas)for(const original of c.tabelas[t]){
      const row={...original};if(t==='transcricoes'&&row.arquivo!==null)row.arquivo=criados[Number(row.arquivo.slice(6))];
      if(t==='desktop_tarefas_lotes'){
        const antigo=this.db.prepare('SELECT dia,modo FROM desktop_tarefas_lotes WHERE id=?').get(row.id);
        if(antigo&&(antigo.dia!==row.dia||antigo.modo!==row.modo))throw new Error('Registro de tentativa automática contraditório.');
      }
      const columns=Object.keys(row);const sql=`INSERT ${MESCLAVEIS.has(t)?'OR IGNORE ':''}INTO ${t}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`;this.db.prepare(sql).run(...Object.values(row));
      if(t==='desktop_ia_gastos')this.db.prepare('UPDATE desktop_ia_gastos SET reservado_micros=MAX(reservado_micros,?) WHERE id=?').run(row.reservado_micros,row.id);
    }
    if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Backup com referências incompletas.');
    if(c.versao==='assessor-acervo-v8'){
      const importadoEm=new Date().toISOString(),backupHash=digest(c);
      const fontesImportadas=new Map(c.tabelas.lume_ciclo_importacoes.filter(p=>p.tabela==='lume_projetos_fontes').map(p=>[p.registro_id,p.estado_original]));
      for(const t of CICLO_TABELAS.filter(t=>t!=='lume_ciclo_importacoes'))for(const row of c.tabelas[t]){
        const original=t==='lume_projetos_fontes'?(fontesImportadas.has(row.id)?fontesImportadas.get(row.id):JSON.stringify({versao:1,invalidada:row.invalidada,removida:row.removida})):row.estado??null;
        this.db.prepare('INSERT OR REPLACE INTO lume_ciclo_importacoes VALUES(?,?,?,?,?)').run(t,cicloRegistroId(t,row),backupHash,importadoEm,original);
      }
      // Autoridade e estado do transporte pertencem ao perfil de destino.
      this.db.exec("UPDATE lume_execucoes SET estado='revogada';UPDATE lume_projetos_comerciais SET estado='rascunho';UPDATE lume_projetos_fontes SET invalidada=1;UPDATE wa_cobertura SET estado='desconectada';UPDATE wa_recuperacoes SET estado='interrompida',erro='BACKUP_RESTAURADO' WHERE estado IN ('solicitando','aguardando_historico');");
      for(const row of c.tabelas.lume_execucao_contextos){
        const pacote=JSON.parse(row.pacote);pacote.autorizacao.estado='revogada_importada';pacote.expira_em='1970-01-01T00:00:00.000Z';
        this.db.prepare('UPDATE lume_execucao_contextos SET pacote=?,expira_em=? WHERE id=?').run(JSON.stringify(pacote),pacote.expira_em,row.id);
      }
      for(const row of c.tabelas.lume_vendas_avaliacoes){const resultado=JSON.parse(row.resultado);resultado.desatualizada=true;resultado.importacao={em:importadoEm,backup_sha256:backupHash,consentimento_transferido:false};this.db.prepare('UPDATE lume_vendas_avaliacoes SET resultado=? WHERE id=?').run(JSON.stringify(resultado),row.id);}
      for(const x of c.tabelas.lume_execucoes){
        const dados={texto:'Histórico importado de backup; a autorização do assistente não foi transferida.'},chave='importacao-'+backupHash.slice(0,32);
        this.db.prepare('INSERT INTO lume_execucao_eventos(execucao_id,chave,assinatura,tipo,ator,dados,criado_em) VALUES(?,?,?,?,?,?,?)').run(x.id,chave,digest(['revogacao','backup:importacao',dados]),'revogacao','backup:importacao',JSON.stringify(dados),importadoEm);
      }
    }
    this.db.exec("UPDATE desktop_ia_config SET habilitada=0,revisao=revisao+1;DELETE FROM desktop_ia_conversas;DELETE FROM politicas_conversa;DELETE FROM lume_acoes_conversas;");
    this.db.exec('UPDATE desktop_tarefas_config SET ativa=0,erro=NULL,ultima_conversa_id=NULL;DELETE FROM desktop_tarefas_conversas');
    if(this.tem('desktop_semantica_config'))this.db.exec('UPDATE desktop_semantica_config SET ativa=0');
    if(c.versao==='assessor-acervo-v8')finalizarRestauracaoProjetos(this.db);
    this.db.prepare("INSERT INTO desktop_config VALUES('captura_pausada','1') ON CONFLICT(chave) DO UPDATE SET valor='1'").run();
    this.db.prepare('INSERT INTO priv_recibos VALUES(?,?,?,?)').run(reciboId,new Date().toISOString(),'restaurado',JSON.stringify({eventos:c.tabelas.eventos.length,arquivos:c.arquivos.length}));
    this.db.exec('COMMIT');commit=true;this.revisao++;let limpezaPendente=false;
    try{if(journal)this.arquivos.finalizarRestauracao(reciboId);}catch{limpezaPendente=true;}
    return {id:reciboId,eventos:c.tabelas.eventos.length,arquivos:c.arquivos.length,limpezaPendente,aviso:'Acervo restaurado. Reconecte WhatsApp e reveja permissões quando quiser. Chaves e sessões não foram restauradas.'};
  }catch(e){if(!commit){this.db.exec('ROLLBACK');if(journal)this.arquivos.reverterRestauracao(reciboId,c.arquivos.length);else for(const path of criados)if(existsSync(path))unlinkSync(path);}throw e;}
 }
}
