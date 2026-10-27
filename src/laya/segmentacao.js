// Candidatos literais de alta especificidade. Não atribui responsabilidade nem executa ações.
import {descartarMudancaDeEstado} from './state-guard.js';
const normalizar=valor=>valor.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR');
const IMPERATIVO=/^(?:me\s+)?(?:manda|mande|envie|encaminhe|confirme?|verifique|veja|revisa|revise|organiza?|organize|agende|marc[ae]|marque|separa|separe|prepara|prepare|checa|cheque|consulte|valide|anexe|avisa|avise|lembra?|lembre|ligue|responda|atualize|pergunta|pergunte|reserve|confira|confere|fa[cç]a|passa|passe|pe[cç]a|solicite|inclua|procure|olhe|proponha|acrescente|traga|teste|registre|leia|indique|anote|ajuste|fotografe|ache|descubra|compare|reuna|escolha|leve|recolha|providencie|apure|selecione|numere|limpe|levante|diga|identifique|conte|liste|calibre|examine|copie|localize)\b/u;
const PEDIDO=/^(?:(?:voce\s+)?(?:pode|consegue|poderia|manda|envia|confirma)\b|tem\s+como\b|me\s+ajude\s+a\b|quero\s+que\s+voce\b|da\s+para\b|preciso\s+(?:que\s+)?|falta\s+|a\s+gente\s+precisa\b|vamos\s+marcar\b|favor\s+|nao\s+esqueca\b|qual\s+.+\bdevo\b)/u;
const PROMESSA=/^(?:(?:eu\s+(?:mesmo\s+)?)?(?:vou|farei|assumo|preparo|envio|deixo|mando|ligo|vejo|fico\s+(?:responsavel|de\s+[a-z]+|com\s+(?:a|o)\s+(?:checagem|revisao|preparacao|organizacao|coordenacao|montagem|envio|entrega|contato|retorno|devolucao))|fica\s+comigo\s+(?:a|o)\s+(?:checagem|revisao|preparacao|organizacao|coordenacao|montagem|envio|entrega|contato|retorno|devolucao)|mandarei|levarei|levo|encaminho|atualizo|organizo|reviso|separo|confirmo|confiro|verifico|registro|compartilho|aviso|peco|faco|testo|apresento|busco|documento|ajusto|comparo|escolho|reuno|conto|retorno|trago|entrego|solicito|consulto|telefono|limpo|guardo|desenho|marco|volto)\b|te\s+(?:ligo|passo)\b)/u;
const INFINITIVO_SEQUENCIAL=/^[a-z]{2,}(?:ar|er|ir)\b/u;
const VERIFICACAO_CONDICIONAL=/^(?:confira|confere|verifique|valide|localize|traga|solicite|peca|consulte|revise|cheque|examine)\b/u;
const INCERTO=/\b(?:talvez|quem\s+sabe|acho\s+que|pode\s+ser\s+que|ainda\s+nao\s+decidi|se\s+o\s+cliente\s+aprovar)\b/u;
const CANCELADO=/\b(?:cancelei|desconsider(?:a|ar|e)|ignore\s+(?:meu|minha|a|as|o|os|todas)|nao\s+(?:preciso|vou|ha|tem|sera|aconteceu|conclua|envie|anuncie))\b/u;
const CONCLUIDO=/\b(?:ja\s+(?:enviei|entreguei|revisei|conclui|foi\s+(?:enviado|entregue|confirmado))|foi\s+(?:enviado|entregue|confirmado|recusado))\b/u;
const META=/\b(?:(?:mensagem|instruc(?:ao|oes))\s+para\s+(?:(?:a\s+)?ia|(?:o\s+)?(?:robo|bot|assistente|lume))|ignore\s+(?:as\s+regras|o\s+historico)|regras\s+do\s+lume|sem\s+fonte|marque\s+tudo\s+como\s+resolvido)\b/u;
const DISCURSO=/^(?:(?:\[audio\s+transcrito\]|oi,?\s+uma\s+coisa|por\s+favor|por\s+gentileza|quando\s+puder|quando\s+terminar\s+[^,]{1,60},|antes\s+de\s+[^,]{1,60},|antes\s+da\s+[a-z]+|depois\s+de\s+[a-z]+(?:\s+[a-z]+){0,5}(?=\s+eu\b)|depois\s+da\s+(?:call|reuniao)|depois\s+da\s+[a-z]+(?=\s+eu\b)|depois\s+do\s+[a-z]+|depois|em\s+seguida|so\s+entao|tambem|assim\s+que\s+chegar|assim\s+que\s+terminar\s+a\s+reuniao|hoje\s+a\s+noite|ainda\s+hoje|hoje|primeiro|por\s+ultimo|por\s+fim|mais\s+tarde|de\s+manha|a\s+noite|na\s+proxima\s+reuniao|na\s+semana\s+que\s+vem|na\s+(?:segunda|terca|quinta|sexta)|no\s+(?:sabado|domingo)|amanha(?:\s+cedo)?|ate\s+quarta|pessoal|equipe|fabricio|pode\s+deixar(?:\s+que)?|sim|ficou\s+combinado)\s*[:,]?\s*)+/u;

function frases(texto){
  const out=[];let inicio=0;
  for(let i=0;i<texto.length;i++)if(/[.!?;]/u.test(texto[i])&&(i===texto.length-1||/\s/u.test(texto[i+1]))){
    const trecho=texto.slice(inicio,i+1).trim();if(trecho)out.push(trecho);
    inicio=i+1;
  }
  const resto=texto.slice(inicio).trim();if(resto)out.push(resto);
  return out;
}
function partes(frase){
  const out=[];let inicio=0;
  for(const match of frase.matchAll(/,(?!\s+(?:mas|e)\b)\s+|\s+e\s+(?:depois\s+)?|\s+mas\s+/giu)){
    const esquerda=frase.slice(inicio,match.index).trim(),direita=frase.slice(match.index+match[0].length).trim();
    if(esquerda.length<8||direita.length<8)continue;
    const anterior=normalizar(esquerda).replace(DISCURSO,''),prox=normalizar(direita).replace(DISCURSO,'');
    if(match[0].startsWith(',')){
      const acaoAntes=IMPERATIVO.test(anterior)||PEDIDO.test(anterior)||PROMESSA.test(anterior);
      const acaoDepois=IMPERATIVO.test(prox)||PEDIDO.test(prox)||PROMESSA.test(prox);
      if(/^se\s+[^,]{8,100}$/u.test(anterior)&&VERIFICACAO_CONDICIONAL.test(prox)){inicio=match.index+match[0].length;continue;}
      if(!acaoAntes||!acaoDepois)continue;
    }
    // Compartilhar ou retornar o material preparado na mesma frase mantém um único compromisso.
    if(/^(?:compartilho|retorno)\b/u.test(prox))continue;
    const sujeitoNovo=/^[A-ZÀ-Ý][a-zà-ÿ]{2,}(?:\s+|,\s*)/u.test(direita);
    if(!match[0].toLocaleLowerCase('pt-BR').includes('mas')&&!sujeitoNovo&&!IMPERATIVO.test(prox)&&!PEDIDO.test(prox)&&!PROMESSA.test(prox)&&!(PROMESSA.test(anterior)&&INFINITIVO_SEQUENCIAL.test(prox)))continue;
    out.push(esquerda);inicio=match.index+match[0].length;
  }
  out.push(frase.slice(inicio).trim());return out.filter(Boolean);
}
function classe(trecho,autor,nomeDono){
  const frase=normalizar(trecho),semDiscurso=frase.replace(DISCURSO,'');
  const dono=normalizar(nomeDono).trim(),resto=semDiscurso.slice(dono.length);
  const nucleo=semDiscurso.startsWith(dono)&&/^[\s,:-]/u.test(resto)?resto.replace(/^[\s,:-]+/u,''):semDiscurso;
  if(META.test(frase)||descartarMudancaDeEstado(frase)||CANCELADO.test(frase)||INCERTO.test(frase))return null;
  if(/^nao\b/u.test(nucleo)&&!/^nao\s+esqueca\b/u.test(nucleo))return null;
  if(/^se\s+/u.test(nucleo)){
    const condicional=nucleo.match(/^se\s+[^,]{8,100},\s*(.+)$/u);
    if(condicional&&autor!=='proprio'&&VERIFICACAO_CONDICIONAL.test(condicional[1]))return 'pendencia';
    return null;
  }
  if(/^(?:o\s+pagamento\s+|a\s+proposta\s+|o\s+prazo\s+|a\s+reuniao\s+foi\s+)/u.test(nucleo))return null;
  if((IMPERATIVO.test(nucleo)||PEDIDO.test(nucleo))&&(autor!=='proprio'||/^voce\s+/u.test(nucleo)))return 'pendencia';
  if(PROMESSA.test(nucleo)&&autor==='proprio'&&!CONCLUIDO.test(frase))return 'compromisso';
  return null;
}

export function proporTrechos({texto,canal='dm',autor='outro',nomeDono='Fabrício'}={}){
  if(typeof texto!=='string'||texto.length>2000||!['dm','grupo'].includes(canal)||!['proprio','outro','terceiro'].includes(autor)||typeof nomeDono!=='string'||!nomeDono.trim()||nomeDono.length>80)throw new Error('Recorte local inválido.');
  if(!texto.trim()||autor==='terceiro'||META.test(normalizar(texto)))return [];
  if(canal==='grupo'&&autor==='outro'&&!normalizar(texto).includes(normalizar(nomeDono)))return [];
  const result=[];let pedidoDirigido=false;
  for(const frase of frases(texto)){
    let compromissoNaFrase=false;
    for(const trecho of partes(frase)){
    if(trecho.length<8||trecho.length>300||texto.indexOf(trecho)!==texto.lastIndexOf(trecho))continue;
    const citaDono=normalizar(trecho).includes(normalizar(nomeDono));
    if(canal==='grupo'&&autor==='outro'&&!citaDono){
      if(/^[A-ZÀ-Ý][a-zà-ÿ]+,/u.test(trecho))pedidoDirigido=false;
      const nucleo=normalizar(trecho).replace(DISCURSO,'');
      if(!pedidoDirigido||!IMPERATIVO.test(nucleo))continue;
    }
    const tipo=classe(trecho,autor,nomeDono)??(autor==='proprio'&&compromissoNaFrase&&INFINITIVO_SEQUENCIAL.test(normalizar(trecho))?'compromisso':null);
    if(tipo)result.push({tipo,trecho});
    if(tipo==='compromisso')compromissoNaFrase=true;
    if(canal==='grupo'&&autor==='outro'&&normalizar(trecho).startsWith(normalizar(nomeDono)))pedidoDirigido=true;
    if(result.length>=32)return result;
  }
  }
  return result;
}
