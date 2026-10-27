// Sinais textuais, não um classificador de fidelidade do áudio. Falsos positivos são possíveis.
const PREAMBULO = /^(?:aqui est[áa] a?\s*)?transcri[çc][ãa]o(?: do [áa]udio)?\s*:\s*/i;
export function sinaisTextoModelo(texto) {
  if (typeof texto !== 'string') return [];
  const sinais=[];
  if(PREAMBULO.test(texto.trim()))sinais.push('Preâmbulo de transcrição: pode ter sido acrescentado pelo modelo.');
  if(/(?:^|\n)\s*(?:como (?:um|uma) (?:modelo|inteligência artificial)|as an ai|não (?:posso|consigo|consegui) (?:ouvir|acessar|transcrever)|i (?:cannot|can.t) (?:hear|access|transcribe))/i.test(texto))sinais.push('Autorreferência ou aviso de limitação do modelo.');
  if(/<\/?(?:think|analysis)>|\[\/?(?:analysis|final)\]/i.test(texto))sinais.push('Marcador de raciocínio ou resposta de modelo.');
  if(/(?:^|\n)\s*(?:resumo|análise|observa[çc][õo]es|sugest[õo]es|recomenda[çc][õo]es)\s*:/i.test(texto))sinais.push('Seção de resumo ou comentário: confira se foi realmente falada.');
  return sinais;
}
export function tratarTranscricao(bruto) {
  let texto=String(bruto??'').trim().replace(PREAMBULO,'');
  // Só retira um par completo; não apaga sinais soltos da fala.
  if(texto.length>=2&&['"',"'",'`'].includes(texto[0])&&texto.at(-1)===texto[0])texto=texto.slice(1,-1).trim();
  return /^\(?sem fala\)?$/i.test(texto)||!texto ? null : texto;
}
export function validarRespostasTranscricao(respostas) {
  return Array.isArray(respostas)&&respostas.length>=1&&respostas.length<=2&&respostas.every(r=>r&&typeof r==='object'&&Object.keys(r).sort().join(',')==='duracaoMs,textoOriginal'&&typeof r.textoOriginal==='string'&&(r.duracaoMs===null||Number.isFinite(r.duracaoMs)&&r.duracaoMs>=0));
}
