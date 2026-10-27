import {cpSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'site-dist');
if(dirname(output)!==root)throw new Error('Saída da landing fora do projeto.');
rmSync(output,{recursive:true,force:true});mkdirSync(join(output,'vendor'),{recursive:true});

let html=readFileSync(join(root,'src/painel/apresentacao.html'),'utf8');
const replace=(before,after)=>{
  if(!html.includes(before))throw new Error('Trecho esperado não encontrado na landing: '+before.slice(0,80));
  html=html.replace(before,after);
};

replace('<meta name="description" content="Encontre o combinado com um cliente e organize seu próximo passo. Conheça o beta privado do Lume.">','<meta name="description" content="O Lume organiza conversas, contatos e próximos passos. O próximo beta assinado está em preparação."><meta name="robots" content="noindex,nofollow"><meta property="og:type" content="website"><meta property="og:title" content="Lume · Clareza para o próximo passo"><meta property="og:description" content="Seu CRM começa nas conversas que você já tem."><meta property="og:image" content="/og-lume.png"><meta name="twitter:card" content="summary_large_image"><link rel="icon" href="/icon.png">');
replace('<button class="button small" type="button" data-download-open>Downloads <span aria-hidden="true">↗</span></button>','<a class="button small" href="/download">Instalação <span aria-hidden="true">↗</span></a>');
replace('<div class="hero-actions"><a class="button" href="/app">Experimentar no app <span aria-hidden="true">→</span></a>','<div class="hero-actions"><span class="release-status">Próximo beta assinado em preparação.</span>');
replace('Beta privado em preparação para Windows e macOS.','Windows e macOS · próximo beta assinado em preparação.');
replace('<a class="button" href="/app#beta">Ver o roteiro do beta <span aria-hidden="true">→</span></a>','<p class="release-status">Próximo beta assinado em preparação.</p>');
replace('<button class="download-button" type="button" data-download-open>Ver versão para meu computador →</button>','<a class="button" href="/download">Ver disponibilidade por sistema →</a>');
replace('<div class="release-card"><h3>Preparando a primeira instalação.</h3>','<div class="release-card"><h3>Preparando o próximo beta assinado.</h3>');
replace('<p>Os novos instaladores serão liberados depois dos testes de instalação, conexão e segurança e da revisão dos termos.</p>','<p>Os instaladores serão liberados depois da assinatura e dos testes de instalação, conexão e segurança.</p>');
replace('<div><b>Windows</b><span>Validação pendente</span></div>','<div><b>Windows</b><span>Assinatura e validação pendentes</span></div>');
replace('<div><b>macOS</b><span>Preparação e teste pendentes</span></div>','<div><b>macOS</b><span>Assinatura e teste no Mac pendentes</span></div>');
replace('<p class="release-small">Esta página apresenta o produto. Ainda não há download desta versão liberado para os sócios.</p>','<p class="release-small">Esta página apresenta o produto. Nenhum instalador está liberado nesta página.</p>');
replace('<p>Revise sugestões de tarefas e acompanhe as ações que você aceitou.</p><span class="feature-state">Com IA opcional e sua revisão</span>','<p>Revise as ações ligadas às mensagens de origem. A organização local com Laya ainda está em avaliação.</p><span class="feature-state">Ações conferidas por você</span>');
replace('<p>A busca textual funciona sem chave. Perguntas e sugestões de tarefas usam Gemini opcional. Você configura sua conta e escolhe as conversas. Na consulta manual, confere as fontes antes do envio. Sugestões automáticas precisam de uma autorização adicional. O consumo é cobrado pelo provedor na conta configurada.</p>','<p>A busca textual funciona sem chave. A organização local com Laya está em avaliação e só será liberada depois dos testes de qualidade. Gemini é opcional para perguntas e sugestões atuais; você escolhe as conversas e confere as fontes antes do envio. O provedor pode cobrar pelo uso na sua conta.</p>');
replace('<p>O beta dos sócios é gratuito. O primeiro teste: encontrar um combinado e explicar qual é o próximo passo.</p>','<p>A próxima rodada será por convite. O primeiro teste: encontrar um combinado e conferir o próximo passo na mensagem de origem.</p>');
replace('<p>O beta dos sócios é gratuito. O uso opcional do Gemini pode gerar custo na sua conta. O preço público do Lume ainda será definido.</p>','<p>Ainda não há preço público nesta página. Confira as condições com quem enviou seu convite. O uso opcional do Gemini pode gerar custo na sua conta.</p>');
const beforeDialog=html;
html=html.replace(/<dialog id="download-dialog"[\s\S]*?<\/dialog>/,'');
if(html===beforeDialog)throw new Error('Diálogo de download esperado não encontrado na landing.');

writeFileSync(join(output,'index.html'),html,'utf8');
for(const file of ['lume.css','lume-features.css','lume-site.js','lume-motion.js'])cpSync(join(root,'src/painel',file),join(output,file));
cpSync(join(root,'src/painel/lume-download.css'),join(output,'lume-download.css'));
cpSync(join(root,'src/painel/vendor/motion.js'),join(output,'vendor/motion.js'));
cpSync(join(root,'desktop/icon.png'),join(output,'icon.png'));
cpSync(join(root,'desktop/icon.png'),join(output,'og-lume.png'));
cpSync(join(root,'central/site'),join(output,'central'),{recursive:true});
const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
let sourceCommit=process.env.LUME_SOURCE_SHA||process.env.VERCEL_GIT_COMMIT_SHA||'';
if(!sourceCommit&&!process.env.VERCEL){
  sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
}
if(!/^[0-9a-f]{40}$/.test(sourceCommit))throw new Error('LUME_SOURCE_SHA obrigatória e válida para build Vercel rastreável.');
writeFileSync(join(output,'release-status.json'),JSON.stringify({version,sourceCommit,distribution:'em_validacao',downloads:[]})+'\n','utf8');
const platforms={windows:{name:'Windows',detail:'Windows x64',file:'instalador .exe assinado'},mac:{name:'Mac',detail:'macOS Apple Silicon e Intel',file:'instalador .dmg assinado e notarizado'}};
function downloadPage(platform){
  const item=platforms[platform];
  const title=item?`Lume para ${item.name}`:'Instalar o Lume';
  const lead=item?`${item.detail} · versão ${version} em validação.`:'Escolha o sistema do seu computador para acompanhar a disponibilidade do beta.';
  const cards=item?`<article class="download-card"><p class="overline">${item.detail}</p><h2>Instalador ainda indisponível.</h2><p>O ${item.file} só aparecerá aqui depois dos testes de qualidade, assinatura e instalação. Não há arquivo aprovado para baixar agora.</p><p class="download-note">Se você recebeu um convite, guarde o código. Ele será usado no aplicativo após a liberação.</p><a class="text-link" href="/download">Ver os outros sistemas →</a></article>`
    :Object.entries(platforms).map(([key,value])=>`<article class="download-card"><p class="overline">${value.detail}</p><h2>${value.name}</h2><p>Instalador em validação. Veja o estado desta plataforma e o que será necessário para instalar.</p><a class="button" href="/download/${key}">Ver estado para ${value.name} →</a></article>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="description" content="Acompanhe a disponibilidade do beta privado do Lume para Windows e Mac."><title>${title} · Lume</title><link rel="icon" href="/icon.png"><link rel="stylesheet" href="/lume.css"><link rel="stylesheet" href="/lume-download.css"></head><body><a class="skip-link" href="#principal">Ir para o conteúdo</a><header class="site-nav"><a class="site-brand" href="/" aria-label="Lume, início"><span aria-hidden="true">✳</span> lume</a><nav aria-label="Navegação"><a href="/">Conhecer o Lume</a></nav></header><main id="principal" class="download-main"><div class="download-heading"><p class="overline">BETA PRIVADO · INSTALAÇÃO</p><h1>${title}</h1><p class="download-lead">${lead}</p><div class="download-status" role="status"><span>Em validação</span><p>Não há instalador liberado nesta versão. Esta página será atualizada após a aprovação do pacote.</p></div></div><div class="download-grid">${cards}</div><section class="download-steps" aria-labelledby="download-steps-title"><p class="overline">QUANDO FOR LIBERADO</p><h2 id="download-steps-title">Comece em três passos.</h2><ol><li>Abra o convite e baixe o instalador indicado para o seu computador.</li><li>Confira o nome Lume e a assinatura digital; depois conclua a instalação pela tela.</li><li>Abra o aplicativo, use seu código de convite e conecte o WhatsApp pelo QR code.</li></ol><p>As conversas ficam no seu computador. O app não responde contatos automaticamente.</p></section><p class="download-help">Precisa de ajuda com o convite? Fale com a pessoa que enviou o acesso ao beta.</p></main><footer class="site-footer"><a class="site-brand" href="/"><span aria-hidden="true">✳</span> lume</a><p>Clareza para o próximo passo.</p><span>Um produto ReadyWorks.</span></footer></body></html>`;
}
mkdirSync(join(output,'download'),{recursive:true});
writeFileSync(join(output,'download.html'),downloadPage(),'utf8');
for(const platform of Object.keys(platforms))writeFileSync(join(output,'download',`${platform}.html`),downloadPage(platform),'utf8');
writeFileSync(join(output,'robots.txt'),'User-agent: *\nDisallow: /\n','utf8');
console.log('Landing Vercel preparada em site-dist.');
