import {ContextoApp} from '../../src/contexto-app.js';
import {Desktop} from '../../src/desktop.js';
export function perfilGrafo(db){
  const contexto=new ContextoApp(db),desktop=new Desktop(db);
  let sequence=0;
  const insert=db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada',?,?,'{}',?,?,?,?)`);
  function conversa(id,nome=id){db.prepare('INSERT OR IGNORE INTO conversas_app VALUES(?,?)').run(id,nome);}
  function evento(c,a,{dia='2026-09-17',permissao='minha',tipo='texto',texto='Mensagem sintética'}={}){
    return Number(insert.run(c,'g'+(++sequence),a,tipo,texto,dia+'T12:00:00Z',dia,permissao).lastInsertRowid);
  }
  return {contexto,desktop,conversa,evento};
}
