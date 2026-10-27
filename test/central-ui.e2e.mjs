import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';

const ID = 'b84c33d7-35c6-4a89-bf3f-7f9dc7c8b133';
let offline = false;
let feedbackOffline = false;
let centralState = {
  situacao: 'sem_consentimento',
  consentido: false,
  feedbackHabilitado:false,
  registrado: false,
  revogada: false,
  instalacaoId: null,
  ultimoSucessoEm: null,
  proximaTentativaEm: null,
  falhasConsecutivas: 0
};
const calls = [];
const central = {
  consultar: async () => {
    calls.push(['consultar']);
    if (offline) throw new Error('detalhes internos não podem aparecer');
    return { ...centralState };
  },
  consentir: async convite => {
    calls.push(['consentir', convite]);
    centralState = { ...centralState, situacao: 'pronto_para_registrar', consentido: true, instalacaoId: ID };
    return { ...centralState };
  },
  autorizarFeedback:async convite=>{
    calls.push(['autorizar-feedback',convite]);
    centralState={...centralState,situacao:'feedback_autorizado',feedbackHabilitado:true,registrado:true,instalacaoId:ID};
    return {...centralState};
  },
  ativarAcompanhamento:async()=>{
    calls.push(['ativar-acompanhamento']);
    centralState={...centralState,situacao:'registrado',consentido:true};
    return {...centralState};
  },
  desativarAcompanhamento:async()=>{
    calls.push(['desativar-acompanhamento']);
    centralState={...centralState,situacao:'sem_consentimento',consentido:false};
    return {...centralState};
  },
  revogar: async () => {
    calls.push(['revogar']);
    centralState = { ...centralState, situacao: 'revogada_localmente', consentido: false, feedbackHabilitado:false, registrado: false, revogada: true, instalacaoId: null };
    return { ...centralState };
  },
  enviarFeedback: async dados => {
    calls.push(['feedback',structuredClone(dados)]);
    if(feedbackOffline)throw new Error('rede indisponível');
    return {id:'640ad0f7-2d23-4c7f-a8db-8c49fa66c167',recebidoEm:'2026-09-24T15:00:00.000Z'};
  }
};

const db = abrirBanco();
const server = criarServidor(db, {
  desktop: true,
  central,
  conexao: { estado: () => ({ estado: 'desconectada', qr: null }), iniciar: async () => {}, parar: async () => {} }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
const errors = [];
const external = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  if (!route.request().url().startsWith(origin)) {
    external.push(route.request().url());
    return route.abort();
  }
  return route.continue();
});

try {
  await page.goto(origin + '/app');
  await page.locator('#owner').fill('Pessoa teste');
  await page.locator('#consent').check();
  await page.getByRole('button', { name: 'Preparar meu espaço' }).click();
  await page.locator('#skip').click();
  await page.locator('#first-use .central-feedback-shortcut').click();

  const panel = page.locator('#central-panel');
  await panel.getByRole('heading', { name: 'Feedback e acompanhamento' }).waitFor();
  await panel.getByText('Acompanhamento e feedback desligados.').waitFor();
  assert.equal(await panel.locator('#central-feedback-text').evaluate(node=>document.activeElement===node),true);
  assert.equal(await panel.locator('#central-feedback-form').isVisible(),true);
  assert.equal(await panel.locator('#central-feedback-send').isVisible(),false);
  assert.match(await panel.textContent(), /Não envia automaticamente: mensagens, contatos, grupos, telefones, arquivos, buscas ou chaves/);
  assert.equal(await panel.getByText('Novidades do produto').count(), 0);
  assert.equal(await page.locator('#novidades-panel').count(), 1);

  const activate = panel.getByRole('button', { name: 'Habilitar feedback' });
  await panel.locator('#central-invite').fill('LUME-ABCDEFGHIJKL');
  assert.equal(await panel.locator('#central-confirm').isChecked(), false);
  await activate.click();
  await panel.getByText('Feedback habilitado. Acompanhamento técnico desligado.').waitFor();
  assert.equal(await panel.getByText('Revogar esta instalação na Central').isVisible(),true);
  assert.deepEqual(calls.find(call => call[0] === 'autorizar-feedback'), ['autorizar-feedback', 'LUME-ABCDEFGHIJKL']);
  assert.equal(calls.some(call=>call[0]==='ativar-acompanhamento'),false);

  await page.locator('nav [data-view=today]').click();
  await page.locator('#first-use .central-feedback-shortcut').click();
  await page.waitForFunction(()=>document.querySelector('#central-feedback-stage')?.value==='onboarding');
  assert.equal(await panel.locator('#central-feedback-stage').inputValue(),'onboarding');
  await page.locator('nav [data-view=today]').click();
  let liberarPermissoes,avisarPermissoes;
  const permissoesPresas=new Promise(resolve=>{liberarPermissoes=resolve;}),permissoesAguardando=new Promise(resolve=>{avisarPermissoes=resolve;});
  const rotaPermissoes=url=>url.toString().includes('/api/v3/acoes/conversas?');
  const atrasarPermissoes=async route=>{avisarPermissoes();await permissoesPresas;await route.continue();};
  await page.route(rotaPermissoes,atrasarPermissoes);
  try{
    await page.locator('#today>.central-feedback-shortcut').click();
    await permissoesAguardando;
    await page.waitForFunction(()=>document.querySelector('#central-feedback-stage')?.value==='hoje');
    assert.equal(await panel.locator('#central-feedback-form').isVisible(),true);
    assert.equal(await panel.locator('#central-feedback-text').evaluate(node=>document.activeElement===node),true);
  }finally{liberarPermissoes();await page.unroute(rotaPermissoes,atrasarPermissoes);}
  assert.equal(await panel.locator('#central-feedback-stage').inputValue(),'hoje');
  await page.locator('nav [data-view=today]').click();
  await page.locator('#first-hide').click();
  mkdirSync('work/feedback06-ui-qa',{recursive:true});
  await page.screenshot({path:'work/feedback06-ui-qa/today-feedback-1100.png'});
  await page.setViewportSize({width:390,height:900});
  await page.screenshot({path:'work/feedback06-ui-qa/today-feedback-390.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:1100,height:900});
  await page.locator('#home-status .central-feedback-shortcut').click();
  await page.waitForFunction(()=>document.querySelector('#central-feedback-stage')?.value==='conexao');
  assert.equal(await panel.locator('#central-feedback-stage').inputValue(),'conexao');
  await page.locator('nav [data-view=today]').click();
  await page.locator('nav [data-view=settings]').click();
  await page.locator('#settings-choice-work').click();
  await page.locator('#settings-actions .central-feedback-shortcut').click();
  await page.waitForFunction(()=>document.querySelector('#central-feedback-stage')?.value==='organiza');
  assert.equal(await panel.locator('#central-feedback-stage').inputValue(),'organiza');

  const relato='O botão de conectar não explicou como continuar após o QR.';
  await panel.locator('#central-feedback-stage').selectOption('conexao');
  await panel.locator('#central-feedback-text').fill(relato);
  assert.equal(await panel.locator('#central-feedback-contact').isChecked(),false);
  await panel.locator('#central-feedback-contact').check();
  await page.locator('nav [data-view=today]').click();
  await page.locator('#today>.central-feedback-shortcut').click();
  await page.waitForFunction(()=>document.activeElement===document.querySelector('#central-feedback-text'));
  assert.equal(await panel.locator('#central-feedback-stage').inputValue(),'conexao');
  assert.equal(await panel.locator('#central-feedback-text').inputValue(),relato);
  feedbackOffline=true;
  await panel.locator('#central-feedback-send').click();
  await panel.locator('#central-feedback-status').filter({hasText:'Não recebido.'}).waitFor();
  const rascunho=await page.evaluate(()=>JSON.parse(localStorage.getItem('lume-feedback-draft-v1')));
  assert.equal(rascunho.relato,relato);
  assert.equal(rascunho.contatoAutorizado,true);
  feedbackOffline=false;
  await panel.locator('#central-feedback-send').click();
  await panel.locator('#central-feedback-status').filter({hasText:'Recebido em'}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('lume-feedback-draft-v1')),null);
  const envios=calls.filter(call=>call[0]==='feedback');
  assert.equal(envios.length,2);
  assert.deepEqual(envios.map(call=>call[1].chaveCliente),[rascunho.chaveCliente,rascunho.chaveCliente]);
  assert.equal(envios[1][1].relato,relato);
  assert.deepEqual(Object.keys(envios[1][1]).sort(),['categoria','chaveCliente','contatoAutorizado','etapa','relato','utilidade']);
  assert.equal(envios[1][1].contatoAutorizado,true);
  assert.equal(await panel.locator('#central-feedback-contact').isChecked(),false);
  assert.equal(JSON.stringify(envios).includes('token'),false);
  mkdirSync('work/feedback06-ui-qa',{recursive:true});
  await panel.screenshot({path:'work/feedback06-ui-qa/settings-feedback-1100.png'});
  await page.setViewportSize({width:390,height:900});
  await panel.screenshot({path:'work/feedback06-ui-qa/settings-feedback-390.png'});
  await page.setViewportSize({width:1100,height:900});

  await panel.locator('#central-confirm').check();
  await panel.getByRole('button',{name:'Ativar acompanhamento técnico'}).click();
  await panel.getByText('Acompanhamento ativo.').waitFor();
  assert.equal(calls.filter(call=>call[0]==='ativar-acompanhamento').length,1);
  await panel.getByRole('button',{name:'Desligar acompanhamento técnico'}).click();
  await panel.getByText('Feedback habilitado. Acompanhamento técnico desligado.').waitFor();
  assert.equal(await panel.locator('#central-feedback-form').isVisible(),true);
  assert.equal(calls.filter(call=>call[0]==='desativar-acompanhamento').length,1);
  await panel.getByText('Revogar esta instalação na Central').click();
  const revoke = panel.getByRole('button', { name: 'Confirmar revogação' });
  assert.equal(await revoke.isDisabled(), true);
  await panel.locator('#central-stop-confirm').check();
  await revoke.click();
  await panel.getByText('Acompanhamento e feedback desligados.').waitFor();
  assert.equal(calls.filter(call => call[0] === 'revogar').length, 1);
  assert.equal(await panel.locator('#central-feedback-form').isVisible(),true);
  assert.equal(await panel.locator('#central-feedback-send').isVisible(),false);
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
  const relatoManual='Não consegui conectar o WhatsApp após ler o código QR.';
  await panel.locator('#central-feedback-text').fill(relatoManual);
  await panel.locator('#central-feedback-copy').click();
  const copiado=await page.evaluate(()=>navigator.clipboard.readText());
  assert.match(copiado,/Feedback sobre o Lume/);
  assert.match(copiado,/Relato: Não consegui conectar o WhatsApp/);
  assert.equal(copiado.includes('LUME-ABCDEFGHIJKL'),false);
  assert.equal(calls.filter(call=>call[0]==='feedback').length,2);

  offline = true;
  await page.evaluate(() => window.carregarCentral());
  await panel.getByText('A Central não está disponível agora. O Lume continua funcionando.').waitFor();
  assert.equal((await panel.textContent()).includes('detalhes internos'), false);
  assert.equal(await panel.locator('#central-feedback-form').isVisible(),true);
  assert.equal(await panel.locator('#central-feedback-send').isVisible(),false);
  assert.equal(await panel.locator('#central-feedback-contact-label').isVisible(),false);
  await panel.locator('#central-feedback-form').evaluate(form=>form.requestSubmit());
  assert.equal(calls.filter(call=>call[0]==='feedback').length,2);
  await page.getByRole('heading', { name: 'WhatsApp' }).waitFor();

  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if(width===390)await panel.screenshot({path:'work/feedback06-ui-qa/manual-copy-390.png'});
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(JSON.stringify({ passed: true, consent: true, feedbackReceipt: true, offlineDraft: true, revoke: true, offlineFallback: true, widths: [390, 1100] }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  db.close();
}
