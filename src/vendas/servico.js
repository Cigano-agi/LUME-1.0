import { randomUUID } from 'node:crypto';
import { JEV_MODELO, avaliarComJev, CRITERIOS_TEMPERATURA, CRITERIOS_ETAPA, CRITERIOS_ASSUNTO, CRITERIOS_ANDAMENTO, CRITERIOS_CONTINUIDADE } from './jev.js';
import {hashFontesVendas as hash,idsFontesValidos as idsValidos,lerFontesVendas,revisaoVendas,conferirAvaliacaoVendas} from './recorte.js';

const erro=(code,message)=>Object.assign(new Error(message),{code});
const LIMITE_BYTES=24000, VALIDADE_MS=300000;
const AVISO_RECORTE='Esta avaliação descreve somente as mensagens escolhidas e suas datas. Mensagens omitidas podem mudar o contexto comercial; não é previsão de venda.';
// Espelha o state de avaliarComJev, incluindo escapes JSON e bytes UTF-8.
const tamanhoTransmissao=fontes=>Buffer.byteLength(JSON.stringify(fontes.map((f,i)=>({referencia:i+1,quando:f.recebido_em,papel:f.autor_e_dono?'vendedor':'contato',texto:f.texto}))),'utf8');

// Nonce por alteração: revogar e restaurar entre awaits não restaura consentimento.
// Triggers persistem mesmo quando o serviço não está instanciado.
function prepararRevisoes(db) {
  db.exec('CREATE TABLE IF NOT EXISTS lume_vendas_revisoes (conversa_id TEXT PRIMARY KEY,revisao TEXT NOT NULL)');
  const renovar=selecao=>`INSERT INTO lume_vendas_revisoes(conversa_id,revisao)
    SELECT alvo.conversa_id,lower(hex(randomblob(32))) FROM (${selecao}) alvo
    WHERE EXISTS(SELECT 1 FROM eventos e WHERE e.conversa_id=alvo.conversa_id)
    ON CONFLICT(conversa_id) DO UPDATE SET revisao=excluded.revisao;
    DELETE FROM lume_vendas_revisoes WHERE conversa_id IN (${selecao})
      AND NOT EXISTS(SELECT 1 FROM eventos e WHERE e.conversa_id=lume_vendas_revisoes.conversa_id);`;
  const tabelas=[
    {nome:'eventos',campos:['id','conversa_id','origem_id','texto','permissao','autor_id','autor_e_dono','recebido_em','tipo'],conversa:r=>`SELECT ${r}.conversa_id AS conversa_id`},
    {nome:'politicas_conversa',campos:['conversa_id','politica'],conversa:r=>`SELECT ${r}.conversa_id AS conversa_id`},
    {nome:'desktop_ia_conversas',campos:['conversa_id','permitida','decidido_em'],conversa:r=>`SELECT ${r}.conversa_id AS conversa_id`},
    {nome:'f10_procedencias',campos:['evento_id','fingerprint','pacote_id','projeto_id'],conversa:r=>`SELECT conversa_id FROM eventos WHERE id=${r}.evento_id`},
    {nome:'transcricoes',campos:['conversa_id','origem_id','texto','estado'],conversa:r=>`SELECT ${r}.conversa_id AS conversa_id`}
  ];
  for(const {nome,campos,conversa} of tabelas) {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nome))continue;
    for(const [acao,refs] of [['INSERT',['new']],['DELETE',['old']],['UPDATE',['old','new']]]) {
      const quando=acao==='UPDATE'?`WHEN ${campos.map(c=>`old.${c} IS NOT new.${c}`).join(' OR ')}`:'';
      db.exec(`CREATE TRIGGER IF NOT EXISTS lume_vendas_revisao_${nome}_${acao.toLowerCase()}
        AFTER ${acao} ON ${nome} ${quando} BEGIN ${refs.map(r=>renovar(conversa(r))).join('\n')} END`);
    }
  }
}

export function prepararVendasJev(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS lume_vendas_avaliacoes (
      id TEXT PRIMARY KEY,conversa_id TEXT NOT NULL,assinatura TEXT NOT NULL,
      resultado TEXT NOT NULL,avaliado_em TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS lume_vendas_avaliacoes_conversa ON lume_vendas_avaliacoes(conversa_id,avaliado_em);
      CREATE TRIGGER IF NOT EXISTS lume_vendas_fonte_removida AFTER DELETE ON eventos BEGIN
        DELETE FROM lume_vendas_avaliacoes WHERE conversa_id=old.conversa_id;
      END;`);
  prepararRevisoes(db);
}

export class VendasJev {
  #db; #segredos; #avaliar; #agora; #previas=new Map(); #controller=null; #schema;
  constructor(db,{segredos,avaliar=avaliarComJev,agora=()=>new Date()}={}) {
    this.#db=db;this.#segredos=segredos;this.#avaliar=avaliar;this.#agora=agora;
    prepararVendasJev(db);
    this.#schema=db.prepare('PRAGMA schema_version').get().schema_version;
  }
  async estado() {
    const chave=await this.#segredos?.estado?.()??{disponivel:false,configurada:false};
    return {...chave,modelo:JEV_MODELO,provedor:'OpenRouter / TypeSafe',localPorPadrao:true,
      aviso:'Jev é opcional. Cada avaliação envia somente o recorte conferido; não muda o pipeline automaticamente.'};
  }
  async configurar({chave}={}) {
    if(typeof chave!=='string'||!/^sk-or-v1-[a-f0-9]{64}$/.test(chave))throw erro('JEV_SEM_CHAVE','Configure uma chave OpenRouter válida.');
    if(!this.#segredos?.gravar)throw erro('JEV_COFRE_INDISPONIVEL','Abra o aplicativo com proteção de credenciais.');
    this.invalidar();await this.#segredos.gravar(chave);return this.estado();
  }
  async remover() {this.invalidar();await this.#segredos?.remover?.();return this.estado();}
  invalidar() {this.#controller?.abort();this.#previas.clear();}
  #fontes(conversaId,ids) {
    if(typeof conversaId!=='string'||!conversaId||conversaId.length>160)throw erro('JEV_CONVERSA_INVALIDA','Escolha uma conversa.');
    return lerFontesVendas(this.#db,conversaId,ids);
  }
  #revisao(conversaId) {
    return revisaoVendas(this.#db,conversaId);
  }
  #atomico(fn) {
    // Áudio/backup podem preparar tabelas depois de Jev na inicialização do app.
    if(this.#db.prepare('PRAGMA schema_version').get().schema_version!==this.#schema) {
      this.invalidar();prepararRevisoes(this.#db);
      this.#schema=this.#db.prepare('PRAGMA schema_version').get().schema_version;
    }
    this.#db.exec('SAVEPOINT vendas_jev_recorte');
    try {const resultado=fn();this.#db.exec('RELEASE vendas_jev_recorte');return resultado;}
    catch(error){this.#db.exec('ROLLBACK TO vendas_jev_recorte;RELEASE vendas_jev_recorte');throw error;}
  }
  #recorte(candidatas,fontes,revisao) {
    return {escopo:'mensagens_selecionadas',total:candidatas.length,selecionadas:fontes.length,
      inicio_em:fontes[0].recebido_em,fim_em:fontes.at(-1).recebido_em,
      contexto_omitido:fontes.length<candidatas.length,contexto_omitido_possivel:true,
      assinatura_janela:hash(candidatas),revisao,aviso:AVISO_RECORTE};
  }
  preparar({conversa_id,fonte_ids}={}) {
    return this.#atomico(()=>{
      const candidatas=this.#fontes(conversa_id);
      if(fonte_ids!==undefined&&!idsValidos(fonte_ids))throw erro('JEV_SELECAO_INVALIDA','Escolha de 1 a 20 mensagens diferentes desta prévia.');
      if(!candidatas.length)throw erro('JEV_SEM_FONTES','Não há mensagens permitidas com texto para avaliar.');
      const ids=new Set(fonte_ids??candidatas.map(f=>f.id));
      const fontes=candidatas.filter(f=>ids.has(f.id));
      if(fontes.length!==ids.size)throw erro('JEV_SELECAO_INVALIDA','Uma mensagem escolhida não está na janela permitida desta conversa. Confira a seleção.');
      const tamanho_bytes=tamanhoTransmissao(fontes);
      const datasValidas=fontes.every(f=>typeof f.recebido_em==='string'&&Number.isFinite(Date.parse(f.recebido_em)));
      const apto=tamanho_bytes<=LIMITE_BYTES&&datasValidas;
      const motivo=!datasValidas?'JEV_CONTEXTO_INVALIDO':!apto?'JEV_CONTEXTO_LONGO':null;
      const agora=this.#agora().getTime(),expira=agora+VALIDADE_MS;
      const recorte=this.#recorte(candidatas,fontes,this.#revisao(conversa_id));
      const assinatura_recorte=hash(fontes),id=apto?randomUUID():null;
      for(const [key,p] of this.#previas)if(p.expira<=agora||p.conversa_id===conversa_id)this.#previas.delete(key);
      if(apto) {
        if(this.#previas.size>=10)this.#previas.delete(this.#previas.keys().next().value);
        // O retorno e o adaptador recebem cópias; nunca referências à autorização privada.
        this.#previas.set(id,{conversa_id,fontes:structuredClone(fontes),assinatura:assinatura_recorte,recorte,expira});
      }
      const aviso=`Ao confirmar, somente estas ${fontes.length} mensagens serão enviadas à OpenRouter e à TypeSafe. ${AVISO_RECORTE}`+
        (!datasValidas?' Há uma mensagem sem data válida.':!apto?' O recorte excede 24 KB. Escolha menos mensagens; nenhum texto será cortado.':'');
      return {id,fontes:structuredClone(fontes),candidatas,fonte_ids:fontes.map(f=>f.id),modelo:JEV_MODELO,
        total:candidatas.length,selecionadas:fontes.length,tamanho_bytes,limite_bytes:LIMITE_BYTES,apto,motivo,
        assinatura_recorte,expira_em:apto?new Date(expira).toISOString():null,aviso};
    });
  }
  #conferir(p) {
    if(!p||p.expira<=this.#agora().getTime()||this.#revisao(p.conversa_id)!==p.recorte.revisao||
      hash(this.#fontes(p.conversa_id))!==p.recorte.assinatura_janela||
      hash(this.#fontes(p.conversa_id,p.fontes.map(f=>f.id)))!==p.assinatura)
      throw erro('JEV_FONTE_ALTERADA','O recorte, a conversa ou sua permissão mudou. Confira uma nova prévia.');
    if(this.#controller?.signal.aborted)throw erro('JEV_CANCELADO','Avaliação cancelada.');
    if(tamanhoTransmissao(p.fontes)>LIMITE_BYTES)throw erro('JEV_CONTEXTO_LONGO','Escolha menos mensagens para enviar até 24 KB.');
  }
  async avaliar({previa_id,confirmar}={}) {
    if(confirmar!==true)throw erro('JEV_SEM_CONSENTIMENTO','Confirme o envio do recorte ao avaliador externo.');
    if(this.#controller)throw erro('JEV_OCUPADO','Aguarde a avaliação em andamento.');
    const p=this.#previas.get(previa_id);this.#previas.delete(previa_id);this.#atomico(()=>this.#conferir(p));
    if(!this.#segredos?.ler)throw erro('JEV_COFRE_INDISPONIVEL','Configure a credencial protegida do avaliador.');
    this.#controller=new AbortController();const signal=this.#controller.signal;
    try {
      const chave=await this.#segredos.ler();this.#atomico(()=>this.#conferir(p));
      const confirmado_em=this.#agora().toISOString();
      const resultado=await this.#avaliar({fontes:structuredClone(p.fontes),chave,confirmar:true,signal});
      return this.#atomico(()=>{
        this.#conferir(p);
        const id=randomUUID(),avaliado_em=this.#agora().toISOString();
        // Classification stays separate from confirmed commercial state.
        const avaliacao={...resultado,id,avaliado_em,fontes:p.fontes.map(f=>f.id),desatualizada:false,
          recorte:p.recorte,aviso:AVISO_RECORTE,
          consentimento:{confirmado_em,provedor:'OpenRouter / TypeSafe',modelo:JEV_MODELO,assinatura_recorte:p.assinatura}};
        this.#db.prepare('INSERT INTO lume_vendas_avaliacoes VALUES(?,?,?,?,?)').run(id,p.conversa_id,p.assinatura,JSON.stringify(avaliacao),avaliado_em);
        return avaliacao;
      });
    } finally {this.#controller=null;}
  }
  obter({conversa_id}={}) {
    return this.#atomico(()=>{
      const candidatas=this.#fontes(conversa_id);if(!candidatas.length)return null;
      const row=this.#db.prepare('SELECT * FROM lume_vendas_avaliacoes WHERE conversa_id=? ORDER BY avaliado_em DESC,rowid DESC LIMIT 1').get(conversa_id);
      if(!row)return null;
      const avaliacao=JSON.parse(row.resultado),recorte=avaliacao.recorte;
      // Seleção é revalidada pelos IDs persistidos, sem compará-la à janela inteira.
      const {fontes,fonteAlterada,contextoAlterado}=conferirAvaliacaoVendas(this.#db,row,avaliacao);
      // Nunca retornar classificação/probabilidades derivadas de fonte revogada ou contexto antigo.
      if(fonteAlterada||contextoAlterado)return {desatualizada:true,temperatura:'insuficiente',etapa:'insuficiente',fontes:[],avaliado_em:row.avaliado_em,
        motivo:fonteAlterada?'fontes_alteradas':'contexto_ou_permissao_alterados',criterio:'O contexto ou sua permissão mudou. Faça uma nova avaliação.',aviso:AVISO_RECORTE,
        ...(avaliacao.importacao?{importacao:{em:avaliacao.importacao.em,backup_sha256:avaliacao.importacao.backup_sha256,consentimento_transferido:false}}:{}),
        ...(!fonteAlterada&&avaliacao.importacao&&avaliacao.consentimento?{consentimento:{
          confirmado_em:avaliacao.consentimento.confirmado_em,provedor:'OpenRouter / TypeSafe',modelo:JEV_MODELO,assinatura_recorte:row.assinatura}}:{})};
      return {...avaliacao,recorte:recorte??this.#recorte(candidatas,fontes,null),aviso:AVISO_RECORTE};
    });
  }
  corrigir({conversa_id,temperatura,etapa,confirmar,assunto,andamento,continuidade}={}) {
    if(confirmar!==true||!Object.hasOwn(CRITERIOS_TEMPERATURA,temperatura)||!Object.hasOwn(CRITERIOS_ETAPA,etapa))throw erro('JEV_CORRECAO_INVALIDA','Confira temperatura e etapa antes de salvar sua avaliação.');
    const adicional=[assunto,andamento,continuidade].some(v=>v!==undefined);
    if(adicional&&(!Object.hasOwn(CRITERIOS_ASSUNTO,assunto)||!Object.hasOwn(CRITERIOS_ANDAMENTO,andamento)||!Object.hasOwn(CRITERIOS_CONTINUIDADE,continuidade)))throw erro('JEV_CORRECAO_INVALIDA','Confira assunto, andamento e continuidade.');
    return this.#atomico(()=>{
      const fontes=this.#fontes(conversa_id);if(!fontes.length)throw erro('JEV_SEM_FONTES','Conversa sem fontes permitidas.');
      this.invalidar();
      const id=randomUUID(),avaliado_em=this.#agora().toISOString();
      const avaliacao={id,temperatura,etapa,criterio:CRITERIOS_TEMPERATURA[temperatura],criterio_etapa:CRITERIOS_ETAPA[etapa],confianca:null,origem:'manual',avaliado_em,fontes:fontes.map(f=>f.id),desatualizada:false,
        recorte:this.#recorte(fontes,fontes,this.#revisao(conversa_id)),aviso:AVISO_RECORTE};
      if(adicional)Object.assign(avaliacao,{assunto:{valor:assunto,confianca:null},andamento:{valor:andamento,confianca:null},continuidade:{valor:continuidade,confianca:null},eventoId:fontes.at(-1).id,somenteSugestao:true});
      this.#db.prepare('INSERT INTO lume_vendas_avaliacoes VALUES(?,?,?,?,?)').run(id,conversa_id,hash(fontes),JSON.stringify(avaliacao),avaliado_em);
      return avaliacao;
    });
  }
}
