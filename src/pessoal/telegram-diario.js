import {prepararPessoal} from './esquema.js';

export function identidadeTelegram(update,donoId) {
  const m=update?.message;
  return m?.chat?.type==='private' && String(m?.chat?.id)===donoId && String(m?.from?.id)===donoId &&
    m?.from?.is_bot!==true && Number.isSafeInteger(update.update_id) && update.update_id>=0;
}

export class TelegramDiario {
  constructor(db,{botId,donoId,ativo=()=>true,validarSaida=()=>true,agora=()=>new Date()}={}) {
    prepararPessoal(db);
    if(!/^\d+$/.test(botId)||!/^\d+$/.test(donoId))throw new Error('Identidade Telegram inválida.');
    this.db=db;this.botId=botId;this.donoId=donoId;this.ativo=ativo;this.validarSaida=validarSaida;this.agora=agora;
    this.cursorKey='pessoal-telegram-offset:'+botId;
  }
  offset() {return Number(this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(this.cursorKey)?.valor||0);}
  aceitar(update) {
    if(!this.ativo())throw new Error('Telegram desativado.');
    const id=update?.update_id;
    if(!Number.isSafeInteger(id)||id<0)throw new Error('Atualização inválida.');
    this.db.exec('SAVEPOINT telegram_intake');
    try {
      if(identidadeTelegram(update,this.donoId)) {
        const m=update.message;
        const safe={update_id:id,message:{message_id:m.message_id,chat:{id:this.donoId,type:'private'},from:{id:this.donoId},
          date:m.date,text:typeof m.text==='string'?m.text.slice(0,12000):null,
          reply_to_message:Number.isSafeInteger(m.reply_to_message?.message_id)?{message_id:m.reply_to_message.message_id}:null,
          voice:m.voice?{file_id:m.voice.file_id,file_size:m.voice.file_size,duration:m.voice.duration}:null}};
        this.db.prepare('INSERT OR IGNORE INTO telegram_entradas(bot_id,update_id,dono_id,entrada,criada_em) VALUES(?,?,?,?,?)')
          .run(this.botId,id,this.donoId,JSON.stringify(safe),this.agora().toISOString());
        this.db.prepare("INSERT INTO desktop_config VALUES('pessoal-telegram-identidade',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor")
          .run(JSON.stringify({botId:this.botId,donoId:this.donoId,confirmadaEm:this.agora().toISOString()}));
      }
      this.db.prepare(`INSERT INTO desktop_config VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor
        WHERE CAST(desktop_config.valor AS INTEGER)<CAST(excluded.valor AS INTEGER)`).run(this.cursorKey,String(id+1));
      this.db.exec('RELEASE telegram_intake');
    }catch(e){this.db.exec('ROLLBACK TO telegram_intake;RELEASE telegram_intake');throw e;}
  }
  proxima() {
    if(!this.ativo())return null;
    // Inference can last two minutes. Expired claims survive a process restart;
    // effects of owner commands are themselves idempotent in their destination.
    const expired=new Date(this.agora().getTime()-300000).toISOString();
    this.db.prepare("UPDATE telegram_entradas SET estado='pendente' WHERE bot_id=? AND dono_id=? AND estado='processando' AND erro<?")
      .run(this.botId,this.donoId,expired);
    const row=this.db.prepare("SELECT * FROM telegram_entradas WHERE bot_id=? AND dono_id=? AND estado='pendente' ORDER BY update_id LIMIT 1").get(this.botId,this.donoId);
    if(!row)return null;
    const claim=this.db.prepare("UPDATE telegram_entradas SET estado='processando',tentativas=tentativas+1,erro=? WHERE bot_id=? AND update_id=? AND estado='pendente'")
      .run(this.agora().toISOString(),this.botId,row.update_id);
    return claim.changes===1?JSON.parse(row.entrada):null;
  }
  concluir(update,reply) {
    this.db.exec('SAVEPOINT telegram_processar');
    try {
      if(reply && String(reply.chatId)===this.donoId && typeof reply.text==='string')
        this.agendar('resposta:'+this.botId+':'+update.update_id,reply.text,reply.vinculo);
      this.db.prepare("UPDATE telegram_entradas SET estado='concluida',erro=NULL WHERE bot_id=? AND update_id=? AND dono_id=?")
        .run(this.botId,update.update_id,this.donoId);
      this.db.exec('RELEASE telegram_processar');
    } catch(e){this.db.exec('ROLLBACK TO telegram_processar;RELEASE telegram_processar');throw e;}
  }
  falhar(update) {
    this.concluir(update,{chatId:this.donoId,text:'Não concluí esta solicitação. Ela está registrada no Lume; confira a conexão e peça novamente.'});
  }
  agendar(id,texto,vinculo=null) {
    if(!this.ativo())return false;
    if(typeof texto!=='string'||!texto.trim()||texto.length>4000)throw new Error('Mensagem Telegram fora do limite.');
    const result=this.db.prepare("INSERT OR IGNORE INTO telegram_saidas(id,bot_id,dono_id,texto,criada_em,vinculo) VALUES(?,?,?,?,?,?)")
      .run(id,this.botId,this.donoId,texto,this.agora().toISOString(),vinculo?JSON.stringify(vinculo):null);
    return result.changes===1;
  }
  proximaSaida() {
    if(!this.ativo())return null;
    const rows=this.db.prepare("SELECT * FROM telegram_saidas WHERE bot_id=? AND dono_id=? AND estado='preparada' ORDER BY criada_em,id LIMIT 20").all(this.botId,this.donoId);
    for(const row of rows) {
      if(row.vinculo && !this.validarSaida(JSON.parse(row.vinculo))) {
        this.db.prepare("UPDATE telegram_saidas SET estado='cancelada' WHERE id=? AND estado='preparada'").run(row.id);continue;
      }
      // Network ambiguity never becomes an automatic resend, even after restart.
      if(this.db.prepare("UPDATE telegram_saidas SET estado='incerta' WHERE id=? AND estado='preparada'").run(row.id).changes===1)return row;
    }
    return null;
  }
  enviada(row,receipt) {
    if(!Number.isSafeInteger(receipt?.message_id))return;
    this.db.prepare("UPDATE telegram_saidas SET estado='enviada',externo_id=? WHERE id=? AND estado='incerta'").run(String(receipt.message_id),row.id);
  }
  historico(limite=12) {
    const rows=this.db.prepare("SELECT entrada,update_id FROM telegram_entradas WHERE bot_id=? AND dono_id=? AND estado='concluida' ORDER BY update_id DESC LIMIT ?")
      .all(this.botId,this.donoId,Math.min(20,Math.max(1,limite))).reverse();
    return rows.flatMap(r=>{
      const text=JSON.parse(r.entrada).message.text;
      let response=this.db.prepare("SELECT texto,vinculo FROM telegram_saidas WHERE id=? AND estado='enviada'").get('resposta:'+this.botId+':'+r.update_id);
      if(response?.vinculo&&!this.validarSaida(JSON.parse(response.vinculo)))response=null;
      return [...(text?[{role:'user',content:text.slice(0,4000)}]:[]),...(response?[{role:'assistant',content:response.texto}]:[])];
    });
  }
}
