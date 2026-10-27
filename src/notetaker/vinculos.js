import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { conferirPerfilTeste, conferirBancoPerfil } from './perfil-teste.js';
import { LumeMcpReadService } from '../mcp/read-service.js';

// Este ramo só existe no perfil de ensaio criado pelo serviço de importação.
// A marca vem do disco gerido, nunca de um campo entregue pelo renderer.
export function perfilDeEnsaio(db) {
  try {
    const arquivo = db.prepare('PRAGMA database_list').all().find(x => x.name === 'main')?.file;
    if (!arquivo) return false;
    const root = dirname(arquivo);
    const marca = join(root, '.lume-notetaker-test'), stat = lstatSync(marca);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const marker = readFileSync(marca, 'utf8').trim();
    conferirPerfilTeste({ notetakerExperimento: true, testProfileRoot: root, testMarker: marker });
    conferirBancoPerfil(db, root);
    return true;
  } catch { return false; }
}

export function fonteAcionavelReuniao(db, eventoId, { anchor = '' } = {}) {
  if (!Number.isSafeInteger(eventoId) || eventoId < 1 || !perfilDeEnsaio(db)) return null;
  try {
    const row = db.prepare(`SELECT e.id,e.tipo,e.texto,nf.revisao fonte_revisao,
      nf.inicio_ms fonte_inicio,nf.fim_ms fonte_fim,nt.revisao trecho_revisao,
      nt.inicio_ms trecho_inicio,nt.fim_ms trecho_fim,
      COALESCE(nt.texto_corrigido,nt.texto_gerado) texto_revisado
      FROM eventos e JOIN notetaker_fontes nf ON nf.evento_id=e.id
      JOIN notetaker_trechos nt ON nt.id=nf.trecho_id
      WHERE e.id=?`).get(eventoId);
    if (!row || row.tipo !== 'notetaker_trecho' || row.texto !== row.texto_revisado ||
        row.fonte_revisao !== row.trecho_revisao || row.fonte_inicio !== row.trecho_inicio ||
        row.fonte_fim !== row.trecho_fim) return null;
    const fonte = new LumeMcpReadService(db).fonte(eventoId, { kind: 'all' }, { anchor });
    return fonte?.source_type === 'reuniao_local' && Number.isSafeInteger(fonte.source_time_ms) ? fonte : null;
  } catch { return null; }
}

export function retornoFonteReuniao(fonte) {
  return fonte?.source_type === 'reuniao_local' ? {
    evento_id: fonte._id, source_type: 'reuniao_local',
    source_time_ms: fonte.source_time_ms, source_end_ms: fonte.source_end_ms
  } : null;
}

export function chaveAcaoReuniao(db, eventoId, { fonte_assinatura, tipo, trecho_inicio, trecho } = {}) {
  try {
    const meta = db.prepare(`SELECT nf.sessao_id,nf.parte_id,nf.trecho_id,nf.inicio_ms,nf.fim_ms,
      nf.audio_sha256,nf.revisao,p.posicao
      FROM notetaker_fontes nf JOIN notetaker_partes p ON p.id=nf.parte_id
      WHERE nf.evento_id=?`).get(eventoId);
    if (!meta || typeof fonte_assinatura !== 'string' || typeof tipo !== 'string' ||
        !Number.isSafeInteger(trecho_inicio) || typeof trecho !== 'string') return null;
    return createHash('sha256').update(JSON.stringify([eventoId,fonte_assinatura,
      meta.sessao_id,meta.parte_id,meta.trecho_id,meta.posicao,meta.inicio_ms,meta.fim_ms,
      meta.audio_sha256,meta.revisao,tipo,trecho_inicio,trecho])).digest('hex');
  } catch { return null; }
}
