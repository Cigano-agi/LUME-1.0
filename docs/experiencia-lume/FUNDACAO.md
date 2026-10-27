# Fundação Lume vivo · 26/10/2026

Implementação delimitada a `src/painel/experiencia.css`, `src/painel/lume-vivo-icons.svg` e este contrato. Base: README, DESIGN-SYSTEM, TELAS, INTERFACES e DONE vigentes; DOM observado em app.html e regras desk06 de beta05.css/lume-identidade.css. Não altera dados, APIs, permissões, app.html/app.js ou os estilos anteriores. Sem commits neste Dispatch.

## Integração pela coordenação

1. Servir `/experiencia.css` como `text/css` e `/lume-vivo-icons.svg` como `image/svg+xml`, incluindo os dois na allowlist desktop e no mapa de assets. Adicionar os dois em `build.files` do package.json. Os arquivos locais Manrope já existem e são empacotados.
2. Incluir experiencia.css após os estilos existentes, inclusive os carregados dinamicamente; ativar `body.classList.add('lume-vivo')`. Manter `.workspace.desk06`. Tema segue exclusivamente `html[data-theme="dark"]` do controlador real; a ausência desse atributo usa claro.
3. Integrar classes abaixo sem substituir elementos nativos por divs clicáveis. `[hidden]` mantém prioridade; dialog fechado mantém display:none. CSS não realiza eventos, timeout, cancelamento de carga, busca, autorização nem retorno de foco.
4. Painel lateral: preferir `<dialog class="lv-drawer">` com `showModal()` e `close()`. Se usar section, aplicar role=dialog/aria-modal/aria-labelledby, inert no fundo e controle de Tab, Escape e retorno ao invocador por JS. Backdrop separado é `.lv-drawer-backdrop`; não o criar junto ao backdrop nativo do dialog. Título e botão Fechar permanecem no fluxo rolável para caber em 200%; não há header sticky que encubra conteúdo.
5. Coordenador deve confirmar a integração com a vista operacional e a QA real. Este arquivo não substitui o gate de screenshot/teclado/percurso do produto nem revisão independente.

## Tokens e componentes

Corpo 16px, metadados 14px, títulos de cartão/seção 24px, detalhe 28px, página 24–32px. Fonte `Lume Manrope` é um alias exclusivo dos WOFF2 Manrope locais, com pesos 200–800; o fallback é contingência de falha, não fonte escolhida. Espaços 4/8/12/16/20/24/32px; raios 12/20/28px. Alvos de navegação 48px, botões/campos/links de fonte 44px. Checkbox/radio usa label mínimo44px; a marca visual tem20px.

Tokens base: `--lv-font`, `--lv-bg`, `--lv-surface`, `--lv-raised`, `--lv-ink`, `--lv-muted`, `--lv-border` (divisória decorativa), `--lv-border-strong` (contorno de controle), `--lv-yellow`, `--lv-yellow-bg`, `--lv-yellow-ink`, `--lv-focus`, `--lv-error`, `--lv-error-bg`. Categorias: `--lv-commercial`, `--lv-delivery`, `--lv-agreement`, `--lv-people`, `--lv-memory`, cada uma com `-bg` e `-border`. Prefixos `--lv-space-*`, `--lv-radius*`, `--lv-*-time`, `--lv-ease`, `--lv-shadow` e `--lv-sidebar` completam o contrato.

| Classe | Contrato |
|---|---|
| lv-page / lv-page-heading | Raiz da vista, h1 e introdução/ação; nunca usar como main adicional |
| lv-board / lv-section / lv-section-heading | Grade adaptável, seção e título h2; 1 coluna até1100px |
| lv-card / lv-card-meta / lv-card-title / lv-card-summary / lv-card-footer | Assunto, autoria/data, título h3, acontecimento e ações; `data-decision=true` realça decisão em amarelo |
| lv-category | Nome visível e SVG; herda `data-category` do cartão ou do próprio elemento |
| lv-state | Estado textual obrigatório; `data-state=inferido\|sugerido` usa borda tracejada; informado/enviado/cuidando, verificado/aceito/confirmado e pausado/pendente/parcial têm famílias distintas; erro/error usa vermelho |
| lv-source | Fonte com autoria/data/origem; usar a/button quando houver ação, div quando apenas referência |
| lv-toolbar / lv-filters | Ações e filtros; labels com campos flexíveis, sem largura fixa |
| lv-button | Botão ou link nativo; `data-variant=primary\|quiet`, `aria-pressed=true` para filtro ativo; disabled ou aria-disabled precisam de comportamento correspondente |
| lv-search / lv-global-search | Formulário de busca e superfície global; label explícito, input e submit; não colocam fontes nem dados na rede |
| lv-drawer / lv-drawer-backdrop / lv-drawer-header / lv-drawer-body | Painel lateral até640px, limitado à viewport; controle modal fica no JS |
| lv-detail-section / lv-timeline / lv-item | Seção do detalhe, ol de eventos e li; histórico não recebe ordem ou verdade do CSS |
| lv-empty / lv-status / lv-error / lv-connection | Vazio, status, erro e conexão; role=status/alert conforme evento; loading é texto estático, sem shimmer |
| lv-list / lv-relations | Lista e relações2D; a lista equivalente continua obrigatória |
| lv-icon / lv-sr-only | SVG24px e texto apenas para tecnologia assistiva |

`data-category=comercial|entregas|combinados|pessoas|memoria` aplica cor, fundo, borda e forma ao ícone: ramificação verde, peça azul, elos âmbar, órbita coral, camadas violeta. Nome+ícone permanecem obrigatórios; categoria nunca equivale a estado. Informado, verificado, enviado e aceito têm símbolos próprios e texto explícito.

```html
<article class="lv-card" data-category="comercial">
  <div class="lv-card-meta">
    <span class="lv-category"><svg class="lv-icon" aria-hidden="true"><use href="/lume-vivo-icons.svg#lv-comercial"/></svg>Comercial</span>
    <span class="lv-state" data-state="inferido">Inferido · conferir fonte</span>
  </div>
  <h3 class="lv-card-title">Assunto confirmado pela fonte</h3>
  <p class="lv-card-summary">Acontecimento, consequência e próximo passo.</p>
  <div class="lv-card-footer"><button class="lv-button" type="button">Abrir assunto</button></div>
</article>
```

Sprite: `lv-agora`, `lv-comercial`, `lv-entregas`, `lv-combinados`, `lv-pessoas`, `lv-memoria`, `lv-busca`, `lv-filtros`, `lv-fonte`, `lv-abrir`, `lv-fechar`, `lv-verificado`, `lv-informado`, `lv-enviado`, `lv-aceito`, `lv-pausa`, `lv-relogio`, `lv-alerta`, `lv-conexao`, `lv-relacoes`. São símbolos vetoriais nativos; não são nem substituem os conceitos GPT Image pendentes.

Motion é opt-in por `data-enter=true`: cartão260ms, painel360ms, interação160ms, somente opacity/transform e uma iteração. Remover o atributo após entrada; não reativar a cada atualização. Reduced-motion retira CSS animation/transition/scroll suave em toda a raiz. JS animado e companheiro continuam territórios próprios e precisam respeitar a mesma preferência.

## Prova reproduzível (fixture sintética)

O comando abaixo executa o bloco JavaScript deste arquivo, a partir de app. Usa Edge já instalado, perfil temporário do Playwright e interceptação local de assets; nenhum perfil/aba pessoal, serviço real, dado privado ou rede externa. Não salva screenshot. Largura512px representa a viewport CSS de1024px em zoom200%, sem afirmar equivalência a um teste nativo de zoom/teclado.

```powershell
node --input-type=module -e "import fs from 'node:fs';const d=fs.readFileSync('docs/experiencia-lume/FUNDACAO.md','utf8');const s=d.split('\n<!-- foundation-test -->')[1].split('~~~js')[1].split('~~~')[0];await import('data:text/javascript;base64,'+Buffer.from(s.replaceAll('__ROOT__',process.cwd().replaceAll(String.fromCharCode(92),'/'))).toString('base64'));"
```

<!-- foundation-test -->
~~~js
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire('file:///__ROOT__/package.json');
const {chromium}=require('playwright');
const dir='__ROOT__/src/painel/';
const css=fs.readFileSync(dir+'experiencia.css','utf8');
const required='page page-heading board section section-heading card card-meta card-title card-summary card-footer category state source empty toolbar filters button drawer drawer-backdrop drawer-header drawer-body detail-section timeline item search global-search connection status error list relations'.split(' ');
for(const c of required) assert(css.includes('.lv-'+c),c);
assert(!/\binfinite\b/.test(css));
const browser=await chromium.launch({headless:true,channel:'msedge'});
try {
  const page=await browser.newPage();
  await page.route('http://lume.test/**',async route=>{
    const p=new URL(route.request().url()).pathname.slice(1);
    if(!/^[a-z0-9/._-]+$/i.test(p)||p.includes('..')) return route.abort();
    const path=dir+p;
    if(!fs.existsSync(path)) return route.fulfill({status:404,body:''});
    await route.fulfill({body:fs.readFileSync(path),contentType:p.endsWith('.css')?'text/css':p.endsWith('.woff2')?'font/woff2':'image/svg+xml'});
  });
  let html=fs.readFileSync(dir+'app.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  html=html.replace('<head>','<head><base href="http://lume.test/">').replace('<body>','<body class="lume-vivo">');
  await page.setContent(html);
  await page.addStyleTag({content:css});
  await page.evaluate(()=>{
    document.querySelector('#onboarding')?.remove();
    const w=document.querySelector('.workspace');w.hidden=false;w.classList.add('desk06');
    const categories=['comercial','entregas','combinados','pessoas','memoria'];
    document.querySelector('main').innerHTML='<div class="main-content"><div class="lv-page"><header class="lv-page-heading"><h1>Agora</h1></header><form class="lv-global-search"><label for="test-search">Buscar na memória</label><input id="test-search" placeholder="Encontre um combinado"><button class="lv-button">Buscar</button></form><div class="lv-board">'+categories.map(c=>'<article class="lv-card" data-category="'+c+'"><span class="lv-category"><svg class="lv-icon" aria-hidden="true"><use href="/lume-vivo-icons.svg#lv-'+c+'"/></svg>'+c+'</span><h3 class="lv-card-title">Retomar o assunto</h3><p class="lv-card-summary">Próximo passo com autoria e fonte para conferir.</p><span class="lv-state">Informado</span><footer class="lv-card-footer"><button class="lv-button">Abrir assunto</button><button class="lv-button" data-variant="primary">Resolver</button></footer></article>').join('')+'</div><dialog class="lv-drawer"><div class="lv-drawer-header"><h2>Detalhe do assunto</h2><button class="lv-button">Fechar</button></div><div class="lv-drawer-body"><section class="lv-detail-section"><h3>Fontes</h3><p>Conteúdo sintético.</p></section></div></dialog></div></div>';
  });
  await page.evaluate(()=>document.fonts.ready);
  assert(await page.evaluate(()=>[...document.fonts].some(f=>f.family==='Lume Manrope'&&f.status==='loaded')),'local font loaded');
  await page.locator('.lv-card-title').first().evaluate(e=>{e.innerHTML='<button class="lv-button">Abrir assunto pelo título</button>';});
  assert.equal(await page.locator('.lv-card-title .lv-button').evaluate(e=>getComputedStyle(e).fontSize),'24px');
  const rows=[];
  for(const theme of ['light','dark']) for(const width of [1024,512,320]) {
    await page.setViewportSize({width,height:width===1024?768:384});
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    await page.evaluate(async()=>{await document.fonts.load('16px "Lume Manrope"');await document.fonts.ready;});
    const r=await page.evaluate(()=>{
      const cs=getComputedStyle(document.body);
      const rgb=h=>h.match(/[0-9a-f]{2}/gi).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
      const lum=h=>rgb(h).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const val=n=>cs.getPropertyValue('--lv-'+n).trim();
      const contrast=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
      const pairs=[];
      for(const bg of ['bg','surface','raised','yellow-bg']) for(const fg of ['ink','muted']) pairs.push([fg+'/'+bg,contrast(val(fg),val(bg))]);
      for(const c of ['commercial','delivery','agreement','people','memory']) pairs.push([c,contrast(val(c),val(c+'-bg'))]);
      pairs.push(['primary',contrast('#272923',val('yellow'))],['error',contrast(val('error'),val('error-bg'))]);
      const visible=e=>e.getClientRects().length>0;
      const small=[...document.querySelectorAll('.lv-button,.lv-global-search input,.sidebar nav button')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.width<44||r.height<44}).length;
      const bodyFont=document.fonts.check('16px "Lume Manrope"');
      return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,small,bodyFont,bodySize:cs.fontSize,cardTitle:getComputedStyle(document.querySelector('.lv-card-title')).fontSize,minimumText:Math.min(...pairs.map(p=>p[1])),pairs,controlContrast:contrast(val('border-strong'),val('raised'))};
    });
    assert.equal(r.overflow,false,theme+' '+width+' overflow');assert.equal(r.small,0,'targets');assert(r.bodyFont);assert.equal(r.bodySize,'16px');assert.equal(r.cardTitle,'24px');assert(r.minimumText>=4.5,JSON.stringify(r.pairs));assert(r.controlContrast>=3);
    await page.locator('.lv-drawer').evaluate(d=>d.showModal());
    const drawer=await page.locator('.lv-drawer').evaluate(d=>({width:d.getBoundingClientRect().width,overflow:d.scrollWidth>d.clientWidth}));
    assert(drawer.width<=width);assert.equal(drawer.overflow,false);
    await page.locator('.lv-drawer').evaluate(d=>d.close());
    rows.push({theme,width,text:+r.minimumText.toFixed(2),control:+r.controlContrast.toFixed(2),targets:'44+',overflow:false});
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('.lv-card').first().evaluate(e=>e.dataset.enter='true');
  assert.equal(await page.locator('.lv-card').first().evaluate(e=>getComputedStyle(e).animationName),'none');
  await page.locator('.lv-button').first().focus();
  assert.equal(await page.locator('.lv-button').first().evaluate(e=>getComputedStyle(e).outlineWidth),'3px');
  const xml=await page.evaluate(svg=>new DOMParser().parseFromString(svg,'image/svg+xml').querySelectorAll('parsererror').length,fs.readFileSync(dir+'lume-vivo-icons.svg','utf8'));
  assert.equal(xml,0);assert.equal((fs.readFileSync(dir+'lume-vivo-icons.svg','utf8').match(/<symbol /g)||[]).length,20);
  console.log(JSON.stringify({browser:browser.version(),rows,requiredClasses:required.length,icons:20,reducedMotion:true,focus:true,fixture:'synthetic; no screenshot or product acceptance'},null,2));
} finally { await browser.close(); }
~~~

## Resultado e limites

Executado no Edge156.0.4314.42 headless, Node24.19.0, em26/10/2026 (UTC27/10). Seis combinações claro/escuro ×1024/512/320px passaram: sem overflow horizontal de página/drawer, controles/navegação testados≥44px, Manrope local carregada, corpo16px/título24px, foco3px e reduced-motion sem animação. As31classes exigidas e20symbols SVG foram conferidos; XML do sprite parseou sem erro. O teste adicional de título clicável preserva24px. O comando está acima para revisão independente.

| Medida calculada nos tokens | Claro | Escuro |
|---|---:|---:|
| Menor contraste de texto nos pares testados | 5,32:1 | 6,16:1 |
| Contorno de controle contra superfície elevada | 3,65:1 | 3,72:1 |

Pares de texto: ink/muted contra bg/surface/raised/yellow-bg, cinco categorias contra seus fundos, botão amarelo e erro. Divisórias decorativas não são controles e não têm alegação de3:1. Contraste calculado não prova o contraste de toda composição integrada.

Não houve screenshot, percurso real de produto, zoom nativo, teste de leitor de tela ou revisão independente neste Dispatch. A largura512px verifica reflow equivalente à viewport CSS de1024px a200%; não comprova zoom do Electron. Os estilos antigos fora dos componentes novos são preservados e podem exigir ajustes de integração. A instalação do Chromium esperado pelo Playwright estava ausente; a execução usou o Edge já instalado em processo headless isolado, sem download.

Uma repetição com o caso de título clicável detectou font.check=false durante carga de fontes após reflow; a fixture passou a aguardar explicitamente fonts.load/fonts.ready antes das medidas, mantendo a asserção de fonte carregada. A repetição final passou nas seis combinações com as mesmas razões de contraste; não houve relaxamento dos limites.

Pendente da integração: registrar/empacotar assets, aplicar raiz e stylesheet, inserir símbolos e data-state no DOM operacional (aviso enviado ao coordenador), revisar o conjunto real e testar o fluxo modal/retorno de foco e posição. As regras aceitam h2.lv-section-heading direto e h3.lv-card-title com botão nativo conforme experiencia.js observado. Nenhuma pendência de backend foi criada; arte GPT Image e aceite continuam gates separados.
