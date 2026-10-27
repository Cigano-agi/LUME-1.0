import { lstatSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

const fail = code => Object.assign(new Error(code), { code });

function markerAbsent(target) {
  try { lstatSync(target); return false; }
  catch (error) {
    if (error.code === 'ENOENT') return true;
    throw fail('PERFIL_MANUTENCAO_PENDENTE');
  }
}

/** Bloqueia o boot normal enquanto houver manutenção ou exclusão pendente. */
export function assertNormalBootAllowed(userData) {
  if (typeof userData !== 'string' || !isAbsolute(userData) ||
      normalize(userData) !== userData || userData.includes('\0')) {
    throw fail('PERFIL_CAMINHO_INVALIDO');
  }
  if (!markerAbsent(join(userData, 'perfil-manutencao.json')) ||
      !markerAbsent(join(userData, 'notetaker-delete-journal'))) {
    throw fail('PERFIL_MANUTENCAO_PENDENTE');
  }
}
