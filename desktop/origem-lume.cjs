// Destino do produto. O alias antigo só mantém compatibilidade com políticas
// já geradas; novas versões e chamadas da Central usam o domínio da marca.
const ORIGEM_LUME = 'https://lume.gypsiventures.com';
const ORIGEM_LEGADA = 'https://lume-crm-fawn.vercel.app';
function origemPermitida(url) {
  return url.protocol === 'https:' && !url.username && !url.password &&
    (url.origin === ORIGEM_LUME || url.origin === ORIGEM_LEGADA);
}
function feedAtualizacoes(canal) {
  if (!['beta', 'estavel'].includes(canal)) throw new TypeError('Canal inválido');
  return `${ORIGEM_LUME}/releases/${canal}`;
}
module.exports = Object.freeze({ ORIGEM_LUME, origemPermitida, feedAtualizacoes });
