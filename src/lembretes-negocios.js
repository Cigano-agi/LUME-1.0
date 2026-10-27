import {NEGOCIO_ATUAL_SQL,prepararNegocios} from './negocios-desktop.js';
import {diaLocal,FUSO} from './relogio.js';

const horaValida=v=>typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const horaLocal=new Intl.DateTimeFormat('en-GB',{timeZone:FUSO,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const resultados=new Set(['mostrado','falhou','sem-confirmacao','cancelado']);

export class LembretesNegocios {
 constructor(db,{perfil,notificacoes=null,agora=()=>new Date()}={}){
  this.db=db;this.perfil=perfil;this.notificacoes=notificacoes;this.agora=agora;this.geracao=0;this.ocupado=false;this.fechado=false;
  prepararNegocios(db);db.exec('CREATE TABLE IF NOT EXISTS desktop_config(chave TEXT PRIMARY KEY,valor TEXT NOT NULL)');
  // A previous process cannot still acknowledge a persisted pending attempt.
  for(const chave of ['ultimo','teste']){const antigo=this.ler(chave,null);if(antigo?.resultado==='pendente')this.gravar(chave,{...antigo,resultado:'sem-confirmacao'});}
 }
 ler(chave,fallback){const row=this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get('lembretes-'+chave);try{return row?JSON.parse(row.valor):fallback;}catch{return fallback;}}
 gravar(chave,valor){this.db.prepare('INSERT INTO desktop_config VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run('lembretes-'+chave,JSON.stringify(valor));}
 disponivel(){return !this.fechado&&this.notificacoes?.disponivel()===true;}
 config(){const c=this.ler('config',{});return {ativo:c.ativo===true,hora:horaValida(c.hora)?c.hora:'09:00'};}
 estado(){return {...this.config(),disponivel:this.disponivel(),ambiente:this.notificacoes?'aplicativo':'previa',fuso:FUSO,ultimo:this.ler('ultimo',null),teste:this.ler('teste',null)};}
 configurar({ativo,hora,confirmar}={}){
  if(!this.perfil?.().aceito)throw Error('Conclua o primeiro acesso.');
  if(confirmar!==true||typeof ativo!=='boolean'||!horaValida(hora))throw Error('Escolha o horário e confirme a preferência.');
  if(ativo&&!this.disponivel())throw Error('Os avisos do sistema não estão disponíveis neste ambiente.');
  this.invalidar();this.gravar('config',{ativo,hora});return this.estado();
 }
 temContato(dia){return Boolean(this.db.prepare(`SELECT 1 FROM desktop_negocios n JOIN desktop_fontes e ON e.id=n.evento_id WHERE ${NEGOCIO_ATUAL_SQL} AND n.etapa NOT IN('fechado','encerrado') AND n.proximo_contato IS NOT NULL AND n.proximo_contato<=? LIMIT 1`).get(dia));}
 invalidar(){this.geracao++;try{this.notificacoes?.cancelar();}catch{} }
 encerrar(){if(this.fechado)return;this.fechado=true;this.invalidar();}
 async executar({teste=false}={}){
  if(this.ocupado||!this.disponivel()||!this.perfil?.().aceito)return {resultado:'indisponivel'};
  const now=this.agora(),dia=diaLocal(now),c=this.config(),chave=teste?'teste':'ultimo';
  if(teste){const anterior=this.ler('teste',null);if(anterior&&now.getTime()-Date.parse(anterior.em)<60000)throw Error('Espere um minuto antes de testar novamente.');}
  else if(!c.ativo||horaLocal.format(now)<c.hora||this.ler('ultimo',null)?.dia>=dia||!this.temContato(dia))return {resultado:'sem-aviso'};
  // Reserve before awaiting the OS so restart/concurrent ticks cannot duplicate today's reminder.
  const geracao=this.geracao,registro={dia,em:now.toISOString(),resultado:'pendente'};this.gravar(chave,registro);this.ocupado=true;
  try{
   const r=await this.notificacoes.mostrar({teste});
   const resultado=geracao!==this.geracao?'cancelado':resultados.has(r?.resultado)?r.resultado:'sem-confirmacao';
   if(!this.fechado)this.gravar(chave,{...registro,resultado});return {resultado};
  }catch{if(!this.fechado)this.gravar(chave,{...registro,resultado:'falhou'});return {resultado:'falhou'};}
  finally{this.ocupado=false;}
 }
 async testar({confirmar}={}){if(confirmar!==true)throw Error('Confirme para testar o aviso.');const r=await this.executar({teste:true});return {...this.estado(),resultado:r.resultado};}
}
