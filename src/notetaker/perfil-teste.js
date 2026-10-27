import { realpathSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

const erro = (code, message) => Object.assign(new Error(message), { code });

export function conferirPerfilTeste({ notetakerExperimento, testProfileRoot, testMarker } = {}) {
  if (notetakerExperimento !== true || typeof testProfileRoot !== 'string' ||
      typeof testMarker !== 'string' || !/^[0-9a-f-]{36}$/i.test(testMarker))
    throw erro('FECHADO', 'Notetaker indisponível neste perfil.');
  let root, temp;
  try {
    root = realpathSync(testProfileRoot); temp = realpathSync(tmpdir());
    const marca = join(root, '.lume-notetaker-test');
    if (lstatSync(testProfileRoot).isSymbolicLink() || lstatSync(marca).isSymbolicLink() ||
        !relative(temp, root) || relative(temp, root).startsWith('..' + sep) ||
        relative(temp, root) === '..' || !basename(root).startsWith('lume-notetaker-') ||
        process.env.ASSESSOR_DESKTOP_TEST_PROFILE !== root ||
        readFileSync(marca, 'utf8').trim() !== testMarker) throw Error();
  } catch { throw erro('FECHADO', 'Notetaker indisponível neste perfil.'); }
  return root;
}

export function conferirBancoPerfil(db, root) {
  try {
    const declarado = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    if (!declarado || lstatSync(declarado).isSymbolicLink()) throw Error();
    const real = realpathSync(declarado), rel = relative(root, real);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) ||
        !lstatSync(real).isFile()) throw Error();
    return real;
  } catch { throw erro('FECHADO', 'Banco fora do perfil de teste; nenhuma sessão foi preparada.'); }
}
