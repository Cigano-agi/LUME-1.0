import {createHash} from 'node:crypto';

// Não guarda texto, nomes, telefone ou payload. Marcador mínimo impede replay.
export const chaveExclusao=(conversa,origem)=>createHash('sha256').update(JSON.stringify([conversa,origem])).digest('hex');
export const chaveConversa=conversa=>createHash('sha256').update(JSON.stringify(['conversa',conversa])).digest('hex');
export function prepararExclusoes(db){db.exec(`
  CREATE TABLE IF NOT EXISTS priv_excluidos(hash TEXT PRIMARY KEY,excluido_em TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS priv_conversas_excluidas(hash TEXT PRIMARY KEY,excluido_em TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS priv_vinculos(fonte_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
    derivado_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,PRIMARY KEY(fonte_id,derivado_id));
  CREATE INDEX IF NOT EXISTS idx_priv_vinculos_derivado ON priv_vinculos(derivado_id,fonte_id);
  CREATE TABLE IF NOT EXISTS priv_recibos(id TEXT PRIMARY KEY,criado_em TEXT NOT NULL,estado TEXT NOT NULL,contagens TEXT NOT NULL);
`);}
export function eventoExcluido(db,conversa,origem){return Boolean(db.prepare('SELECT 1 FROM priv_excluidos WHERE hash=?').get(chaveExclusao(conversa,origem)));}
export function metadadosExcluidos(db,conversa){return Boolean(db.prepare('SELECT 1 FROM priv_conversas_excluidas WHERE hash=?').get(chaveConversa(conversa)))&&!db.prepare('SELECT 1 FROM eventos WHERE conversa_id=?').get(conversa);}
