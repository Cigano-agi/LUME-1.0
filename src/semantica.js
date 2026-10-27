import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { LEITURA_SQL, IA_SQL } from './recuperacao.js';
import {prepararFontes} from './fontes-desktop.js';
import {assinaturaFonte} from './tarefas-esquema.js';

export const MODELO_SEMANTICO = 'Xenova/multilingual-e5-small';
export const REVISAO_SEMANTICA = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const VERSAO = MODELO_SEMANTICO + '@' + REVISAO_SEMANTICA + ':q8:chunks1200-150';
const hashTexto = s => createHash('sha256').update(s).digest('hex');
export function fragmentar(texto, tamanho = 1200, sobreposicao = 150) {
  if(typeof texto!=='string'||!Number.isSafeInteger(tamanho)||tamanho<1||!Number.isSafeInteger(sobreposicao)||sobreposicao<0||sobreposicao>=tamanho)throw new Error('Configuração de fragmento inválida.');
  const chunks = [];
  for (let inicio=0; inicio<texto.length;) {
    const fim = Math.min(texto.length,inicio+tamanho);
    const text = texto.slice(inicio,fim);
    if (text.trim()) chunks.push({ inicio, fim, texto: text });
    if (fim === texto.length) break;
    inicio = fim-sobreposicao;
  }
  return chunks;
}
function vectorBuffer(v) { return Buffer.from(new Float32Array(v).buffer); }
function lerVetor(bytes) { return new Float32Array(Uint8Array.from(bytes).buffer); }
export function similaridade(a,b) {
  if (a.length!==b.length) throw new Error('Dimensões de vetores incompatíveis.');
  let value=0; for(let i=0;i<a.length;i++) value+=a[i]*b[i]; return value;
}
export function fundirRankings(lexical,denso,limite=12) {
  const rows=new Map();
  for(const lista of [lexical,denso]) lista.forEach((e,i)=>{const old=rows.get(e.id);rows.set(e.id,{...(old||e),...(e.trecho ? {trecho:e.trecho,inicio:e.inicio}:{}),rrf:(old?.rrf||0)+1/(60+i+1)});});
  return [...rows.values()].sort((a,b)=>b.rrf-a.rrf || b.id-a.id).slice(0,limite);
}

export class Semantica {
  constructor(db,{cacheDir,extrair}={}) {
    this.db=db;this.cacheDir=cacheDir;this.extrair=extrair;this.pipeline=null;this.carregando=null;this.trabalhando=false;this.revisaoAtivacao=0;this.interrompida=false;
    this.pendentes=new Set();this.encerramento=null;this.pipelineParaDescarte=null;
    this.erroEncerramento=new Error('Semântica encerrada.');
    this.progresso={etapa:'desativada',arquivo:null,percentual:null,erro:null};
    db.exec(`CREATE TABLE IF NOT EXISTS desktop_vetores (
      evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE, pedaco INTEGER NOT NULL, inicio INTEGER NOT NULL, fim INTEGER NOT NULL,
      hash TEXT NOT NULL, modelo TEXT NOT NULL, vetor BLOB NOT NULL, PRIMARY KEY(evento_id,pedaco));
      CREATE INDEX IF NOT EXISTS desktop_vetores_modelo ON desktop_vetores(modelo,evento_id);
      CREATE TRIGGER IF NOT EXISTS desktop_vetores_update AFTER UPDATE OF texto ON eventos BEGIN DELETE FROM desktop_vetores WHERE evento_id=new.id; END;
      CREATE TABLE IF NOT EXISTS desktop_semantica_config(id INTEGER PRIMARY KEY CHECK(id=1),ativa INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO desktop_semantica_config(id) VALUES(1);`);
    prepararFontes(db);
  }
  estado() {
    const total=this.db.prepare(`SELECT COUNT(*) n FROM desktop_fontes e WHERE ${LEITURA_SQL} AND e.texto IS NOT NULL AND trim(e.texto)<>''`).get().n;
    const indexados=this.db.prepare(`SELECT COUNT(DISTINCT v.evento_id) n FROM desktop_vetores v JOIN desktop_fontes e ON e.id=v.evento_id WHERE v.modelo=? AND ${LEITURA_SQL}`).get(VERSAO).n;
    return {ativa:Boolean(this.db.prepare('SELECT ativa FROM desktop_semantica_config').get().ativa),pronta:Boolean(this.pipeline||this.extrair),total,indexados,pendentes:total-indexados,modelo:MODELO_SEMANTICO,revisao:REVISAO_SEMANTICA,...this.progresso};
  }
  #acompanhar(executar) {
    if(this.interrompida)return Promise.reject(this.erroEncerramento);
    let trabalho;
    try { trabalho=Promise.resolve(executar()); }
    catch(error) { trabalho=Promise.reject(error); }
    this.pendentes.add(trabalho);
    trabalho.then(()=>this.pendentes.delete(trabalho),()=>this.pendentes.delete(trabalho));
    return trabalho;
  }
  carregar(opcoes={}) {return this.#acompanhar(()=>this.#carregarInterno(opcoes));}
  async #carregarInterno({baixar=false}={}) {
    if(this.pipeline||this.extrair)return;
    if(this.carregando)return this.carregando;
    if(!this.cacheDir)throw new Error('Diretório local do modelo não configurado.');
    this.carregando=(async()=>{
      this.progresso={etapa:baixar?'baixando':'carregando',arquivo:null,percentual:null,erro:null};
      try {
        mkdirSync(this.cacheDir,{recursive:true});
        const {pipeline}=await import('@huggingface/transformers');
        if(this.interrompida)throw this.erroEncerramento;
        // transformers 4.3.0 metadata probes omit local_files_only/cache/revision,
        // including inside AutoTokenizer. An absolute directory cannot resolve
        // as a remote model ID; all offline reads use this pinned cache revision.
        const origem=baixar?MODELO_SEMANTICO:resolve(this.cacheDir,MODELO_SEMANTICO,REVISAO_SEMANTICA);
        const carregado=await pipeline('feature-extraction',origem,{revision:REVISAO_SEMANTICA,dtype:'q8',device:'cpu',cache_dir:this.cacheDir,local_files_only:!baixar,
          progress_callback:p=>{if(this.interrompida)return;if(p.file)this.progresso.arquivo=p.file;if(p.progress!=null)this.progresso.percentual=Math.round(p.progress);}});
        if(this.interrompida){this.pipelineParaDescarte=carregado;throw this.erroEncerramento;}
        this.pipeline=carregado;
        this.progresso={etapa:'pronta',arquivo:null,percentual:100,erro:null};
      }catch(error){if(error!==this.erroEncerramento)this.progresso={etapa:'falha',arquivo:null,percentual:null,erro:'Não foi possível carregar o modelo local. Verifique conexão, espaço e permissão de execução.'};throw error;}
      finally{this.carregando=null;}
    })();
    return this.carregando;
  }
  vetor(texto,tipo='passage') {return this.#acompanhar(()=>this.#vetorInterno(texto,tipo));}
  async #vetorInterno(texto,tipo='passage') {
    if(this.extrair)return this.extrair(texto,tipo);
    if(!this.pipeline)throw new Error('O modelo de significado ainda não está pronto.');
    const result=await this.pipeline(`${tipo}: ${texto}`,{pooling:'mean',normalize:true,truncation:true,max_length:512});
    return Array.from(result.data);
  }
  ativa(){return !this.interrompida && Boolean(this.db.prepare('SELECT ativa FROM desktop_semantica_config').get().ativa);}
  pronta(){return !this.interrompida&&Boolean(this.pipeline||this.extrair);}
  encerrar(){
    if(this.encerramento)return this.encerramento;
    this.interrompida=true;this.revisaoAtivacao++;
    this.encerramento=(async()=>{
      await Promise.allSettled([...this.pendentes]);
      const erros=[];
      const pipeline=this.pipeline||this.pipelineParaDescarte;
      this.pipeline=null;this.pipelineParaDescarte=null;
      if(pipeline?.dispose){try {await pipeline.dispose();}catch(error){erros.push(error);}}
      if(erros.length)throw new AggregateError(erros,'Falha ao encerrar semântica.');
    })();
    return this.encerramento;
  }
  pausar() {if(this.interrompida)throw this.erroEncerramento;this.revisaoAtivacao++;this.db.prepare('UPDATE desktop_semantica_config SET ativa=0').run();this.progresso.etapa='pausada';return this.estado();}
  ativar(opcoes={}) {return this.#acompanhar(()=>this.#ativarInterno(opcoes));}
  async #ativarInterno({baixar=false}={}) {const revisao=++this.revisaoAtivacao;await this.#carregarInterno({baixar});if(this.interrompida)throw this.erroEncerramento;if(revisao!==this.revisaoAtivacao)throw new Error('Ativação cancelada.');this.db.prepare('UPDATE desktop_semantica_config SET ativa=1').run();return this.estado();}
  indexar(opcoes={}) {return this.#acompanhar(()=>this.#indexarInterno(opcoes));}
  async #indexarInterno({limite=10}={}) {
    if(this.trabalhando||!this.ativa())return this.estado();
    this.trabalhando=true;
    try {
      if(!this.pipeline&&!this.extrair)await this.#carregarInterno();
      if(this.interrompida)throw this.erroEncerramento;
      this.progresso.erro=null;
      const rows=this.db.prepare(`SELECT e.* FROM desktop_fontes e WHERE ${LEITURA_SQL} AND e.texto IS NOT NULL AND trim(e.texto)<>''
        AND NOT EXISTS(SELECT 1 FROM desktop_vetores v WHERE v.evento_id=e.id AND v.modelo=?) ORDER BY e.id DESC LIMIT ?`).all(VERSAO,limite);
      for(const e of rows) {
        if(!this.ativa())break;
        this.progresso.etapa='indexando';
        const chunks=fragmentar(e.texto),vectors=[];
        for(const chunk of chunks) {if(!this.ativa())break;vectors.push(await this.#vetorInterno(chunk.texto));}
        if(this.interrompida)throw this.erroEncerramento;
        if(vectors.length!==chunks.length||!this.ativa())break;
        // Reconfere após inferência assíncrona: exclusão/revogação não recria derivados.
        const atual=this.db.prepare(`SELECT e.* FROM desktop_fontes e WHERE e.id=? AND ${LEITURA_SQL}`).get(e.id);
        if(!atual||assinaturaFonte(atual)!==assinaturaFonte(e))continue;
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('DELETE FROM desktop_vetores WHERE evento_id=?').run(e.id);
          const ins=this.db.prepare('INSERT INTO desktop_vetores VALUES(?,?,?,?,?,?,?)');
          chunks.forEach((c,i)=>ins.run(e.id,i,c.inicio,c.fim,hashTexto(e.texto),VERSAO,vectorBuffer(vectors[i])));
          this.db.exec('COMMIT');
        }catch(err){this.db.exec('ROLLBACK');throw err;}
      }
      if(this.interrompida)throw this.erroEncerramento;
      this.progresso.etapa=this.estado().ativa?'pronta':'pausada';return this.estado();
    }catch(error){if(!this.interrompida){this.db.prepare('UPDATE desktop_semantica_config SET ativa=0').run();this.progresso.etapa='falha';this.progresso.erro='A indexação local parou. Ative novamente após corrigir a causa; a busca textual continua disponível.';}throw error;}
    finally{this.trabalhando=false;}
  }
  buscar(filtro,opcoes={}) {return this.#acompanhar(()=>this.#buscarInterno(filtro,opcoes));}
  async #buscarInterno(filtro,{limite=20,remoto=true,limiteVetores=null}={}) {
    if(limiteVetores!==null&&(!Number.isSafeInteger(limiteVetores)||limiteVetores<1||limiteVetores>2000))throw new Error('Janela semântica inválida.');
    if(!this.estado().ativa)throw new Error('Ative a busca por significado em Configurações ou escolha busca textual.');
    if(!this.pipeline&&!this.extrair)await this.#carregarInterno();
    if(this.interrompida)throw this.erroEncerramento;
    const query=await this.#vetorInterno(filtro.pergunta,'query');
    if(this.interrompida)throw this.erroEncerramento;
    if(!this.ativa())throw new Error('Busca por significado pausada.');
    // ACL antes de ler vetores, calcular distâncias e cortar top-k.
    const where=[LEITURA_SQL,'v.modelo=?','e.dia_local<=?'],args=[VERSAO,filtro.ate];
    if(remoto)where.push(IA_SQL);
    if(filtro.desde){where.push('e.dia_local>=?');args.push(filtro.desde);}
    if(filtro.conversa){where.push('e.conversa_id=?');args.push(filtro.conversa);}
    if(filtro.projeto){where.push(PROJETO_SQL);args.push(filtro.projeto,filtro.projeto,filtro.projeto);}
    const ranked=[];
    const janela=limiteVetores===null?'':' ORDER BY e.recebido_em DESC,e.id DESC,v.pedaco LIMIT ?';
    for(const row of this.db.prepare(`SELECT e.id,v.inicio,v.fim,v.vetor FROM desktop_vetores v JOIN desktop_fontes e ON e.id=v.evento_id WHERE ${where.join(' AND ')}${janela}`).iterate(...args,...(limiteVetores===null?[]:[limiteVetores]))) {
      const score=similaridade(query,lerVetor(row.vetor));
      ranked.push({id:row.id,inicio:row.inicio,fim:row.fim,score});
    }
    ranked.sort((a,b)=>b.score-a.score || b.id-a.id);
    const ids=new Set(),result=[];
    for(const hit of ranked){
      if(ids.has(hit.id))continue;ids.add(hit.id);
      const row=this.db.prepare(`SELECT e.id,e.tipo,e.conversa_id,e.origem_id,e.texto,e.transcricao_meta,e.recebido_em,e.permissao,e.projeto_id,e.origem_compartilhamento,e.autor_id,e.autor_e_dono,v.hash vetor_hash,
        CASE WHEN e.autor_e_dono=1 THEN 'Você' ELSE COALESCE(e.autor_id,'Não identificado') END autor_nome,
        COALESCE(g.nome,c.nome,e.conversa_id) conversa_nome FROM desktop_vetores v JOIN desktop_fontes e ON e.id=v.evento_id LEFT JOIN grupos_app g ON g.id=e.conversa_id
        LEFT JOIN conversas_app c ON c.id=e.conversa_id WHERE ${where.join(' AND ')} AND e.id=? AND v.inicio=? AND v.fim=?`).get(...args,hit.id,hit.inicio,hit.fim);
      if(!row||row.vetor_hash!==hashTexto(row.texto))continue;
      const {vetor_hash,...e}=row;
      result.push({...e,trecho:e.texto.slice(hit.inicio,hit.fim),inicio:hit.inicio,score:hit.score});
      if(result.length>=limite)break;
    }
    return result;
  }
}
import { PROJETO_SQL } from './compartilhamento.js';
