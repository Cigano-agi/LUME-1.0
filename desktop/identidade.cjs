'use strict';
// package.json is the single commercial and technical identity source.
// Neither version changes the existing appId or AssessorDesktop profile.
const pacote = require('../package.json');
const NOME = pacote.lume.nome;
const VERSAO_COMERCIAL = pacote.lume.versaoComercial;
const VERSAO_TECNICA = pacote.version;
module.exports = Object.freeze({
  NOME, VERSAO_COMERCIAL, VERSAO_TECNICA,
  TITULO: `${NOME} ${VERSAO_COMERCIAL}`,
  COR: pacote.lume.cor,
  sobre: `${NOME} ${VERSAO_COMERCIAL} · Versão técnica ${VERSAO_TECNICA}`,
});
