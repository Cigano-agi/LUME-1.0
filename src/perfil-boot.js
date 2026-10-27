import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { resolverPerfilAtivo } from './perfil-ativo.js';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

const PUBLIC_CODES = new Set([
  'PERFIL_CAMINHO_INVALIDO', 'PERFIL_DESTINO_INVALIDO', 'PERFIL_IDENTIDADE_DIVERGENTE',
  'PERFIL_RECUPERACAO_PENDENTE', 'PERFIL_SELECAO_PENDENTE', 'PERFIL_SELETOR_INVALIDO',
  'PERFIL_ENVELOPE_INVALIDO', 'PERFIL_SELECAO_ALTERADA', 'PERFIL_SELECAO_INVALIDA',
  'PERFIL_CAMINHO_DIVERGENTE', 'PERFIL_MANUTENCAO_PENDENTE'
]);

export function erroPublicoPerfil(error) {
  if (error?.code === 'PERFIL_GERIDO_AGUARDANDO_BROKER') return { code: error.code, message: 'Este perfil ainda não pode ser aberto nesta versão do Lume.' };
  if (PUBLIC_CODES.has(error?.code)) return { code: error.code, message: 'A seleção do perfil precisa ser verificada.' };
  return { code: 'PERFIL_VERIFICACAO_FALHOU', message: 'O Lume não conseguiu verificar o perfil.' };
}

export async function prepararRaizElectron(userData) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData) || path.normalize(userData) !== userData) fail('PERFIL_CAMINHO_INVALIDO');
  const root = path.parse(userData).root;
  const segments = path.relative(root, userData).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || i !== segments.length - 1) fail('PERFIL_CAMINHO_INVALIDO');
      try { await mkdir(current); info = await lstat(current); }
      catch { fail('PERFIL_CAMINHO_INVALIDO'); }
    }
    if (info.isSymbolicLink() || !info.isDirectory()) fail('PERFIL_CAMINHO_INVALIDO');
  }
}

export async function selecionarPerfilBoot(userData) {
  try {
    await lstat(userData + '.lume-v10-reserva');
    fail('PERFIL_RECUPERACAO_PENDENTE');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const selection = await resolverPerfilAtivo({ userData });
  if (selection.tipo === 'gerido') fail('PERFIL_GERIDO_AGUARDANDO_BROKER');
  if (selection.tipo !== 'legado' || selection.id !== 'legado' || selection.geracao !== null) fail('PERFIL_SELETOR_INVALIDO');
  return selection;
}

export function envelopeLegado(userData, selection) {
  if (selection?.tipo !== 'legado' || selection.id !== 'legado' || selection.geracao !== null || selection.dataDir !== path.join(userData, 'data')) fail('PERFIL_ENVELOPE_INVALIDO');
  return {
    ASSESSOR_DESKTOP_USER_DATA: userData,
    ASSESSOR_DESKTOP_PROFILE_ID: 'legado',
    ASSESSOR_DESKTOP_PROFILE_GENERATION: '',
    ASSESSOR_DESKTOP_DATA: selection.dataDir
  };
}

export async function validarEnvelopeLegado(env) {
  const allowed = new Set(['ASSESSOR_DESKTOP_USER_DATA', 'ASSESSOR_DESKTOP_PROFILE_ID', 'ASSESSOR_DESKTOP_PROFILE_GENERATION', 'ASSESSOR_DESKTOP_DATA']);
  if (Object.keys(env ?? {}).some(name => name.startsWith('ASSESSOR_DESKTOP_') && !allowed.has(name))) fail('PERFIL_ENVELOPE_INVALIDO');
  if (typeof env?.ASSESSOR_DESKTOP_USER_DATA !== 'string' || !env.ASSESSOR_DESKTOP_USER_DATA ||
      env.ASSESSOR_DESKTOP_PROFILE_ID !== 'legado' ||
      (env.ASSESSOR_DESKTOP_PROFILE_GENERATION !== '' && env.ASSESSOR_DESKTOP_PROFILE_GENERATION !== undefined) ||
      (env.ASSESSOR_DESKTOP_DATA !== undefined && typeof env.ASSESSOR_DESKTOP_DATA !== 'string')) fail('PERFIL_ENVELOPE_INVALIDO');
  const selection = await selecionarPerfilBoot(env.ASSESSOR_DESKTOP_USER_DATA);
  if (env.ASSESSOR_DESKTOP_DATA !== undefined && env.ASSESSOR_DESKTOP_DATA !== selection.dataDir) fail('PERFIL_ENVELOPE_INVALIDO');
  return selection;
}

export function userDataMcp({ platform = process.platform, env = process.env } = {}) {
  const syntax = platform === 'win32' ? path.win32 : platform === 'darwin' ? path.posix : null;
  const root = platform === 'win32' ? env.APPDATA && syntax.join(env.APPDATA, 'AssessorDesktop')
    : platform === 'darwin' ? env.HOME && syntax.join(env.HOME, 'Library', 'Application Support', 'AssessorDesktop') : null;
  if (typeof root !== 'string' || !syntax?.isAbsolute(root) || syntax.normalize(root) !== root) fail('PERFIL_CAMINHO_INVALIDO');
  return root;
}

export function validarSelecaoEsperada(selection, expected) {
  if (!expected || Object.getPrototypeOf(expected) !== Object.prototype ||
      Reflect.ownKeys(expected).sort().join(',') !== 'geracao,id,tipo' ||
      selection.tipo !== expected.tipo || selection.id !== expected.id || selection.geracao !== expected.geracao) fail('PERFIL_SELECAO_ALTERADA');
  return selection;
}
