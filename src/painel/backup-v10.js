import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { exportarBackupV10 } from '../backup-acervo-operacao-v10.js';
import { validarAcervoV10, aplicarAcervoV10, descartarPlanoV10 } from '../backup-acervo-restore-v9.js';
import { criarTempBackupPrivado } from '../backup-private-temp.js';
import { prepararAcervoV10 } from '../backup-acervo-preparo-v10.js';

const MAX_UPLOAD = 16 * 1024 * 1024 * 1024;
const ticket = () => randomBytes(32).toString('hex');
const erro = (code, message) => Object.assign(new Error(message), { code });

// Tickets last only in this process. Neither password nor source data is logged or persisted here.
export class BackupPainelV10 {
  constructor(db, owner) {
    this.db = db;
    this.dbPath = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    this.owner = owner;
    this.downloads = new Map();
    this.previews = new Map();
    this.apply = aplicarAcervoV10;
    this.busy = false;
  }
  available() { return Boolean(this.dbPath && path.isAbsolute(this.dbPath)); }
  check() { if (!this.available()) throw erro('PERFIL_SEM_ARQUIVO', 'Backup v10 exige perfil local em disco.'); if (this.busy) throw erro('BACKUP_OCUPADO', 'Aguarde o backup em andamento.'); }
  async export(senha) {
    this.check(); this.busy = true;
    let root;
    try {
      prepararAcervoV10(this.db, path.dirname(path.dirname(this.dbPath)));
      root = await criarTempBackupPrivado('lume-backup-v10-');
      const file = path.join(root, 'backup.lumebak');
      const info = await exportarBackupV10({ dbPath: this.dbPath, destino: file, senha, dono: this.owner() });
      const id = ticket(); this.downloads.set(id, { root, file, at: Date.now() });
      setTimeout(() => this.discardDownload(id), 5 * 60_000).unref();
      return { id, nome: `lume-backup-${new Date().toISOString().slice(0, 10)}.lumebak`, bytes: (await stat(file)).size, anexos: info.anexos };
    } catch (error) { if(root)await rm(root, { recursive: true, force: true }); throw error; }
    finally { this.busy = false; }
  }
  async discardDownload(id) {
    const entry = this.downloads.get(id); if (!entry) return;
    this.downloads.delete(id); await rm(entry.root, { recursive: true, force: true }).catch(() => {});
  }
  async sendDownload(id, res) {
    const entry = this.downloads.get(id);
    if (!entry || Date.now() - entry.at > 5 * 60_000) throw erro('BACKUP_EXPIRADO', 'Prepare outro backup.');
    this.downloads.delete(id);
    const source = createReadStream(entry.file);
    const size = (await stat(entry.file)).size;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="lume-backup-${new Date().toISOString().slice(0, 10)}.lumebak"`, 'Content-Length': size });
    source.on('error', () => res.destroy());
    res.on('close', () => { source.destroy(); void rm(entry.root, { recursive: true, force: true }); });
    source.pipe(res);
  }
  async preview(request, senha) {
    this.check(); this.busy = true;
    let root, handle, plano;
    try {
      root = await criarTempBackupPrivado('lume-restore-v10-');
      const file = path.join(root, 'upload.lumebak');
      if (request.headers['content-type'] !== 'application/octet-stream') throw erro('TIPO_INVALIDO', 'Escolha um arquivo .lumebak.');
      const declared = Number(request.headers['content-length']);
      if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_UPLOAD) throw erro('BACKUP_TAMANHO', 'Arquivo vazio ou acima de 16 GB.');
      handle = await open(file, 'wx', 0o600);
      let total = 0;
      for await (const chunk of request) {
        total += chunk.length;
        if (total > MAX_UPLOAD || total > declared) throw erro('BACKUP_TAMANHO', 'Tamanho do arquivo inválido.');
        await handle.writeFile(chunk);
      }
      if (total !== declared) throw erro('BACKUP_INCOMPLETO', 'Arquivo incompleto.');
      await handle.close(); handle = null;
      const staging = path.join(root, 'staging');
      await mkdir(staging);
      const validated = await validarAcervoV10({ pacote: file, senha, raizStaging: staging });
      plano = validated.plano;
      const id = ticket();
      this.previews.set(id, { root, plano, at: Date.now(), resumo: validated.resumo, expiraEm: validated.expiraEm });
      setTimeout(() => this.discardPreview(id), 5 * 60_000).unref();
      return { id, resumo: validated.resumo, expiraEm: validated.expiraEm };
    } catch (error) {
      if (plano) await descartarPlanoV10(plano).catch(() => {});
      if(root)await rm(root, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally { await handle?.close().catch(() => {}); this.busy = false; }
  }
  async discardPreview(id) {
    const entry = this.previews.get(id); if (!entry) return;
    this.previews.delete(id);
    await descartarPlanoV10(entry.plano).catch(() => {});
    await rm(entry.root, { recursive: true, force: true }).catch(() => {});
  }
  async restore(id, confirmed) {
    this.check(); if (confirmed !== true) throw erro('CONFIRMACAO_OBRIGATORIA', 'Confirme que o backup é seu.');
    const entry = this.previews.get(id);
    if (!entry || Date.now() >= Date.parse(entry.expiraEm)) throw erro('BACKUP_EXPIRADO', 'Confira o backup novamente.');
    this.busy = true;
    // Consome o ticket antes da publicação: o temporizador da prévia não pode
    // apagar staging enquanto a aplicação de um acervo grande ainda trabalha.
    this.previews.delete(id);
    const activeRoot = path.dirname(path.dirname(this.dbPath));
    const destination = path.join(path.dirname(activeRoot), `Lume-restaurado-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`);
    try {
      const result = await this.apply({ plano: entry.plano, destinoNovo: destination, confirmarMeuBackup: true });
      return { ...result, aviso: 'Perfil novo criado. O perfil atual e a conexão continuam intactos. Esta versão ainda não alterna perfis restaurados.' };
    } finally {
      this.busy = false;
      await descartarPlanoV10(entry.plano).catch(() => {});
      await rm(entry.root, { recursive: true, force: true }).catch(() => {});
    }
  }
}
