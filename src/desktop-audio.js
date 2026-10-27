import {LEITURA_SQL} from './leitura-sql.js';
import {IA_SQL} from './recuperacao.js';
import {prepararEsquemaTranscricao} from './transcricao.js';
import {MODELO_DESKTOP,chamarGemini} from './gemini-desktop.js';
import {decodificarAudio,validarAudioWav,pedidoTranscricao,reservaAudioMicros,conferirTranscricao,PRECO_AUDIO} from './audio-desktop-contrato.js';
import {AudioArquivos} from './audio-desktop-arquivos.js';
import {readFileSync,statSync} from 'node:fs';
import {MAX_BYTES_AUDIO} from './audio-desktop-contrato.js';
import {baixarAudioWhatsapp} from './audio-whatsapp.js';
import {assinaturaFonte} from './tarefas-esquema.js';
import {randomUUID,createHash} from 'node:crypto';
import {criarAudioLocalRuntime} from './audio-local-runtime.js';
import {validarMetadadosAudio} from './audio-desktop-arquivos.js';

export class DesktopAudio {
  constructor(db,{ia,arquivos,gerar=chamarGemini,baixar=baixarAudioWhatsapp,audioLocal=criarAudioLocalRuntime(),agora=()=>new Date()}={}){
    this.db=db;this.ia=ia;this.gerar=gerar;this.ativo=false;
    this.audioLocal=audioLocal;this.agora=agora;this.previaLocal=null;this.operacaoLocal=null;this.preparandoLocal=null;
    prepararEsquemaTranscricao(db);this.arquivos=arquivos?new AudioArquivos(db,arquivos):null;
    this.limpeza=this.arquivos?.recuperar()||{pendentes:0};
    this.baixador=baixar;this.downloads=new Map();
  }
  async baixar({fonte}={}){
    if(!Number.isSafeInteger(fonte)||fonte<1)throw new Error('Fonte inválida.');
    if(this.downloads.size||this.ativo||this.preparandoLocal)throw new Error('Aguarde ou cancele a operação de áudio.');
    this._limparPrevias();
    const ler=()=>this.db.prepare(`SELECT e.* FROM desktop_fontes e WHERE e.id=? AND e.tipo='audio' AND ${LEITURA_SQL}`).get(fonte),evento=ler();
    if(!evento)throw new Error('Áudio indisponível ou revogado.');
    const id='download:'+fonte,controller=new AbortController();this.downloads.set(id,controller);this.ia?.ativos.add(controller);
    try{
      const result=await this.baixador(evento.bruto,{signal:controller.signal});const atual=ler();
      if(controller.signal.aborted||!atual||atual.bruto!==evento.bruto||assinaturaFonte(atual)!==assinaturaFonte(evento))throw new Error('Download cancelado ou fonte alterada.');
      return result;
    }finally{this.downloads.delete(id);this.ia?.ativos.delete(controller);}
  }
  ler({fonte}={}){
    if(!this.arquivos||!Number.isSafeInteger(fonte)||fonte<1)throw new Error('Áudio local indisponível.');
    const row=this.db.prepare(`SELECT t.arquivo FROM desktop_fontes e JOIN transcricoes t ON t.conversa_id=e.conversa_id AND t.origem_id=e.origem_id WHERE e.id=? AND e.tipo='audio' AND ${LEITURA_SQL}`).get(fonte);
    if(!row?.arquivo)throw new Error('Este áudio ainda não tem arquivo local. Selecione o arquivo da mensagem.');
    try{
      const path=this.arquivos.arquivos.conferir(row.arquivo);
      if(statSync(path).size>MAX_BYTES_AUDIO)throw new Error('Áudio local excede o limite.');
      const bytes=readFileSync(path);validarAudioWav(bytes);return {base64:bytes.toString('base64'),nome:'Áudio desta fonte.wav'};
    }catch{throw new Error('Não consegui abrir o áudio gerido desta fonte. Selecione o arquivo da mensagem.');}
  }
  async estado(){
    const local=await this.audioLocal.estado();
    let gemini;try{gemini=await this.ia?.estado();}catch{}
    return {padrao:'local',ocupado:Boolean(this.ativo||this.preparandoLocal||this.downloads.size),
      operacaoId:this.operacaoLocal?.id??this.preparandoLocal?.id??this.previaLocal?.id??null,
      motores:{local,gemini:{disponivel:Boolean(gemini?.habilitada&&gemini?.chaveConfigurada),motor:'gemini',modelo:MODELO_DESKTOP,
        privacidade:'envio_google',preco:PRECO_AUDIO,motivo:'Exige configuração, autorização da conversa e confirmação de envio ao Google.'}}};
  }
  _limparPrevias(){
    if(this.previaLocal){this.previaLocal.controller.abort();this.previaLocal=null;}
    for(const [id,p]of this.ia?.previas||[])if(p.tipo==='audio')this.ia.cancelar({id});
  }
  _fonteLocal(id){return this.db.prepare(`SELECT e.*,COALESCE(c.nome,e.conversa_id) conversa_nome FROM desktop_fontes e
    LEFT JOIN conversas_app c ON c.id=e.conversa_id WHERE e.id=? AND e.tipo='audio' AND ${LEITURA_SQL}`).get(id);}
  _conferirLocal(p){
    if(p.controller.signal.aborted)throw new Error('Transcrição local cancelada.');
    if(p.revisaoIA!==this.ia?.config().revisao)throw new Error('Permissão mudou. Prepare outra transcrição local.');
    if(this.agora().getTime()>p.expira)throw new Error('Prévia local expirou. Prepare outra transcrição.');
    const e=this._fonteLocal(p.fonte);
    const t=e?this.db.prepare('SELECT * FROM transcricoes WHERE conversa_id=? AND origem_id=?').get(e.conversa_id,e.origem_id):null;
    if(!e||assinaturaFonte(e)!==p.assinatura||e.bruto!==p.bruto||JSON.stringify(t??null)!==p.transcricaoAnterior)throw new Error('Fonte mudou ou foi revogada. Prepare outra transcrição.');
    return e;
  }
  preparar({fonte,base64,nome,confirmarVinculo,motor='gemini',...extras}={}){
    if(Object.keys(extras).length)throw new Error('Parâmetros de áudio não permitidos. Caminhos e configuração pertencem ao desktop.');
    if(!['local','gemini'].includes(motor))throw new Error('Escolha o motor local ou Gemini.');
    if(!this.arquivos)throw new Error('Abra o perfil desktop com armazenamento de anexos.');
    if(this.limpeza.pendentes)throw new Error('Há arquivos de áudio pendentes. Retome a limpeza em Configurações antes de transcrever.');
    if(this.ativo||this.preparandoLocal||this.downloads.size)throw new Error('Aguarde ou cancele a transcrição em andamento.');
    if(!Number.isSafeInteger(fonte)||fonte<1||typeof nome!=='string'||!nome.trim()||nome.length>200||/[\x00-\x1f]/.test(nome)||confirmarVinculo!==true)throw new Error('Confira o arquivo e confirme que ele corresponde ao áudio desta mensagem.');
    if(motor==='local')return this._prepararLocal({fonte,base64,nome});
    const evento=this.db.prepare(`SELECT e.*,COALESCE(c.nome,e.conversa_id) conversa_nome FROM desktop_fontes e LEFT JOIN conversas_app c ON c.id=e.conversa_id WHERE e.id=? AND e.tipo='audio' AND ${LEITURA_SQL} AND ${IA_SQL}`).get(fonte);
    if(!evento)throw new Error('Áudio indisponível ou conversa sem autorização de IA.');
    const bytes=decodificarAudio(base64),meta=validarAudioWav(bytes);
    // Uma prévia de áudio por perfil; substituição libera bytes anteriores da memória.
    this._limparPrevias();
    const p=this.ia.registrarOperacao({eventos:[evento],fontes:[{id:evento.id,conversa_id:evento.conversa_id,origem_id:evento.origem_id,conversa_nome:evento.conversa_nome,recebido_em:evento.recebido_em}],pedido:pedidoTranscricao(bytes),tipo:'audio',reservaMicros:reservaAudioMicros(bytes)});
    return {...p,motor:'gemini',nome,...meta,substitui:Boolean(evento.transcricao_meta),preco:PRECO_AUDIO,aviso:'Ao confirmar, este áudio será enviado ao Google e uma cópia PCM será guardada neste perfil. A transcrição anterior só será substituída em caso de sucesso. Não há reenvio automático.'};
  }
  async _prepararLocal({fonte,base64,nome}){
    const e=this._fonteLocal(fonte);if(!e)throw new Error('Áudio indisponível ou revogado.');
    const bytes=decodificarAudio(base64),meta=validarAudioWav(bytes),controller=new AbortController();
    const anterior=this.db.prepare('SELECT * FROM transcricoes WHERE conversa_id=? AND origem_id=?').get(e.conversa_id,e.origem_id);
    const p={id:'local:'+randomUUID(),fonte,bytes,nome,meta,controller,expira:this.agora().getTime()+300000,
      assinatura:assinaturaFonte(e),bruto:e.bruto,transcricaoAnterior:JSON.stringify(anterior??null),revisaoIA:this.ia?.config().revisao};
    this._limparPrevias();this.preparandoLocal=p;this.ia?.ativos.add(controller);
    try{
      this._conferirLocal(p);const estado=await this.audioLocal.estado({signal:controller.signal});this._conferirLocal(p);
      if(!estado.disponivel)throw new Error(estado.motivo||'Motor local indisponível.');
      p.runtime=Object.freeze({...estado});this.previaLocal=p;
      return {id:p.id,motor:'local',nome,...meta,expiraEm:new Date(p.expira).toISOString(),reservaUSD:0,modelo:estado.modelo,
        qualidade:'nao_validada',privacidade:'local',substitui:Boolean(anterior),
        fontes:[{id:e.id,conversa_id:e.conversa_id,origem_id:e.origem_id,conversa_nome:e.conversa_nome,recebido_em:e.recebido_em}],
        aviso:'Transcrição local experimental. O áudio fica neste computador; confira nomes, valores e prazos. A versão anterior só será substituída após sucesso.'};
    }finally{this.preparandoLocal=null;this.ia?.ativos.delete(controller);}
  }
  cancelar(data){
    for(const p of [this.previaLocal,this.preparandoLocal,this.operacaoLocal])if(p&&p.id===data?.id){p.controller.abort();if(p===this.previaLocal)this.previaLocal=null;return {cancelada:true,aviso:'Transcrição local cancelada. Nenhum áudio foi enviado a um provedor externo.'};}
    const c=this.downloads.get(data?.id);if(c){c.abort();return {cancelada:true,aviso:'Download cancelado. Nenhum áudio foi enviado ao Google.'};}
    return this.ia?.cancelar(data)??{cancelada:false,aviso:'Operação local ausente ou já encerrada.'};
  }
  async transcrever(data={}){
    if(Object.keys(data).some(k=>!['id','confirmar'].includes(k)))throw new Error('Confirme somente a prévia escolhida, sem trocar motor ou configuração.');
    if(this.ativo||this.preparandoLocal||this.downloads.size)throw new Error('Já há uma transcrição em andamento.');
    if(typeof data.id==='string'&&data.id.startsWith('local:'))return this._transcreverLocal(data);
    this.ativo=true;
    try{return await this.ia.executarOperacao(data,{tipo:'audio',gerar:this.gerar,conferirResultado:conferirTranscricao,finalizar:(original,previa)=>{
      const f=previa.fontes[0],evento=this.db.prepare('SELECT * FROM desktop_fontes WHERE id=?').get(f.id);
      const bytes=decodificarAudio(previa.pedido.contents[0].parts[0].inlineData.data);
      const storage=this.arquivos.salvar({evento,bytes,original,modelo:MODELO_DESKTOP,conferir:()=>this.ia.conferir(previa)});
      return {fonte:f.id,motor:'gemini',...storage,reservaUSD:previa.reserva/1e6,aviso:'Transcrição guardada. Confira o texto e o original; o modelo pode errar.'};
    }});}finally{this.ativo=false;}
  }
  async _transcreverLocal({id,confirmar}){
    if(confirmar!==true)throw new Error('Confirme a transcrição local apresentada.');
    const p=this.previaLocal;if(!p||p.id!==id)throw new Error('Prévia local ausente ou já utilizada.');
    this.previaLocal=null;this.ativo=true;this.operacaoLocal=p;this.ia?.ativos.add(p.controller);
    try{
      this._conferirLocal(p);p.confirmadoEm=this.agora().toISOString();p.expira=this.agora().getTime()+600000;
      const r=await this.audioLocal.transcrever(p.bytes,{signal:p.controller.signal});
      const e=this._conferirLocal(p),audioSha256=createHash('sha256').update(p.bytes).digest('hex');
      if(r.audioSha256!==audioSha256||r.modeloSha256!==p.runtime.modeloSha256||r.manifestoSha256!==p.runtime.manifestoSha256||r.versaoMotor!==p.runtime.versaoMotor)throw new Error('O motor ou áudio mudou desde a prévia. Prepare outra transcrição.');
      const metadados={versao:1,motor:'whisper.cpp',versaoMotor:r.versaoMotor,origem:'local',idioma:r.idioma,qualidade:'nao_validada',
        audioSha256,modeloSha256:r.modeloSha256,manifestoSha256:r.manifestoSha256,trechos:r.trechos,duracaoAudioMs:p.meta.segundos*1000,
        fonte:{conversaId:e.conversa_id,origemId:e.origem_id,assinatura:p.assinatura},
        consentimento:{tipo:'processamento_local',confirmadoEm:p.confirmadoEm,vinculoConfirmado:true}};
      if(['analiseSinal','inferenciaExecutada','motivoSemFala'].some(k=>Object.hasOwn(r,k))){
        metadados.analiseSinal=r.analiseSinal;metadados.inferenciaExecutada=r.inferenciaExecutada;
        if(Object.hasOwn(r,'motivoSemFala'))metadados.motivoSemFala=r.motivoSemFala;
      }
      validarMetadadosAudio(metadados);
      if(r.transcricao!==r.trechos.map(t=>t.texto.trim()).join(' '))throw new Error('Texto local diverge dos trechos.');
      const original=r.trechos.length?r.transcricao:'(sem fala)';
      const storage=this.arquivos.salvar({evento:e,bytes:p.bytes,original,modelo:'whisper.cpp/'+r.versaoMotor,
        metadados,duracaoMs:r.duracaoMs,conferir:()=>this._conferirLocal(p)});
      return {fonte:p.fonte,motor:'local',...storage,reservaUSD:0,qualidade:'nao_validada',metadados,
        aviso:r.motivoSemFala==='silencio_digital_pcm_zero'?'O arquivo contém somente silêncio digital. Nenhuma inferência foi executada. Confira se escolheu o áudio certo.':
          r.motivoSemFala==='motor_sem_trechos'?'O motor não retornou fala. Isso não comprova silêncio: confira o áudio original.':
          'Transcrição local guardada. Qualidade ainda não validada: confira o áudio, especialmente nomes, valores e prazos.'};
    }finally{this.ativo=false;this.operacaoLocal=null;this.ia?.ativos.delete(p.controller);p.bytes=null;}
  }
}
