import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const directory=new URL('./',import.meta.url);
const panel=new URL('../../src/painel/',directory);
const [renderer,mascotCss,regular,bold]=await Promise.all([
  readFile(new URL('lume-soft-mascote.js',panel),'utf8'),readFile(new URL('lume-soft-mascote.css',panel),'utf8'),
  readFile(new URL('fonts/open-runde-regular.woff2',panel)),readFile(new URL('fonts/open-runde-bold.woff2',panel))
]);
const browser=await chromium.launch({channel:process.env.LUME_MARKETING_BROWSER_CHANNEL||'msedge',headless:true});
let art;
try{const page=await browser.newPage();await page.setContent('<html lang="pt-BR"><body></body></html>');await page.addScriptTag({content:renderer});art=await page.evaluate(()=>Object.fromEntries(['aguardando','acolhimento','curiosidade','leitura','celebracao','buscando'].map(estado=>[estado,LumeMascote.criar({estado,previa:true}).outerHTML])));}finally{await browser.close();}
const fontCss=`@font-face{font-family:Runde;src:url(data:font/woff2;base64,${regular.toString('base64')}) format('woff2');font-weight:400}@font-face{font-family:Runde;src:url(data:font/woff2;base64,${bold.toString('base64')}) format('woff2');font-weight:700}text{font-family:Runde,Arial,sans-serif}`;
const ghost=(state,x,y,width)=>`<g transform="translate(${x} ${y}) scale(${width/180})">${art[state].replace('class="ls-mascote"','class="ls-mascote" width="180" height="164"')}</g>`;
const start=(height,title,description)=>`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="${height}" viewBox="0 0 1280 ${height}" role="img" aria-labelledby="title description"><title id="title">${title}</title><desc id="description">${description}</desc><style>${fontCss}${mascotCss}.ls-mascote{width:180px;height:164px}</style>`;
const banner=start(520,'LUME 1.0 — clareza para o próximo passo','Banner editorial marfim, menta e amarelo. Um fantasma com lanterna recebe você. Memória com fontes, companhia discreta e controles locais.')+`
<defs><linearGradient id="halo" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff3b0"/><stop offset="1" stop-color="#fae6b4"/></linearGradient><filter id="soft" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#1e3a34" flood-opacity=".07"/></filter></defs>
<rect width="1280" height="520" rx="40" fill="#f6f6ef"/>
<rect x="20" y="20" width="1240" height="480" rx="32" fill="#fffefa" stroke="#e4e7df" filter="url(#soft)"/>
<rect x="806" y="38" width="434" height="444" rx="30" fill="url(#halo)"/>
<circle cx="1023" cy="259" r="151" fill="#fffbe4" opacity=".55"/>
<text x="70" y="109" fill="#1e3a34" font-size="46" font-weight="700" letter-spacing="-2">lume</text><rect x="202" y="73" width="62" height="36" rx="18" fill="#f4ce46"/><text x="233" y="98" fill="#33482c" font-size="18" text-anchor="middle" font-weight="700">1.0</text>
<text x="70" y="217" fill="#1e3a34" font-size="57" font-weight="700" letter-spacing="-2.5">Clareza para</text>
<text x="70" y="282" fill="#1e3a34" font-size="57" font-weight="700" letter-spacing="-2.5">o próximo passo.</text>
<text x="72" y="337" fill="#63756b" font-size="22">Suas conversas, um fio para retomar.</text>
<rect x="70" y="389" width="195" height="43" rx="21.5" fill="#e4f1e9"/><text x="167.5" y="417" fill="#315746" font-size="16" font-weight="700" text-anchor="middle">Memória com fontes</text>
<rect x="277" y="389" width="208" height="43" rx="21.5" fill="#efeaf7"/><text x="381" y="417" fill="#62527c" font-size="16" font-weight="700" text-anchor="middle">Companhia discreta</text>
${ghost('acolhimento',842,100,356)}
<rect x="885" y="404" width="274" height="42" rx="21" fill="#fffefa"/><text x="1022" y="431" text-anchor="middle" fill="#536958" font-size="16">Um pouco de luz, por aqui.</text></svg>\n`;
const journey=start(360,'Do contexto ao próximo passo','Diagrama editorial em três cartões: encontrar a fonte, acompanhar o combinado, conferir o resultado. Não é captura de produto.')+`
<rect width="1280" height="360" rx="32" fill="#f6f6ef"/>
${[[20,'#e4f1e9','01 · MEMÓRIA','Encontre o fio.','Autoria, contexto e fontes','que você pode consultar.'],[438,'#fff2b8','02 · ACOMPANHAMENTO','Veja o que segue.','Projetos e compromissos','com espaço para corrigir.'],[856,'#efeaf7','03 · RESULTADOS','Confira o caminho.','Concluído, verificado e aceito:','cada estado com sua evidência.']].map(([x,color,eyebrow,title,a,b])=>`<rect x="${x}" y="20" width="404" height="320" rx="28" fill="${color}"/><text x="${x+28}" y="66" fill="#5e7066" font-size="14" font-weight="700">${eyebrow}</text><text x="${x+28}" y="126" fill="#1e3a34" font-size="28" font-weight="700" letter-spacing="-.8">${title}</text><text x="${x+28}" y="171" fill="#4d665a" font-size="18">${a}</text><text x="${x+28}" y="198" fill="#4d665a" font-size="18">${b}</text>`).join('')}
${ghost('buscando',283,205,112)}${ghost('leitura',700,205,112)}${ghost('celebracao',1118,205,112)}
<text x="48" y="309" font-size="11" fill="#5e7066">DIAGRAMA EDITORIAL</text></svg>\n`;
const expressions=start(470,'Lume, muitas expressões','Seis poses do personagem vetorial usado pelo aplicativo. Prévia artística, sem dados nem atividade operacional.')+`
<rect width="1280" height="470" rx="32" fill="#fffefa"/><text x="45" y="65" font-size="32" fill="#1e3a34" font-weight="700">Um pequeno fantasma. Muitas expressões.</text><text x="45" y="103" font-size="18" fill="#63756b">A mesma presença, do primeiro combinado ao próximo passo.</text>
${[['aguardando','Por aqui','#fff2b8'],['curiosidade','Curiosidade','#efeaf7'],['buscando','Buscando','#e4f1e9'],['leitura','Leitura','#f7e8dd'],['celebracao','Celebração','#fff2b8'],['acolhimento','Acolhimento','#e4f1e9']].map(([state,label,color],i)=>`<rect x="${28+i*207}" y="145" width="189" height="272" rx="28" fill="${color}"/>${ghost(state,33+i*207,175,180)}<text x="${122+i*207}" y="385" text-anchor="middle" font-size="17" fill="#315445" font-weight="700">${label}</text>`).join('')}
<text x="45" y="451" font-size="12" fill="#63756b">PRÉVIAS DO PERSONAGEM · ARTE DO PRODUTO, SEM DADOS DE CONVERSAS</text></svg>\n`;
for(const [file,content]of [['lume-banner.svg',banner],['lume-percurso.svg',journey],['lume-expressoes.svg',expressions]])await writeFile(new URL(file,directory),content);
console.log('LUME_SOFT_EDITORIAL_WRITTEN');
