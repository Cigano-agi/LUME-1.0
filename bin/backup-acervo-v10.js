#!/usr/bin/env node
import { exportarBackupV10, restaurarBackupV10, recuperarBackupV10 } from '../src/backup-acervo-operacao-v10.js';

const usage = `Uso:
  node bin/backup-acervo-v10.js export --db CAMINHO --out ARQUIVO --dono NOME
  node bin/backup-acervo-v10.js restore --in ARQUIVO --staging PASTA --new-profile PASTA --confirm-owner
  node bin/backup-acervo-v10.js recover --new-profile PASTA --publisher-exited

Export e restore leem a senha de uma linha da entrada padrão. Não passe a senha na linha de comando.
Restore só cria um perfil novo e ausente. Recover exige o publicador encerrado.
`;

function parse(args) {
  const [action, ...rest] = args;
  if (!['export', 'restore', 'recover'].includes(action)) throw Error('ACAO_INVALIDA');
  const options = new Map();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith('--') || options.has(key)) throw Error('ARGUMENTO_INVALIDO');
    if (['--confirm-owner', '--publisher-exited'].includes(key)) options.set(key, true);
    else { if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) throw Error('ARGUMENTO_INVALIDO'); options.set(key, rest[++i]); }
  }
  const required = action === 'export' ? ['--db','--out','--dono'] :
    action === 'restore' ? ['--in','--staging','--new-profile','--confirm-owner'] :
      ['--new-profile','--publisher-exited'];
  const allowed = new Set(required);
  if (options.size !== required.length || required.some(k => !options.has(k)) || [...options.keys()].some(k => !allowed.has(k)))
    throw Error('ARGUMENTO_INVALIDO');
  return { action, options };
}

async function passwordLine() {
  if (process.stdin.isTTY) {
    process.stderr.write('Senha do backup (entrada oculta): ');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    try {
      return await new Promise((resolve, reject) => {
        let value = '';
        function onData(chunk) {
          for (const char of chunk.toString('utf8')) {
            if (char === '\r' || char === '\n') { process.stdin.off('data', onData); process.stderr.write('\n'); resolve(value); return; }
            if (char === '\u0003') { process.stdin.off('data', onData); reject(Error('CANCELADO')); return; }
            if (char === '\u007f' || char === '\b') { value = value.slice(0, -1); continue; }
            if (value.length >= 256) { process.stdin.off('data', onData); reject(Error('SENHA_INVALIDA')); return; }
            value += char;
          }
        }
        process.stdin.on('data', onData);
      });
    } finally { process.stdin.setRawMode(false); process.stdin.pause(); }
  }
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk.toString('utf8');
    if (value.length > 258) throw Error('SENHA_INVALIDA');
    if (value.includes('\n')) break;
  }
  return value.split(/\r?\n/, 1)[0];
}

async function main() {
  const { action, options } = parse(process.argv.slice(2));
  if (action === 'recover') {
    const result = await recuperarBackupV10({ destinoNovo: options.get('--new-profile'), publicadorEncerrado: true });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  const senha = await passwordLine();
  if (action === 'export') {
    const result = await exportarBackupV10({ dbPath: options.get('--db'), destino: options.get('--out'),
      dono: options.get('--dono'), senha });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  const result = await restaurarBackupV10({ pacote: options.get('--in'), senha,
    raizStaging: options.get('--staging'), destinoNovo: options.get('--new-profile'), confirmarMeuBackup: true });
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch(error => {
  process.stderr.write(`Backup v10 não concluído: ${error?.code || error?.message || 'ERRO'}\n${usage}`);
  process.exitCode = 1;
});
