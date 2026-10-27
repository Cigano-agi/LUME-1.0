import {prepararAcoesLume} from './acoes-lume.js';
import {HASH_FONTE_SQL} from './tarefas-esquema.js';
import {LEITURA_SQL} from './leitura-sql.js';

const RESULTADOS=new Set(['mostrado','falhou','sem-confirmacao','cancelado']);
const CHAVE_SOM='lume_acoes_som';

/** Um aviso local por ação e horário agendado, sem texto privado atravessar a ponte nativa. */
export class LembretesAcoes {
  constructor(db,{perfil,notificacoes=null,agora=()=>new Date()}={}){
    this.db=db;this.perfil=perfil;this.notificacoes=notificacoes;this.agora=agora;
    this.ocupado=false;this.fechado=false;this.geracao=0;
    prepararAcoesLume(db);
    // Um processo encerrado no meio de uma chamada ao SO não prova entrega.
    db.prepare("UPDATE lume_acoes SET aviso_resultado='sem-confirmacao' WHERE aviso_resultado='pendente'").run();
  }
  disponivel(){return !this.fechado&&this.notificacoes?.disponivel()===true;}
  somAtivo(){return this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(CHAVE_SOM)?.valor!=='0';}
  configurarSom({som}={}){
    if(typeof som!=='boolean')throw new Error('Escolha se os próximos avisos de ações terão som.');
    this.db.prepare('INSERT INTO desktop_config(chave,valor) VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run(CHAVE_SOM,som?'1':'0');
    return {som};
  }
  estado(){return {disponivel:this.disponivel(),ambiente:this.notificacoes?'aplicativo':'previa',som:this.somAtivo()};}
  invalidar(){this.geracao++;try{this.notificacoes?.cancelar();}catch{}}
  encerrar(){if(this.fechado)return;this.fechado=true;this.invalidar();}
  async executar(){
    if(this.ocupado||!this.disponivel()||!this.perfil?.().aceito)return {resultado:'indisponivel'};
    const now=this.agora().toISOString();
    const atual=this.db.prepare(`SELECT a.id,a.lembrar_em FROM lume_acoes a
      JOIN desktop_fontes e ON e.id=a.evento_id JOIN lume_acoes_conversas p ON p.conversa_id=e.conversa_id
      WHERE a.estado='estacionado' AND a.lembrar_em<=? AND (a.aviso_para IS NULL OR a.aviso_para<>a.lembrar_em)
      AND a.fonte_assinatura=${HASH_FONTE_SQL} AND ${LEITURA_SQL}
      ORDER BY a.lembrar_em,a.id LIMIT 1`).get(now);
    if(!atual)return {resultado:'sem-aviso'};
    const reservado=this.db.prepare(`UPDATE lume_acoes SET aviso_para=lembrar_em,aviso_em=?,aviso_resultado='pendente'
      WHERE id=? AND estado='estacionado' AND lembrar_em=? AND (aviso_para IS NULL OR aviso_para<>lembrar_em)`).run(now,atual.id,atual.lembrar_em);
    if(!reservado.changes)return {resultado:'sem-aviso'};
    const geracao=this.geracao;this.ocupado=true;
    try{
      const resposta=await this.notificacoes.mostrar({categoria:'acao',acaoId:atual.id,som:this.somAtivo()});
      const resultado=geracao!==this.geracao?'cancelado':RESULTADOS.has(resposta?.resultado)?resposta.resultado:'sem-confirmacao';
      if(!this.fechado)this.db.prepare("UPDATE lume_acoes SET aviso_resultado=? WHERE id=? AND aviso_para=? AND aviso_resultado='pendente'").run(resultado,atual.id,atual.lembrar_em);
      return {resultado};
    }catch{
      if(!this.fechado)this.db.prepare("UPDATE lume_acoes SET aviso_resultado='falhou' WHERE id=? AND aviso_para=? AND aviso_resultado='pendente'").run(atual.id,atual.lembrar_em);
      return {resultado:'falhou'};
    }finally{this.ocupado=false;}
  }
}
