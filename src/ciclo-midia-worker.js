import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,unlinkSync,readdirSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {baixarMidiaWhatsapp,MAX_AUDIO_DOWNLOAD,EXT_ORIGINAIS_WHATSAPP} from './audio-whatsapp.js';
import {prepararEsquemaTranscricao} from './transcricao.js';
import {extrairDocumento} from './pessoal/documentos-leitor.js';
import {reclamarEtapaCiclo,concluirEtapaCiclo,falharMidiaCiclo,devolverEtapaCiclo,bloquearMidiaSemSuporteCiclo} from './ciclo-captura.js';

export const EXT_MIDIA_CICLO=EXT_ORIGINAIS_WHATSAPP;
const NOME=/^ciclo-midia-\d+-[a-f0-9-]{36}\.(ogg|m4a|mp3|wav|aac|amr|flac|jpg|png|webp|gif|pdf|txt|docx|xlsx|bin)$/;
const invalida=message=>Object.assign(new Error(message),{codigo:'metadados_invalidos'});

export function prepararMidiasCiclo(db){
  db.exec(`CREATE TABLE IF NOT EXISTS ciclo_midias (
    evento_id INTEGER PRIMARY KEY REFERENCES eventos(id) ON DELETE CASCADE,
    caminho TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,mime TEXT NOT NULL,
    tamanho INTEGER NOT NULL,criado_em TEXT NOT NULL)`);
  prepararEsquemaTranscricao(db);
  // Reuse the durable text-overlay table. The explicit model prefix separates
  // document extraction from speech and keeps existing indexes/privacy coverage.
  // Source invalidation and FTS are ordered together by prepararFontes, invoked
  // by prepararEsquemaTranscricao; independent AFTER UPDATE triggers are unsafe.
}

// O banco guarda a referência estável ao original. O arquivo nasce antes do
// recibo da etapa; falha/revogação o remove, e recuperar() recolhe órfãos de
// um crash depois que não houver writer com lease válido.
export class MidiaArquivos{
  constructor(db,arquivos){
    this.db=db;this.arquivos=arquivos;
    prepararMidiasCiclo(db);
  }
  listar(){
    if(!existsSync(this.arquivos.anexos))return [];
    return readdirSync(this.arquivos.anexos).filter(n=>NOME.test(n))
      .map(n=>this.arquivos.conferir(join(this.arquivos.anexos,n)));
  }
  recuperar({agora=new Date(),idadeMs=3600000}={}){
    const limite=agora.getTime()-idadeMs;
    let removidos=0;
    for(const path of this.listar()){
      if(this.db.prepare('SELECT 1 FROM ciclo_midias WHERE caminho=?').get(path))continue;
      const id=Number(/^ciclo-midia-(\d+)-/.exec(path.split(/[\\/]/).at(-1))?.[1]);
      const lease=this.db.prepare("SELECT lease_ate FROM etapas WHERE evento_id=? AND etapa='midia' AND estado='em_curso'").get(id)?.lease_ate;
      if(lease&&Date.parse(lease)>agora.getTime())continue;
      const {mtimeMs}=statSync(path);
      if(mtimeMs>limite)continue;
      unlinkSync(path);removidos++;
    }
    return {removidos};
  }
  salvar(claim,result,{agora=new Date()}={}){
    if(claim?.etapa!=='midia'||!Number.isSafeInteger(claim.eventoId))throw new TypeError('Claim de mídia inválido');
    const mime=String(result?.mime||'').toLowerCase(),ext=EXT_MIDIA_CICLO[mime];
    if(!ext||typeof result.base64!=='string'||!result.base64||!/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64))throw invalida('Mídia inválida');
    const bytes=Buffer.from(result.base64,'base64');
    if(!bytes.length||bytes.length>MAX_AUDIO_DOWNLOAD||bytes.toString('base64')!==result.base64)throw invalida('Limite ou codificação de mídia inválida');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    mkdirSync(this.arquivos.anexos,{recursive:true});
    const path=this.arquivos.conferir(join(this.arquivos.anexos,`ciclo-midia-${claim.eventoId}-${randomUUID()}.${ext}`));
    try{
      writeFileSync(path,bytes,{flag:'wx',mode:0o600});
      const receipt=concluirEtapaCiclo(this.db,claim,{agora,
        resultado:{sha256,mime,tamanho:bytes.length,...(result.extracao?{extracao:{estado:result.extracao.estado,paginas:result.extracao.paginas,truncado:result.extracao.truncado,motivo:result.extracao.motivo??null}}:{})},
        apply:(db,row)=>{
          if(!['audio','imagem','documento'].includes(row.tipo)||row.tipo==='audio'&&!mime.startsWith('audio/')||row.tipo==='imagem'&&!mime.startsWith('image/')||row.tipo==='documento'&&/^(audio|image)\//.test(mime))throw new Error('Tipo do original não corresponde à fonte');
          db.prepare(`INSERT INTO ciclo_midias(evento_id,caminho,sha256,mime,tamanho,criado_em)
            VALUES(?,?,?,?,?,?)`).run(row.id,path,sha256,mime,bytes.length,agora.toISOString());
          if(row.tipo==='documento'&&result.extracao){
            const x=result.extracao;
            if(!['extraido','sem_texto','indisponivel'].includes(x.estado)||typeof x.texto!=='string'||x.texto.length>24000||typeof x.truncado!=='boolean')throw invalida('Extração inválida');
            db.prepare(`INSERT INTO transcricoes(conversa_id,origem_id,quando,texto,estado,motivo,modelo,criado_em)
              VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(conversa_id,origem_id) DO UPDATE SET quando=excluded.quando,texto=excluded.texto,
              estado=excluded.estado,motivo=excluded.motivo,modelo=excluded.modelo,criado_em=excluded.criado_em,texto_original=NULL,respostas_json=NULL`)
              .run(row.conversa_id,row.origem_id,row.recebido_em,x.texto||null,x.estado==='extraido'?'transcrito':x.estado==='sem_texto'?'vazio':'erro',
                x.motivo??null,'documento-local:'+(mime==='application/pdf'?'pdfjs-6.4.299':'texto')+(x.truncado?':parcial':''),agora.toISOString());
          }
        }});
      if(receipt.estado!=='concluida'&&existsSync(path))unlinkSync(path);
      return receipt;
    }catch(error){if(existsSync(path))unlinkSync(path);throw error;}
  }
}

// Executa no máximo uma fonte por chamada, para manter uso de RAM e rede previsível.
const documentosAtivos=new WeakSet();
export async function processarUmaMidiaCiclo(db,{arquivos,baixar=baixarMidiaWhatsapp,extrair=extrairDocumento,agora=new Date(),cursor=0,signal,podeProcessar=()=>true}={}){
  if(!(arquivos instanceof MidiaArquivos))throw new TypeError('Armazenamento de mídia ausente');
  if(signal?.aborted||!podeProcessar()||documentosAtivos.has(db))return null;
  const inicio=performance.now(),instanteAtual=()=>new Date(agora.getTime()+performance.now()-inicio);
  const claim=reclamarEtapaCiclo(db,'midia',{agora,cursor});
  if(!claim)return null;
  if(claim.estado==='continuar')return claim;
  if(signal?.aborted||!podeProcessar()){
    devolverEtapaCiclo(db,claim,{agora});return null;
  }
  const row=db.prepare('SELECT bruto,tipo FROM eventos WHERE id=?').get(claim.eventoId);
  if(!['audio','imagem','documento'].includes(row?.tipo))return bloquearMidiaSemSuporteCiclo(db,claim,{agora:instanteAtual()});
  if(row.tipo==='documento')documentosAtivos.add(db);
  let baixou=false;
  try{
    const downloadSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
    const result=await baixar(row.bruto,{signal:downloadSignal,tipo:row.tipo});
    downloadSignal.throwIfAborted();
    if(signal?.aborted||!podeProcessar()){
      devolverEtapaCiclo(db,claim,{agora:instanteAtual()});return null;
    }
    baixou=true;
    if(row.tipo==='documento')result.extracao=await extrair({bytes:Buffer.from(result.base64,'base64'),mime:result.mime,signal:downloadSignal});
    downloadSignal.throwIfAborted();
    if(signal?.aborted||!podeProcessar()){devolverEtapaCiclo(db,claim,{agora:instanteAtual()});return null;}
    return arquivos.salvar(claim,result,{agora:instanteAtual()});
  }catch(error){
    if(signal?.aborted||!podeProcessar()){
      devolverEtapaCiclo(db,claim,{agora:instanteAtual()});return null;
    }
    const codigo=baixou?(error?.codigo==='metadados_invalidos'?'metadados_invalidos':
      ['ENOSPC','EDQUOT'].includes(error?.code)?'espaco':'arquivo'):
      ['midia_expirada','metadados_invalidos','host_recusado','limite_audio'].includes(error?.codigo)?error.codigo:'rede';
    const changed=falharMidiaCiclo(db,claim,{agora:instanteAtual(),motivo:codigo});
    return {estado:changed?db.prepare("SELECT estado FROM etapas WHERE evento_id=? AND etapa='midia'").get(claim.eventoId).estado:'posse_perdida',motivo:codigo};
  }finally{if(row.tipo==='documento')documentosAtivos.delete(db);}
}
