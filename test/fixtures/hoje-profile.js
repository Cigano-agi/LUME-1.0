// Somente dados sintéticos. Fontes e CRM ligados pelo mesmo par conversa/origem.
import { ContextoApp } from '../../src/contexto-app.js';
import { Desktop } from '../../src/desktop.js';
export function perfilHoje(db) {
  const contexto = new ContextoApp(db), desktop = new Desktop(db);
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('teste-hoje', 'Equipe · exemplo sintético');
  let contador = 0;
  function adicionar({tipo='pendencia',data='2026-09-18T12:00:00Z',permissao='minha',texto='Revisar item de teste',quando=null}={}) {
    const origem='hoje-'+(++contador);
    const evento=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
      VALUES('teste-hoje',?,'entrada','texto','{}',?,'2026-09-18T12:00:00Z','2026-09-18',?)`).run(origem,texto,permissao).lastInsertRowid);
    const id=Number(db.prepare(`INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em,quando) VALUES('teste-hoje',?,?,?,?,?)`).run(origem,tipo,texto,data,quando).lastInsertRowid);
    return {id,evento};
  }
  return {contexto,desktop,adicionar};
}
