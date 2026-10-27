// Experimento local: propor cláusulas com offsets sem depender de uma lista de verbos.
// A proposta não cria ações nem altera a porta de qualidade do produto.
import {descartarMudancaDeEstado} from './state-guard.js';

const normalizar=valor=>valor.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR');
const META=/\b(?:instruc(?:ao|oes)\s+para\s+(?:a\s+)?(?:ia|bot|robo|assistente|lume)|ignore\s+(?:as\s+regras|o\s+historico)|regras\s+do\s+lume)\b|<\/?system>/u;
const NEGACAO=/^(?:nao\b|cancele\b|cancela\b|desconsidere\b|desconsiderar\b|ignore\b)/u;
const FINALIZADO=/\b(?:ja\s+(?:enviei|entreguei|conclui|paguei)|foi\s+(?:enviado|entregue|confirmado|pago|aceito|concluido))\b/u;
const ENDERECAMENTO=/^([A-ZÀ-Ý][a-zà-ÿ]{2,}(?:\s+[A-ZÀ-Ý][a-zà-ÿ]{2,}){0,2}),\s*/u;

function aparar(texto,inicio,fim){
  while(inicio<fim&&/\s/u.test(texto[inicio]))inicio++;
  while(fim>inicio&&/\s/u.test(texto[fim-1]))fim--;
  return {inicio,fim};
}

function frases(texto){
  const ranges=[];let inicio=0;
  for(let i=0;i<texto.length;i++){
    if(!(/[.!?;\n]/u.test(texto[i])&&(i===texto.length-1||/[\s\n]/u.test(texto[i+1]))))continue;
    const range=aparar(texto,inicio,i+1);
    if(range.fim>range.inicio)ranges.push(range);
    inicio=i+1;
  }
  const ultimo=aparar(texto,inicio,texto.length);
  if(ultimo.fim>ultimo.inicio)ranges.push(ultimo);
  return ranges;
}

function partes(texto,{inicio,fim}){
  const ranges=[];let atual=inicio;
  const trecho=texto.slice(inicio,fim);
  for(const match of trecho.matchAll(/,\s+|\s+e\s+|\s+mas\s+/giu)){
    const pos=inicio+match.index;
    if(pos-atual<8||fim-(pos+match[0].length)<8)continue;
    const esquerda=aparar(texto,atual,pos);
    if(esquerda.fim>esquerda.inicio)ranges.push(esquerda);
    atual=pos+match[0].length;
  }
  const ultima=aparar(texto,atual,fim);
  if(ultima.fim>ultima.inicio)ranges.push(ultima);
  return ranges;
}

function acaoPossivel(trecho){
  const normal=normalizar(trecho).replace(/^(?:depois|em\s+seguida|so\s+entao|por\s+fim|hoje|amanha|primeiro)\s*[:,]?\s*/u,'');
  if(NEGACAO.test(normal)||FINALIZADO.test(normal)||descartarMudancaDeEstado(normal))return false;
  if(/^se\s+[^,]*$/u.test(normal))return false;
  if(/^\d+[.)]?$/u.test(normal))return false;
  return true;
}

export function proporClausulas({texto,canal='dm',autor='outro',nomeDono='Fabrício'}={}){
  if(typeof texto!=='string'||texto.length>2000||!['dm','grupo'].includes(canal)||
    !['proprio','outro','terceiro'].includes(autor)||typeof nomeDono!=='string'||
    !nomeDono.trim()||nomeDono.length>80)throw Error('LAYA_CLAUSULAS_ENTRADA_INVALIDA');
  if(!texto.trim()||autor==='terceiro'||META.test(normalizar(texto)))return [];
  const dono=normalizar(nomeDono).trim(),candidatas=[];
  let dirigido=false;
  for(const faixa of frases(texto).slice(0,8)){
    const frase=texto.slice(faixa.inicio,faixa.fim);
    const nome=frase.match(ENDERECAMENTO)?.[1];
    if(canal==='grupo'&&autor==='outro'&&nome)dirigido=normalizar(nome)===dono;
    if(canal==='grupo'&&autor==='outro'&&!dirigido)continue;
    for(const parte of partes(texto,faixa)){
      const trecho=texto.slice(parte.inicio,parte.fim);
      if(trecho.length<8||trecho.length>300||!acaoPossivel(trecho))continue;
      if(normalizar(trecho).replace(/,\s*$/u,'')===dono)continue;
      if(ENDERECAMENTO.test(trecho)&&trecho.endsWith(','))continue;
      candidatas.push({tipo:autor==='proprio'?'compromisso':'pendencia',trecho,inicio:parte.inicio,fim:parte.fim,dirigido:canal==='grupo'&&autor==='outro'});
      if(candidatas.length>=16)return candidatas;
    }
  }
  return candidatas;
}
