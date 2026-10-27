import {sinaisTextoModelo} from './qualidade-transcricao.js';

const existe=(db,tipo,nome)=>Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get(tipo,nome));
const colunas=(db,tabela)=>db.prepare(`PRAGMA table_info(${tabela})`).all().map(c=>c.name);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const referencia="(e.texto IS NULL OR e.texto='' OR e.texto LIKE '%<anexado:%' OR e.texto LIKE '%<attached:%')";
export const TEXTO_EXIBICAO_SQL="COALESCE(e.texto,CASE WHEN e.tipo='documento' AND e.transcricao_meta IS NOT NULL THEN '[Documento: conteúdo indisponível para leitura]' ELSE CASE json_extract(e.transcricao_meta,'$.estado') WHEN 'vazio' THEN '[Áudio: nenhuma fala identificada pelo modelo]' WHEN 'erro' THEN '[Áudio: falha na transcrição]' END END)";
export function avisosFonte(e){
  let original=e.texto;
  if(e.transcricao_meta){try{const t=JSON.parse(e.transcricao_meta);original=t.texto_original??t.texto??original;}catch{}}
  return sinaisTextoModelo(original);
}
export function prepararFontes(db){
  if(!existe(db,'table','eventos'))return;
  const campos=colunas(db,'eventos'),tc=colunas(db,'transcricoes');
  const temTranscricao=['conversa_id','origem_id','texto','estado'].every(c=>tc.includes(c));
  const valor=c=>tc.includes(c)?'t.'+quote(c):'NULL';
  const documento=tc.includes('modelo')?"(e.tipo='documento' AND t.modelo LIKE 'documento-local:%')":'0';
  const meta=temTranscricao?`CASE WHEN (${referencia} OR ${documento}) AND t.conversa_id IS NOT NULL THEN json_object(${['estado','texto','texto_original','respostas_json','modelo','quando'].flatMap(c=>["'"+c+"'",valor(c)]).join(',')}) END`:'NULL';
  const texto=temTranscricao?`CASE WHEN ${documento} THEN CASE WHEN t.estado='transcrito' THEN CASE WHEN ${referencia} THEN t.texto ELSE e.texto||char(10)||char(10)||t.texto END END WHEN ${referencia} AND t.conversa_id IS NOT NULL THEN CASE WHEN t.estado='transcrito' THEN t.texto END ELSE e.texto END`:'e.texto';
  const sql=`CREATE VIEW desktop_fontes AS SELECT ${campos.filter(c=>c!=='texto').map(c=>'e.'+quote(c)).join(',')},e.texto AS texto_capturado,${texto} AS texto,${meta} AS transcricao_meta FROM eventos e${temTranscricao?' LEFT JOIN transcricoes t ON t.conversa_id=e.conversa_id AND t.origem_id=e.origem_id':''}`;
  const antiga=db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='desktop_fontes'").get()?.sql;
  db.exec('SAVEPOINT preparar_fontes_desktop');
  try{
    if(antiga!==sql)db.exec('DROP VIEW IF EXISTS desktop_fontes;'+sql);
    db.exec('DROP TRIGGER IF EXISTS documento_local_fonte_alterada;DROP TRIGGER IF EXISTS documento_local_fonte_removida');
    if(temTranscricao&&tc.includes('modelo')){
      db.exec(`CREATE TRIGGER documento_local_fonte_removida AFTER DELETE ON eventos BEGIN ${invalidarDocumento()} END;`);
      if(!existe(db,'table','desktop_fontes_fts'))db.exec(`CREATE TRIGGER documento_local_fonte_alterada BEFORE UPDATE OF texto,bruto,conversa_id,origem_id,permissao ON eventos BEGIN ${invalidarDocumento()} END;`);
    }
    // Índices só existem quando seu recurso já foi preparado. A view não ativa IA/modelo.
    if(existe(db,'table','desktop_fontes_fts')){
      const fts=db.prepare("SELECT sql FROM sqlite_master WHERE name='desktop_fontes_fts'").get().sql;
      const migrar=!fts.includes("content='desktop_fontes'");
      if(migrar){db.exec('DROP TRIGGER IF EXISTS desktop_fontes_ai;DROP TRIGGER IF EXISTS desktop_fontes_ad;DROP TRIGGER IF EXISTS desktop_fontes_au;DROP TABLE desktop_fontes_fts');criarFts(db);}
      triggersFts(db,temTranscricao);
      if(migrar||antiga!==sql)db.exec("INSERT INTO desktop_fontes_fts(desktop_fontes_fts) VALUES('rebuild')");
    }
    if(existe(db,'table','desktop_vetores')){
      if(antiga!==sql)db.exec('DELETE FROM desktop_vetores');
      triggersVetores(db,temTranscricao);
    }
    db.exec('RELEASE preparar_fontes_desktop');
  }catch(error){db.exec('ROLLBACK TO preparar_fontes_desktop;RELEASE preparar_fontes_desktop');throw error;}
}
function criarFts(db){db.exec("CREATE VIRTUAL TABLE desktop_fontes_fts USING fts5(texto,content='desktop_fontes',content_rowid='id',tokenize='unicode61 remove_diacritics 2')");}
function invalidarDocumento(){return "DELETE FROM transcricoes WHERE conversa_id=OLD.conversa_id AND origem_id=OLD.origem_id AND modelo LIKE 'documento-local:%';";}
export function prepararIndiceFontes(db){
  prepararFontes(db);
  if(!existe(db,'table','desktop_fontes_fts')){criarFts(db);prepararFontes(db);db.exec("INSERT INTO desktop_fontes_fts(desktop_fontes_fts) VALUES('rebuild')");}
}
function triggersFts(db,trans){
  const del=where=>`INSERT INTO desktop_fontes_fts(desktop_fontes_fts,rowid,texto) SELECT 'delete',id,texto FROM desktop_fontes WHERE ${where};`;
  const ins=where=>`INSERT INTO desktop_fontes_fts(rowid,texto) SELECT id,texto FROM desktop_fontes WHERE ${where};`;
  const pares=r=>`conversa_id=${r}.conversa_id AND origem_id=${r}.origem_id`;
  const invalidar=trans&&colunas(db,'transcricoes').includes('modelo')?invalidarDocumento():'';
  for(const n of ['ai','ad','au','bu'])db.exec('DROP TRIGGER IF EXISTS desktop_fontes_'+n);
  db.exec(`CREATE TRIGGER desktop_fontes_ai AFTER INSERT ON eventos BEGIN ${ins('id=new.id')} END;
    CREATE TRIGGER desktop_fontes_ad BEFORE DELETE ON eventos BEGIN ${del('id=old.id')} END;
    CREATE TRIGGER desktop_fontes_bu BEFORE UPDATE OF texto,bruto,conversa_id,origem_id,permissao ON eventos BEGIN ${invalidar}${del('id=old.id')} END;
    CREATE TRIGGER desktop_fontes_au AFTER UPDATE OF texto,bruto,conversa_id,origem_id,permissao ON eventos BEGIN ${ins('id=new.id')} END;`);
  for(const n of ['ai','bd','ad','bu','au'])db.exec('DROP TRIGGER IF EXISTS desktop_transcricao_fts_'+n);
  if(trans)db.exec(`CREATE TRIGGER desktop_transcricao_fts_ai AFTER INSERT ON transcricoes BEGIN INSERT INTO desktop_fontes_fts(desktop_fontes_fts,rowid,texto) SELECT 'delete',id,texto FROM eventos WHERE ${pares('new')};${ins(pares('new'))} END;
    CREATE TRIGGER desktop_transcricao_fts_bd BEFORE DELETE ON transcricoes BEGIN ${del(pares('old'))} END;
    CREATE TRIGGER desktop_transcricao_fts_ad AFTER DELETE ON transcricoes BEGIN ${ins(pares('old'))} END;
    CREATE TRIGGER desktop_transcricao_fts_bu BEFORE UPDATE ON transcricoes BEGIN ${del(pares('old'))}${del('('+pares('new')+') AND NOT ('+pares('old')+')')} END;
    CREATE TRIGGER desktop_transcricao_fts_au AFTER UPDATE ON transcricoes BEGIN ${ins('('+pares('old')+') OR ('+pares('new')+')')} END;`);
}
function triggersVetores(db,trans){
  db.exec(`DROP TRIGGER IF EXISTS desktop_vetores_update;CREATE TRIGGER desktop_vetores_update AFTER UPDATE OF texto,conversa_id,origem_id ON eventos BEGIN DELETE FROM desktop_vetores WHERE evento_id=new.id; END;`);
  for(const n of ['ai','ad','au'])db.exec('DROP TRIGGER IF EXISTS desktop_transcricao_vetores_'+n);
  if(trans)for(const [n,acao,refs]of[['ai','INSERT',['new']],['ad','DELETE',['old']],['au','UPDATE',['old','new']]])db.exec(`CREATE TRIGGER desktop_transcricao_vetores_${n} AFTER ${acao} ON transcricoes BEGIN DELETE FROM desktop_vetores WHERE evento_id IN(SELECT id FROM eventos WHERE ${refs.map(r=>`(conversa_id=${r}.conversa_id AND origem_id=${r}.origem_id)`).join(' OR ')}); END;`);
}
