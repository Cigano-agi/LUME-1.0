import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { criarOrigemV10 } from './backup-acervo-v10.js';
import { gravarPacote } from './backup-stream.js';
import { validarAcervoV10, aplicarAcervoV10, descartarPlanoV10 } from './backup-acervo-restore-v9.js';
import { recuperarAplicacaoV10 } from './backup-acervo-apply-v10.js';

function exigirCaminho(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    const error = new Error('Caminho absoluto normalizado obrigatório.');
    error.code = 'CAMINHO_INVALIDO';
    throw error;
  }
}

function inventarioAudio(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const transcricoes=db.prepare("SELECT arquivo FROM transcricoes WHERE arquivo IS NOT NULL AND arquivo <> '' ORDER BY arquivo")
      .all().map(({ arquivo }) => ({ classe: 'transcricao', caminho: arquivo }));
    const midias=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ciclo_midias'").get()
      ?db.prepare('SELECT caminho FROM ciclo_midias ORDER BY evento_id').all()
        .map(({caminho})=>({classe:'ciclo_midia',caminho})):[];
    return [...transcricoes,...midias];
  } finally { db.close(); }
}

/** Grava arquivo novo e criptografado. O inventário de áudio é extraído do banco. */
export async function exportarBackupV10({ dbPath, destino, senha, dono, signal } = {}) {
  exigirCaminho(dbPath);
  exigirCaminho(destino);
  const origem = await criarOrigemV10({ dbPath, arquivos: inventarioAudio(dbPath), perfil: { dono }, signal });
  try {
    const pacote = await gravarPacote({ origem: origem.origem, destino, senha, signal });
    return { versao: 10, destino: pacote.destino, bytesClaros: pacote.bytes, partes: pacote.partes,
      anexos: origem.resumo.anexos };
  } finally { await origem.fechar(); }
}

/** Valida todo o arquivo antes de publicar em perfil ausente. Nunca mescla no perfil ativo. */
export async function restaurarBackupV10({ pacote, senha, raizStaging, destinoNovo, confirmarMeuBackup, signal } = {}) {
  exigirCaminho(pacote);
  exigirCaminho(raizStaging);
  exigirCaminho(destinoNovo);
  if (confirmarMeuBackup !== true) {
    const error = new Error('Confirme que o backup é seu.');
    error.code = 'CONFIRMACAO_OBRIGATORIA';
    throw error;
  }
  const { plano, resumo } = await validarAcervoV10({ pacote, senha, raizStaging, signal });
  try {
    const resultado = await aplicarAcervoV10({ plano, destinoNovo, confirmarMeuBackup: true });
    return { ...resultado, resumo };
  } catch (error) {
    await descartarPlanoV10(plano).catch(() => {});
    throw error;
  }
}

/** Só use depois da confirmação de que o processo publicador encerrou. */
export async function recuperarBackupV10({ destinoNovo, publicadorEncerrado } = {}) {
  exigirCaminho(destinoNovo);
  return recuperarAplicacaoV10({ destinoNovo, publicadorEncerrado });
}
