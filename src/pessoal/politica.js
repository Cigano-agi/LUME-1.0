import {createHash} from 'node:crypto';
import {Politica} from '../autorizacao.js';
import {prepararPessoal} from './esquema.js';

export const CATEGORIAS = ['vip_client','lead','team','friend','supplier','family','unknown'];
export const jidValido = id => typeof id==='string' && /^(?:\d+(?:-\d+)?@g\.us|\d+@(?:s\.whatsapp\.net|lid))$/.test(id);
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const atendimentoPadrao=()=>({excluida:false,ativadaEm:null,eventoApos:0,pausaAte:null,inicio:null,fim:null,fuso:'America/Sao_Paulo'});
const horaValida=s=>typeof s==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
const relogio=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

export class PoliticaPessoal {
  constructor(db,{agora=()=>new Date()}={}) {this.db=db;this.agora=agora;prepararPessoal(db);this.base=new Politica(db);}
  regra(conversaId) {
    const p=this.db.prepare('SELECT * FROM pessoal_politicas WHERE conversa_id=?').get(conversaId);
    const r=this.base.regra(conversaId);
    let atendimento=atendimentoPadrao();
    try{atendimento={...atendimento,...JSON.parse(p?.atendimento||'{}')};}catch{atendimento.excluida=true;}
    return {conversaId,categoria:p?.categoria||'unknown',remoto:p?.remoto===1,pausada:p?.pausada===1||r?.modo==='pausado',atendimento,
      versao:p?.versao||0,modo:r?.modo||'observar',decididoPor:r?.decidido_por||null,decididoEm:r?.decidido_em||null};
  }
  assinatura(conversaId) {return hash(this.regra(conversaId));}
  controlar({conversaId,acao,minutos,inicio,fim}={},ator='local:owner') {
    if(!ator||!jidValido(conversaId)||!['ativar','desativar','pausar','retomar','horario','excluir','incluir'].includes(acao))throw Error('Controle de atendimento inválido.');
    if(conversaId.endsWith('@g.us')&&!['excluir','desativar'].includes(acao))throw Error('Grupos são somente leitura.');
    if(acao==='pausar'&&![60,120,240,480].includes(minutos))throw Error('Escolha uma pausa de 1, 2, 4 ou 8 horas.');
    if(acao!=='pausar'&&minutos!==undefined)throw Error('Duração só se aplica à pausa temporária.');
    if(acao==='horario'&&!((inicio===null&&fim===null)||(horaValida(inicio)&&horaValida(fim)&&inicio!==fim)))throw Error('Informe início e fim diferentes ou desative o horário.');
    if(acao!=='horario'&&(inicio!==undefined||fim!==undefined))throw Error('Horário não se aplica a essa ação.');
    const r=this.regra(conversaId),a={...r.atendimento},now=this.agora();
    if(['ativar','retomar'].includes(acao)&&(!['vip_client','lead','team'].includes(r.categoria)||!r.remoto||!['rascunhar','atender','pausado'].includes(r.modo)||a.excluida))throw Error('Autorize esta pessoa antes de ativar o atendimento.');
    if(acao==='excluir')a.excluida=true;
    if(acao==='incluir')a.excluida=false;
    if(acao==='pausar')a.pausaAte=new Date(now.getTime()+minutos*60000).toISOString();
    if(acao==='horario'){a.inicio=inicio;a.fim=fim;}
    if(['ativar','retomar'].includes(acao)){
      a.ativadaEm=now.toISOString();a.eventoApos=this.db.prepare('SELECT COALESCE(MAX(id),0) n FROM eventos WHERE conversa_id=?').get(conversaId).n;
      // Activating is not an implicit manual resume. A timed pause also remains.
      if(acao==='retomar')a.pausaAte=null;
    }
    this.db.exec('SAVEPOINT pessoal_atendimento');
    try{
      this.db.prepare(`INSERT INTO pessoal_politicas(conversa_id,atualizado_em) VALUES(?,?) ON CONFLICT(conversa_id) DO NOTHING`).run(conversaId,now.toISOString());
      this.db.prepare('UPDATE pessoal_politicas SET atendimento=?,versao=versao+1,atualizado_em=? WHERE conversa_id=?').run(JSON.stringify(a),now.toISOString(),conversaId);
      if(['desativar','excluir'].includes(acao))this.pausar(conversaId);
      else if(acao==='retomar')this.retomar(conversaId,ator);
      else this.cancelar(conversaId,'O controle de atendimento mudou; preparar resposta atual.');
      this.db.exec('RELEASE pessoal_atendimento');
    }catch(e){this.db.exec('ROLLBACK TO pessoal_atendimento;RELEASE pessoal_atendimento');throw e;}
    return this.regra(conversaId);
  }
  entradaAtual(e){
    const a=this.regra(e.conversa_id).atendimento;
    return !a.excluida&&(!a.ativadaEm||(e.id>a.eventoApos&&Date.parse(e.recebido_em)>=Math.floor(Date.parse(a.ativadaEm)/1000)*1000));
  }
  configurar({conversaId,categoria,modo,remoto},ator='local:owner') {
    if(!jidValido(conversaId)||!CATEGORIAS.includes(categoria)||!['observar','rascunhar','atender','pausado'].includes(modo)||typeof remoto!=='boolean'||!ator)throw new Error('Política inválida. Use a identidade exata da conversa.');
    if(modo==='atender'&&(!['vip_client','lead','team'].includes(categoria)||conversaId.endsWith('@g.us')))throw new Error('Esta categoria ou grupo não admite atendimento.');
    const anterior=this.regra(conversaId),now=this.agora().toISOString();
    this.db.exec('SAVEPOINT pessoal_politica');
    try {
      // Alterar a categoria/permissão não encerra uma pausa manual.
      this.db.prepare(`INSERT INTO pessoal_politicas(conversa_id,categoria,remoto,pausada,atualizado_em) VALUES(?,?,?,?,?)
        ON CONFLICT(conversa_id) DO UPDATE SET categoria=excluded.categoria,remoto=excluded.remoto,versao=versao+1,atualizado_em=excluded.atualizado_em,
        pausada=CASE WHEN excluded.pausada=1 THEN 1 ELSE pausada END`).run(conversaId,categoria,remoto?1:0,modo==='pausado'?1:0,now);
      this.base.definir(conversaId,modo,{decididoPor:ator});
      if(remoto&&(!anterior.remoto||!['rascunhar','atender'].includes(anterior.modo)&&['rascunhar','atender'].includes(modo))){
        const atendimento={...anterior.atendimento,ativadaEm:now,eventoApos:this.db.prepare('SELECT COALESCE(MAX(id),0) n FROM eventos WHERE conversa_id=?').get(conversaId).n};
        this.db.prepare('UPDATE pessoal_politicas SET atendimento=? WHERE conversa_id=?').run(JSON.stringify(atendimento),conversaId);
      }
      this.cancelar(conversaId,'A permissão da conversa mudou.');
      this.db.exec('RELEASE pessoal_politica');
    } catch(e){this.db.exec('ROLLBACK TO pessoal_politica;RELEASE pessoal_politica');throw e;}
    return this.regra(conversaId);
  }
  cancelar(conversaId,motivo) {
    this.db.prepare("UPDATE pessoal_propostas SET estado='cancelada',motivo=? WHERE conversa_id=? AND estado IN('pendente','aprovada')").run(motivo,conversaId);
    this.base.cancelarPendentes(conversaId,motivo);
  }
  pausar(conversaId) {
    this.db.prepare('UPDATE pessoal_politicas SET pausada=1,versao=versao+1 WHERE conversa_id=?').run(conversaId);
    this.cancelar(conversaId,'Conversa pausada pelo dono.');
  }
  retomar(conversaId,ator) {
    if(!ator||!jidValido(conversaId))throw new Error('Retomada exige dono identificado.');
    const r=this.regra(conversaId);
    this.db.prepare('UPDATE pessoal_politicas SET pausada=0,versao=versao+1 WHERE conversa_id=?').run(conversaId);
    if(r.modo==='pausado')this.base.definir(conversaId,'rascunhar',{decididoPor:ator});
    this.cancelar(conversaId,'Retomada explícita; preparar resposta atual.');return this.regra(conversaId);
  }
  podeEnviar(conversaId) {
    const r=this.regra(conversaId);
    if(!jidValido(conversaId)||conversaId.endsWith('@g.us'))return {permitido:false,motivo:'Grupos começam somente com leitura.'};
    if(!['vip_client','lead','team'].includes(r.categoria))return {permitido:false,motivo:'Categoria sem autorização de envio.'};
    if(r.atendimento.excluida)return {permitido:false,motivo:'Conversa excluída do atendimento pelo dono.'};
    if(r.pausada)return {permitido:false,motivo:'Intervenção manual: retome a conversa explicitamente.'};
    if(r.atendimento.pausaAte&&Date.parse(r.atendimento.pausaAte)>this.agora().getTime())return {permitido:false,motivo:'Pausa temporária em andamento.'};
    if(r.atendimento.inicio&&r.atendimento.fim){
      const h=relogio.format(this.agora()),{inicio,fim}=r.atendimento;
      if(!(inicio<fim?h>=inicio&&h<fim:h>=inicio||h<fim))return {permitido:false,motivo:'Fora do horário de atendimento desta conversa.'};
    }
    if(!r.remoto)return {permitido:false,motivo:'Contexto externo não autorizado.'};
    // Rascunhar pode ser aprovado para uma versão exata; autonomia exige atender.
    if(!['rascunhar','atender'].includes(r.modo)||!r.decididoPor)return {permitido:false,motivo:'Conversa sem liberação explícita.'};
    return {permitido:true,motivo:null};
  }
  listar() {return this.db.prepare('SELECT conversa_id FROM pessoal_politicas ORDER BY atualizado_em DESC LIMIT 200').all().map(r=>this.regra(r.conversa_id));}
}
