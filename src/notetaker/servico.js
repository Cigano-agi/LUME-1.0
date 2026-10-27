import {randomUUID,createHash} from 'node:crypto';
import {realpathSync,lstatSync,readFileSync,mkdirSync,readdirSync,unlinkSync,openSync,writeSync,fsyncSync,closeSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {prepararNotetaker} from './esquema.js';
import {validarParte,UUID,MAX_PARTE_PCM} from './contrato.js';
import {garantirEsquema} from '../permissao.js';
import {prepararFontes} from '../fontes-desktop.js';
import {criarAudioLocalRuntime} from '../audio-local-runtime.js';
import {conferirPerfilTeste,conferirBancoPerfil} from './perfil-teste.js';
export {conferirPerfilTeste,conferirBancoPerfil} from './perfil-teste.js';

const erro=(code,message)=>Object.assign(new Error(message),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const agora=()=>new Date().toISOString();
const pastaDados='notetaker-audio';
let asrAtivo=false;
const inteiroSeguro=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
function textoCorrecao(v){
  if(typeof v!=='string'||!v.isWellFormed())throw erro('ENTRADA','Texto Unicode inválido.');
  const normal=v.trim();
  if(!normal||[...normal].length>4000||Buffer.byteLength(normal,'utf8')>16000)throw erro('ENTRADA','Texto fora do limite.');
  return normal;
}
function lerArquivoRegular(path){const meta=lstatSync(path);if(!meta.isFile()||meta.isSymbolicLink())throw erro('INTEGRIDADE','Arquivo gerido inválido.');if(meta.size>MAX_PARTE_PCM+44)throw erro('INTEGRIDADE','Original excede o tamanho gerido da parte.');return readFileSync(path);}
function sincronizarDiretorio(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
const syncNaoSuportado=e=>['ENOTSUP','EOPNOTSUPP','EINVAL'].includes(e?.code)||(process.platform==='win32'&&['EPERM','EACCES'].includes(e?.code));
function escreverTudo(fd,bytes){
  let offset=0;
  while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset);if(n<=0)throw Error('Escrita de áudio incompleta.');offset+=n;}
}

export class NotetakerServico{
  constructor(db,opcoes={}){
    this.root=conferirPerfilTeste(opcoes);
    this.testMarker=opcoes.testMarker;
    this.dbPath=conferirBancoPerfil(db,this.root);
    this.db=db;this.audioLocal=opcoes.audioLocal??criarAudioLocalRuntime();this.signal=opcoes.signal;
    this.sincronizarDiretorio=opcoes.sincronizarDiretorio??sincronizarDiretorio;
    this.importacoesAtivas=new Set();
    this.audioRoot=join(this.root,pastaDados);mkdirSync(this.audioRoot,{recursive:true,mode:0o700});
    if(lstatSync(this.audioRoot).isSymbolicLink()||realpathSync(this.audioRoot)!==this.audioRoot)throw erro('FECHADO','Pasta de áudio inválida.');
    prepararNotetaker(db);garantirEsquema(db);prepararFontes(db);
    this.reconciliar();
  }
  admitir(){if(this.signal?.aborted)throw erro('CANCELADO','Operação cancelada pela manutenção.');}
  sessao(id){if(!UUID.test(id||''))throw erro('ENTRADA','Identificador inválido.');const row=this.db.prepare('SELECT * FROM notetaker_sessoes WHERE id=?').get(id);if(!row)throw erro('AUSENTE','Sessão não encontrada.');return row;}
  autorizada(id){const s=this.sessao(id);if(!s.consentimento_em||s.direitos_revogados_em||s.excluida_em||s.estado==='excluida')throw erro('DIREITO','Sessão sem direito de leitura.');return s;}
  vinculoTrecho(id){
    conferirPerfilTeste({notetakerExperimento:true,testProfileRoot:this.root,testMarker:this.testMarker});
    if(!UUID.test(id||''))throw erro('ENTRADA','Trecho inválido.');
    const r=this.db.prepare(`SELECT t.id,t.parte_id,t.ordinal,t.inicio_ms,t.fim_ms,t.texto_gerado,t.texto_corrigido,t.ator_correcao,t.revisao,
      f.evento_id,f.sessao_id,f.parte_id fonte_parte_id,f.trecho_id,f.inicio_ms fonte_inicio,f.fim_ms fonte_fim,
      f.audio_sha256,f.revisao fonte_revisao,p.sessao_id parte_sessao_id,p.posicao,p.duracao_ms,p.sha256 parte_sha256,p.caminho,p.estado parte_estado,
      e.conversa_id,e.origem_id,e.tipo,e.permissao,e.texto evento_texto,d.texto texto_exibido
      FROM notetaker_trechos t JOIN notetaker_fontes f ON f.trecho_id=t.id
      JOIN notetaker_partes p ON p.id=t.parte_id JOIN eventos e ON e.id=f.evento_id
      JOIN desktop_fontes d ON d.id=e.id WHERE t.id=?`).get(id);
    if(!r)throw erro('AUSENTE','Trecho não encontrado.');
    const s=this.autorizada(r.sessao_id);
    if(r.fonte_parte_id!==r.parte_id||r.parte_sessao_id!==r.sessao_id||
      r.conversa_id!==`local:notetaker:${s.id}`||r.origem_id!==`trecho:${r.parte_id}:${r.ordinal}`||
      r.tipo!=='notetaker_trecho'||r.permissao!=='notetaker_local'||
      r.evento_texto!==(r.texto_corrigido??r.texto_gerado)||r.texto_exibido!==r.evento_texto||
      r.fonte_inicio!==r.inicio_ms||r.fonte_fim!==r.fim_ms||r.audio_sha256!==r.parte_sha256||
      r.fonte_revisao!==r.revisao||!inteiroSeguro(r.revisao)||!inteiroSeguro(s.revisao)||
      !inteiroSeguro(r.posicao)||!inteiroSeguro(r.inicio_ms)||!inteiroSeguro(r.fim_ms)||
      r.fim_ms<r.inicio_ms||r.fim_ms>r.duracao_ms)throw erro('INTEGRIDADE','Vínculo da transcrição inválido.');
    return {r,s};
  }
  evidenciaTrecho(r){
    try{
      if(r.parte_estado!=='salva'||r.caminho!==r.parte_id+'.wav'||
        sha(lerArquivoRegular(join(this.audioRoot,r.caminho)))!==r.audio_sha256)throw Error();
      return {estado:'integra',parteId:r.parte_id,inicioMs:r.inicio_ms,fimMs:r.fim_ms};
    }catch{return {estado:'original_indisponivel',parteId:r.parte_id,inicioMs:r.inicio_ms,fimMs:r.fim_ms};}
  }
  projecaoTrecho(r,repetida){
    const ultima=this.db.prepare('SELECT ator,corrigido_em FROM notetaker_correcoes WHERE trecho_id=? ORDER BY revisao DESC LIMIT 1').get(r.id);
    const projecao={id:r.id,eventoId:r.evento_id,textoGerado:r.texto_gerado,textoCorrigido:r.texto_corrigido,
      textoExibido:r.evento_texto,revisao:r.revisao,ultimaCorrecao:ultima?{ator:ultima.ator,em:ultima.corrigido_em}:null,
      evidencia:this.evidenciaTrecho(r)};
    return repetida===undefined?projecao:{...projecao,repetida};
  }
  trecho(id){const {r}=this.vinculoTrecho(id);return this.projecaoTrecho(r);}
  historicoCorrecoes(id,{antes=null,limite=20}={}){
    const {r}=this.vinculoTrecho(id);
    if(antes!==null&&!inteiroSeguro(antes,1)||!inteiroSeguro(limite,1)||limite>20)throw erro('ENTRADA','Página inválida.');
    const rows=this.db.prepare('SELECT id,revisao,texto_anterior,texto_novo,ator,corrigido_em FROM notetaker_correcoes WHERE trecho_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?').all(r.id,antes,antes,limite+1);
    const selecionados=rows.slice(0,limite);
    return {correcoes:selecionados.map(c=>({id:c.id,revisao:c.revisao,textoAnterior:c.texto_anterior,
      textoNovo:c.texto_novo,ator:c.ator,corrigidoEm:c.corrigido_em})),antes:rows.length>limite?selecionados.at(-1).id:null};
  }
  corrigirTrecho(id,input){
    this.admitir();
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==3||
      !['texto','revisaoEsperada','confirmar'].every(k=>Object.hasOwn(input,k))||input.confirmar!==true||
      !inteiroSeguro(input.revisaoEsperada))throw erro('ENTRADA','Correção inválida.');
    const novo=textoCorrecao(input.texto);
    const savepoint=this.db.isTransaction;
    this.db.exec(savepoint?'SAVEPOINT notetaker_corrigir':'BEGIN IMMEDIATE');
    try{
      const {r,s}=this.vinculoTrecho(id);
      if(s.asr_estado!=='concluida')throw erro('CONFLITO','Transcrição não concluída.');
      if(r.revisao!==input.revisaoEsperada)throw erro('CONFLITO','Revisão mudou; releia o trecho.');
      if(novo===r.evento_texto){const resultado=this.projecaoTrecho(r,true);this.db.exec(savepoint?'RELEASE notetaker_corrigir':'COMMIT');return resultado;}
      if(!inteiroSeguro(r.revisao+1)||!inteiroSeguro(s.revisao+1))throw erro('CONFLITO','Revisão excede o limite seguro.');
      const novaRevisao=r.revisao+1,quando=agora();
      this.db.prepare('INSERT INTO notetaker_correcoes(trecho_id,revisao,texto_anterior,texto_novo,ator,corrigido_em) VALUES(?,?,?,?,?,?)')
        .run(id,novaRevisao,r.evento_texto,novo,'local:owner',quando);
      this.db.prepare('UPDATE notetaker_trechos SET texto_corrigido=?,ator_correcao=?,revisao=? WHERE id=?')
        .run(novo,'local:owner',novaRevisao,id);
      this.db.prepare('UPDATE notetaker_fontes SET revisao=? WHERE trecho_id=?').run(novaRevisao,id);
      this.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(novo,r.evento_id);
      this.db.prepare('UPDATE notetaker_sessoes SET revisao=revisao+1 WHERE id=?').run(s.id);
      if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_execucao_contexto_guardas'").get()){
        this.db.prepare(`UPDATE lume_execucao_contexto_guardas SET invalidada_em=?,motivo='fonte_alterada'
          WHERE evento_id=? AND invalidada_em IS NULL`).run(quando,r.evento_id);
        if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_execucao_contexto_grants'").get())
          this.db.prepare(`UPDATE lume_execucao_contexto_grants SET invalidada=1 WHERE contexto_id IN
            (SELECT contexto_id FROM lume_execucao_contexto_guardas WHERE evento_id=?)`).run(r.evento_id);
      }
      const atual=this.vinculoTrecho(id).r,resultado=this.projecaoTrecho(atual,false);
      this.db.exec(savepoint?'RELEASE notetaker_corrigir':'COMMIT');
      return resultado;
    }catch(e){this.db.exec(savepoint?'ROLLBACK TO notetaker_corrigir; RELEASE notetaker_corrigir':'ROLLBACK');throw e;}
  }
  criarSessao({origem,entradas}){
    this.admitir();
    if(origem!=='importacao'||!Array.isArray(entradas)||entradas.length!==1||entradas[0]!=='importacao')throw erro('ENTRADA','Escolha importação de áudio.');
    const id=randomUUID();this.db.prepare("INSERT INTO notetaker_sessoes(id,estado,origem,entradas,inicio_em) VALUES(?,'preparada','importacao','[\"importacao\"]',?)").run(id,agora());
    return {id,estado:'preparada'};
  }
  consentir(id,{entradas,confirmar}){
    this.admitir();
    const s=this.sessao(id);if(s.estado!=='preparada'||confirmar!==true||JSON.stringify(entradas)!=='["importacao"]')throw erro('DIREITO','Confirme a entrada desta sessão.');
    this.db.prepare('UPDATE notetaker_sessoes SET consentimento_em=?,revisao=revisao+1 WHERE id=?').run(agora(),id);
    return this.estado(id);
  }
  estado(id){const s=this.autorizada(id);const partes=this.db.prepare('SELECT id,entrada,posicao,inicio_ms,duracao_ms,sha256,estado FROM notetaker_partes WHERE sessao_id=? ORDER BY entrada,posicao').all(id).map(p=>({...p,durabilidade:p.estado==='salva'?(existsSync(join(this.audioRoot,p.id+'.wav.journal'))?'reinicio_pendente':'verificada'):'indisponivel'}));return {id:s.id,estado:s.estado,importacao:s.importacao_estado,asr:s.asr_estado,revisao:s.revisao,sha256:s.importacao_sha256,bytes:s.importacao_bytes,partes,coberturaMs:partes.filter(p=>p.estado==='salva').reduce((n,p)=>n+p.duracao_ms,0)};}
  iniciarImportacao(id){
    this.admitir();
    const sessao=this.autorizada(id);
    if(sessao.origem!=='importacao')throw erro('DIREITO','Sessão não aceita importação.');
    if(this.importacoesAtivas.has(id))throw erro('CONFLITO','Importação desta sessão já está em curso.');
    const anteriorCompleta=sessao.importacao_estado==='completa';
    if(!anteriorCompleta){
      const r=this.db.prepare("UPDATE notetaker_sessoes SET estado='preparada',importacao_estado='em_curso',importacao_sha256=NULL,importacao_bytes=NULL,revisao=revisao+1 WHERE id=? AND importacao_estado IN ('nao_iniciada','incompleta') AND consentimento_em IS NOT NULL AND direitos_revogados_em IS NULL AND excluida_em IS NULL").run(id);
      if(r.changes!==1)throw erro('CONFLITO','Importação desta sessão já está em curso.');
    }
    this.importacoesAtivas.add(id);
    return {sessao,anteriorCompleta,liberar:()=>this.importacoesAtivas.delete(id)};
  }
  marcarImportacao(id,estado,hash=null,bytes=null){
    if(estado==='completa')this.admitir();
    this.autorizada(id);
    if(!['incompleta','completa'].includes(estado))throw erro('ENTRADA','Estado de importação inválido.');
    const sessaoEstado=estado==='completa'?'encerrada':'interrompida';
    const r=this.db.prepare("UPDATE notetaker_sessoes SET estado=?,importacao_estado=?,importacao_sha256=?,importacao_bytes=?,fim_em=CASE WHEN ?='completa' THEN ? ELSE fim_em END,revisao=revisao+1 WHERE id=? AND importacao_estado='em_curso'").run(sessaoEstado,estado,hash,bytes,estado,agora(),id);
    if(r.changes!==1)throw erro('CONFLITO','Importação antiga não altera sessão atual.');
  }
  verificarParteExistente(id,{entrada='importacao',posicao,bytes}){
    const s=this.autorizada(id);
    if(s.importacao_estado!=='completa'||s.origem!=='importacao'||entrada!=='importacao'||!Number.isSafeInteger(posicao)||posicao<0||posicao>=120)throw erro('CONFLITO','Retry não corresponde à sessão concluída.');
    const meta=validarParte(bytes),hash=sha(bytes);
    const antiga=this.db.prepare('SELECT * FROM notetaker_partes WHERE sessao_id=? AND entrada=? AND posicao=?').get(id,entrada,posicao);
    if(!antiga||antiga.estado!=='salva'||antiga.sha256!==hash||antiga.duracao_ms!==meta.duracaoMs)throw erro('CONFLITO','Retry difere do original concluído.');
    try{if(antiga.caminho!==antiga.id+'.wav'||sha(lerArquivoRegular(join(this.audioRoot,antiga.caminho)))!==hash)throw Error();}
    catch{throw erro('INTEGRIDADE','Original indisponível; retry não confirma parte corrompida.');}
    return {id:antiga.id,sha256:hash,posicao,duracaoMs:meta.duracaoMs,repetida:true,durabilidade:existsSync(join(this.audioRoot,antiga.caminho+'.journal'))?'reinicio_pendente':'verificada'};
  }
  confirmarRetryCompleto(id,{sha256,bytes,quantidadePartes}){
    const s=this.autorizada(id);
    if(s.importacao_estado!=='completa'||s.importacao_sha256!==sha256||s.importacao_bytes!==bytes||
      this.db.prepare("SELECT COUNT(*) n FROM notetaker_partes WHERE sessao_id=? AND entrada='importacao'").get(id).n!==quantidadePartes)
      throw erro('CONFLITO','Arquivo já importado com bytes ou partes diferentes.');
  }
  guardarParte(id,{entrada='importacao',posicao,bytes}){
    this.admitir();
    const s=this.autorizada(id);if(s.origem!=='importacao'||entrada!=='importacao'||!Number.isSafeInteger(posicao)||posicao<0||posicao>=120)throw erro('ENTRADA','Parte inválida.');
    const meta=validarParte(bytes),hash=sha(bytes);
    const antiga=this.db.prepare('SELECT * FROM notetaker_partes WHERE sessao_id=? AND entrada=? AND posicao=?').get(id,entrada,posicao);
    if(antiga){
      if(antiga.sha256!==hash||antiga.duracao_ms!==meta.duracaoMs)throw erro('CONFLITO','Parte existente com bytes diferentes.');
      try{if(antiga.caminho!==antiga.id+'.wav'||sha(lerArquivoRegular(join(this.audioRoot,antiga.caminho)))!==hash)throw Error();}
      catch{throw erro('INTEGRIDADE','Original indisponível; retry não confirma parte corrompida.');}
      return {id:antiga.id,sha256:hash,posicao,duracaoMs:meta.duracaoMs,repetida:true,durabilidade:existsSync(join(this.audioRoot,antiga.caminho+'.journal'))?'reinicio_pendente':'verificada'};
    }
    const proxima=this.db.prepare('SELECT COUNT(*) n FROM notetaker_partes WHERE sessao_id=? AND entrada=?').get(id,entrada).n;
    if(posicao!==proxima)throw erro('CONFLITO','Há lacuna na sequência de partes.');
    const parteId=randomUUID(),nome=`${parteId}.wav`,dest=join(this.audioRoot,nome),temp=dest+'.tmp',journal=dest+'.journal';
    // Journal antecede bytes; se o SO não sincroniza diretório, recibo fica pendente até reinício verificado.
    let fd,durabilidade='sincronizada';
    const sync=()=>{try{this.sincronizarDiretorio(this.audioRoot);}catch(e){if(syncNaoSuportado(e))durabilidade='reinicio_pendente';else throw e;}};
    try{
      fd=openSync(journal,'wx',0o600);escreverTudo(fd,Buffer.from(JSON.stringify({parteId,sessaoId:id,nome,sha256:hash})));fsyncSync(fd);closeSync(fd);fd=undefined;
      sync();
      fd=openSync(temp,'wx',0o600);escreverTudo(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;
      if(existsSync(dest))throw erro('CONFLITO','Destino de áudio já existe.');
      renameSync(temp,dest);
      sync();
      this.db.exec('SAVEPOINT notetaker_guardar_parte');
      try{
        this.db.prepare("INSERT INTO notetaker_partes(id,sessao_id,entrada,posicao,inicio_ms,duracao_ms,sha256,caminho,estado) VALUES(?,?,?,?,?,?,?,?,'salva')").run(parteId,id,entrada,posicao,posicao*60000,meta.duracaoMs,hash,nome);
        this.db.exec('RELEASE notetaker_guardar_parte');
      }catch(e){this.db.exec('ROLLBACK TO notetaker_guardar_parte;RELEASE notetaker_guardar_parte');throw e;}
      if(durabilidade==='sincronizada')try{unlinkSync(journal);}catch{durabilidade='reinicio_pendente';}
      return {id:parteId,sha256:hash,posicao,duracaoMs:meta.duracaoMs,repetida:false,durabilidade};
    }catch(e){if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{};throw e;}
  }
  reconciliar(){
    this.db.exec("UPDATE notetaker_sessoes SET importacao_estado='incompleta',estado='interrompida' WHERE importacao_estado='em_curso'");
    this.db.exec("UPDATE notetaker_sessoes SET asr_estado='interrompida' WHERE asr_estado='em_curso'");
    for(const name of readdirSync(this.audioRoot)){
      const managed=join(this.audioRoot,name);
      if((name.endsWith('.tmp')||name.endsWith('.journal'))&&lstatSync(managed).isSymbolicLink())throw erro('FECHADO','Arquivo temporário ou journal com ponteiro simbólico.');
      if(name.endsWith('.tmp')){try{unlinkSync(join(this.audioRoot,name));}catch{};continue;}
      if(!name.endsWith('.journal'))continue;
      const p=join(this.audioRoot,name);let item;
      try{item=JSON.parse(readFileSync(p,'utf8'));}catch{continue;}
      if(!UUID.test(item.parteId)||!UUID.test(item.sessaoId)||item.nome!==item.parteId+'.wav')continue;
      const destino=join(this.audioRoot,item.nome);
      if(existsSync(destino)&&lstatSync(destino).isSymbolicLink())throw erro('FECHADO','Original com ponteiro simbólico.');
      const row=this.db.prepare('SELECT id,sha256 FROM notetaker_partes WHERE id=?').get(item.parteId);
      if(!row){try{unlinkSync(destino);}catch{};this.db.prepare("UPDATE notetaker_sessoes SET importacao_estado='incompleta',estado='interrompida' WHERE id=? AND importacao_estado<>'completa'").run(item.sessaoId);try{unlinkSync(p);}catch{};continue;}
      try{if(row.sha256!==item.sha256||sha(lerArquivoRegular(destino))!==row.sha256)throw Error();try{unlinkSync(p);}catch{}}
      catch{this.db.prepare("UPDATE notetaker_partes SET estado='indisponivel' WHERE id=?").run(item.parteId);this.db.prepare("UPDATE notetaker_sessoes SET importacao_estado='incompleta',estado='interrompida' WHERE id=?").run(item.sessaoId);}
    }
    for(const p of this.db.prepare('SELECT id,sessao_id,caminho,sha256 FROM notetaker_partes WHERE estado=\'salva\'').all()){
      try{if(p.caminho!==p.id+'.wav'||sha(lerArquivoRegular(join(this.audioRoot,p.caminho)))!==p.sha256)throw Error();}
      catch{
        this.db.prepare("UPDATE notetaker_partes SET estado='indisponivel' WHERE id=?").run(p.id);
        this.db.prepare("UPDATE notetaker_sessoes SET importacao_estado='incompleta',estado='interrompida' WHERE id=?").run(p.sessao_id);
      }
    }
  }
  async audio(parteId){
    this.admitir();
    if(!UUID.test(parteId||''))throw erro('ENTRADA','Parte inválida.');
    const p=this.db.prepare('SELECT p.*,s.consentimento_em,s.direitos_revogados_em,s.excluida_em FROM notetaker_partes p JOIN notetaker_sessoes s ON s.id=p.sessao_id WHERE p.id=?').get(parteId);
    if(!p)throw erro('AUSENTE','Parte não encontrada.');this.autorizada(p.sessao_id);
    if(p.estado!=='salva')throw erro('INTEGRIDADE','Áudio indisponível.');
    if(p.caminho!==p.id+'.wav')throw erro('INTEGRIDADE','Áudio indisponível.');
    const path=join(this.audioRoot,p.caminho),bytes=lerArquivoRegular(path);
    if(sha(bytes)!==p.sha256)throw erro('INTEGRIDADE','Áudio indisponível.');
    validarParte(bytes);return bytes;
  }
  registrarResultadoAsr(parteId,resultado){
    this.admitir();
    const p=this.db.prepare('SELECT * FROM notetaker_partes WHERE id=?').get(parteId);if(!p)throw erro('AUSENTE','Parte não encontrada.');
    const s=this.autorizada(p.sessao_id);if(s.importacao_estado!=='completa'||s.asr_estado!=='em_curso'||p.estado!=='salva')throw erro('CONFLITO','Arquivo ou job indisponível.');
    if(resultado?.motor!=='whisper.cpp'||!/^[a-f0-9]{64}$/.test(resultado?.modeloSha256||'')||resultado.audioSha256!==p.sha256)throw erro('MOTOR','Proveniência local inválida.');
    const saida=resultado.trechos;
    if(!Array.isArray(saida)||saida.some(t=>!Number.isSafeInteger(t.inicioMs)||!Number.isSafeInteger(t.fimMs)||t.inicioMs<0||t.fimMs<t.inicioMs||t.fimMs>p.duracao_ms||typeof t.texto!=='string'||!t.texto.trim()))throw erro('MOTOR','Saída local inválida.');
    this.db.exec('SAVEPOINT notetaker_transcrever');
    try{
      for(const [ordinal,t] of saida.entries()){
        const trechoId=randomUUID(),quando=agora();
        const bruto=JSON.stringify({motor:resultado.motor,modeloSha256:resultado.modeloSha256,origem:'local',qualidade:'nao_validada'});
        const anterior=this.db.prepare('SELECT id,texto_corrigido FROM notetaker_trechos WHERE parte_id=? AND ordinal=?').get(parteId,ordinal);
        if(anterior&&(anterior.texto_corrigido!==null||this.db.prepare('SELECT 1 FROM notetaker_correcoes WHERE trecho_id=?').get(anterior.id)))throw erro('CONFLITO','Trecho corrigido não pode ser republicado.');
        const texto=anterior?.texto_corrigido??t.texto;
        const r=this.db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada',NULL,0,'notetaker_trecho',?,?,?,?,'notetaker_local') ON CONFLICT(conversa_id,origem_id) DO UPDATE SET bruto=excluded.bruto,texto=excluded.texto RETURNING id").get(`local:notetaker:${s.id}`,`trecho:${parteId}:${ordinal}`,bruto,texto,quando,quando.slice(0,10));
        this.db.prepare('INSERT INTO notetaker_trechos(id,parte_id,ordinal,inicio_ms,fim_ms,texto_gerado) VALUES(?,?,?,?,?,?) ON CONFLICT(parte_id,ordinal) DO UPDATE SET inicio_ms=excluded.inicio_ms,fim_ms=excluded.fim_ms,texto_gerado=excluded.texto_gerado').run(trechoId,parteId,ordinal,t.inicioMs,t.fimMs,t.texto);
        const real=this.db.prepare('SELECT id FROM notetaker_trechos WHERE parte_id=? AND ordinal=?').get(parteId,ordinal).id;
        this.db.prepare('INSERT INTO notetaker_fontes(evento_id,trecho_id,sessao_id,parte_id,inicio_ms,fim_ms,audio_sha256) VALUES(?,?,?,?,?,?,?) ON CONFLICT(evento_id) DO UPDATE SET inicio_ms=excluded.inicio_ms,fim_ms=excluded.fim_ms,audio_sha256=excluded.audio_sha256').run(r.id,real,s.id,parteId,t.inicioMs,t.fimMs,p.sha256);
      }
      for(const stale of this.db.prepare('SELECT id,ordinal,texto_corrigido FROM notetaker_trechos WHERE parte_id=? AND ordinal>=?').all(parteId,saida.length)){
        if(stale.texto_corrigido!==null||this.db.prepare('SELECT 1 FROM notetaker_correcoes WHERE trecho_id=?').get(stale.id))continue;
        this.db.prepare('DELETE FROM eventos WHERE conversa_id=? AND origem_id=?').run(`local:notetaker:${s.id}`,`trecho:${parteId}:${stale.ordinal}`);
        this.db.prepare('DELETE FROM notetaker_trechos WHERE id=?').run(stale.id);
      }
      this.db.exec('RELEASE notetaker_transcrever');
    }catch(e){this.db.exec('ROLLBACK TO notetaker_transcrever;RELEASE notetaker_transcrever');throw e;}
    return {trechos:saida.length};
  }
  async transcreverImportacao(id){
    this.admitir();
    const s=this.autorizada(id);
    if(s.importacao_estado!=='completa')throw erro('CONFLITO','Arquivo incompleto; transcrição não iniciada.');
    if(s.asr_estado==='concluida')return {estado:'concluida',repetida:true};
    if(asrAtivo||s.asr_estado==='em_curso')throw erro('CONFLITO','Transcrição local já está em curso.');
    asrAtivo=true;
    let reservada=false,revisaoReservada=null;
    try{
      const reserva=this.db.prepare("UPDATE notetaker_sessoes SET asr_estado='em_curso',revisao=revisao+1 WHERE id=? AND revisao>=0 AND revisao<9007199254740991 AND importacao_estado='completa' AND asr_estado NOT IN ('em_curso','concluida') AND consentimento_em IS NOT NULL AND direitos_revogados_em IS NULL AND excluida_em IS NULL RETURNING revisao").get(id);
      if(!reserva||!inteiroSeguro(reserva.revisao))throw erro('CONFLITO','Transcrição local já está em curso.');
      reservada=true;
      revisaoReservada=reserva.revisao;
      let runtime;try{runtime=await this.audioLocal.estado({signal:this.signal});}catch{runtime={disponivel:false};}
      this.admitir();
      if(!runtime.disponivel){
        const atual=this.db.prepare("UPDATE notetaker_sessoes SET asr_estado='indisponivel' WHERE id=? AND revisao=? AND asr_estado='em_curso'").run(id,revisaoReservada);
        if(atual.changes!==1)throw erro('CONFLITO','Sessão mudou durante a transcrição.');
        return {estado:'indisponivel',mensagem:'Original preservado. Pacote local pinado ou modelo indisponível.'};
      }
      const partes=this.db.prepare("SELECT id FROM notetaker_partes WHERE sessao_id=? AND entrada='importacao' AND estado='salva' ORDER BY posicao").all(id),resultados=[];
      for(const p of partes){
        this.admitir();
        const bytes=await this.audio(p.id),antes=sha(bytes),resultado=await this.audioLocal.transcrever(bytes,{signal:this.signal});
        this.admitir();
        if(sha(await this.audio(p.id))!==antes)throw erro('INTEGRIDADE','Original mudou durante a transcrição.');
        resultados.push({parteId:p.id,resultado});
      }
      for(const p of partes)await this.audio(p.id);
      this.admitir();
      this.autorizada(id);
      let trechos=0;
      this.db.exec('SAVEPOINT notetaker_publicar_job');
      try{
        if(this.sessao(id).revisao!==revisaoReservada)throw erro('CONFLITO','Sessão mudou durante a transcrição.');
        for(const item of resultados)trechos+=this.registrarResultadoAsr(item.parteId,item.resultado).trechos;
        const final=this.db.prepare("UPDATE notetaker_sessoes SET asr_estado='concluida' WHERE id=? AND revisao=? AND asr_estado='em_curso' AND importacao_estado='completa' AND consentimento_em IS NOT NULL AND direitos_revogados_em IS NULL AND excluida_em IS NULL").run(id,revisaoReservada);
        if(final.changes!==1)throw erro('CONFLITO','Sessão mudou durante a transcrição.');
        this.db.exec('RELEASE notetaker_publicar_job');
      }catch(e){this.db.exec('ROLLBACK TO notetaker_publicar_job;RELEASE notetaker_publicar_job');throw e;}
      return {estado:'concluida',partes:partes.length,trechos};
    }catch(e){
      if(this.signal?.aborted)throw erro('CANCELADO','Transcrição cancelada pela manutenção.');
      if(!reservada)throw e;
      this.db.prepare("UPDATE notetaker_sessoes SET asr_estado='falha' WHERE id=? AND revisao=? AND asr_estado='em_curso'").run(id,revisaoReservada);
      return {estado:'falha',mensagem:'Transcrição local falhou; original preservado.'};
    }finally{asrAtivo=false;}
  }
  fonte(eventoId){
    const f=this.db.prepare('SELECT f.*,e.texto FROM notetaker_fontes f JOIN eventos e ON e.id=f.evento_id WHERE f.evento_id=?').get(eventoId);
    if(!f)throw erro('AUSENTE','Fonte não encontrada.');const s=this.autorizada(f.sessao_id);
    if(s.asr_estado!=='concluida')throw erro('AUSENTE','Fonte não publicada.');
    const p=this.db.prepare('SELECT id,caminho,sha256,estado FROM notetaker_partes WHERE id=?').get(f.parte_id);
    try{if(!p||p.estado!=='salva'||p.sha256!==f.audio_sha256||p.caminho!==p.id+'.wav'||sha(lerArquivoRegular(join(this.audioRoot,p.caminho)))!==f.audio_sha256)throw Error();}
    catch{throw erro('INTEGRIDADE','Original indisponível; fonte sem selo de áudio.');}
    return {eventoId:f.evento_id,sessaoId:f.sessao_id,parteId:f.parte_id,inicioMs:f.inicio_ms,fimMs:f.fim_ms,audioSha256:f.audio_sha256,texto:f.texto,autoria:'Autoria não identificada'};
  }
}
