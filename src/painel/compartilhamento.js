// Interface local. Nomes, arquivos e mensagens entram somente por textContent.
const f10Panel=element('section',null,'panel settings-card');
f10Panel.innerHTML=`<h2>Compartilhar um projeto</h2><p>Você escolhe o contexto, confere as fontes e salva um arquivo. A entrega é manual. Nada é sincronizado com os sócios.</p>
<details><summary>1 · Sua identidade de compartilhamento</summary><p>A assinatura ajuda a conferir quem criou o arquivo. Passe seu código à outra pessoa por uma conversa ou ligação em que vocês já confiam.</p><p id="f10-identity" class="fingerprint"></p><button id="f10-create-identity" class="secondary">Criar minha identidade protegida</button><p class="muted">A chave fica protegida neste computador. O nome informado no primeiro acesso aparece como remetente.</p></details>
<details><summary>2 · Organizar um projeto de contexto</summary><form id="f10-project-form"><label for="f10-name">Nome do projeto</label><input id="f10-name" maxlength="100" required placeholder="Ex.: Beta ReadyWorks"><p>Marque as conversas deste projeto. Na exportação, apenas as fontes permitidas pelo seu recorte poderão sair. Novas mensagens dessas conversas entram na próxima prévia; nada sai sozinho.</p><div id="f10-conversations" class="f10-scroll"></div><button class="secondary">Criar projeto</button></form></details>
<details><summary>3 · Conferir e salvar o arquivo</summary><form id="f10-export-form"><label for="f10-export-project">Projeto</label><select id="f10-export-project" required></select><label for="f10-recipient">Para quem você vai entregar?</label><input id="f10-recipient" maxlength="100" required placeholder="Nome do sócio"><button class="secondary">Conferir fontes</button></form><div id="f10-export-preview" hidden></div></details>
<details><summary>Receber um projeto de outra pessoa</summary><p>Escolha o arquivo e confira as fontes. Antes de importar, peça ao remetente o código da identidade por um canal confiável. O código dentro do próprio arquivo não prova quem é a pessoa.</p><label for="f10-file">Arquivo de compartilhamento · JSON, até 8 MB</label><input id="f10-file" type="file" accept=".json,application/json"><div id="f10-import-preview" hidden></div></details>
<details><summary>Origens recebidas e exclusão</summary><p>Remover apaga a contribuição desta origem neste aplicativo. Fontes próprias ou recebidas também de outra pessoa permanecem. Backups e arquivos já entregues não são apagados. A mesma identidade ficará bloqueada para novas importações.</p><div id="f10-origins"></div></details><p id="f10-status" role="status" aria-live="polite"></p>`;
window.registrarAjuste(f10Panel,'f10-panel','data');
let f10State=null;
const f10api=(acao,body)=>api('/api/v3/compartilhamento/'+acao,body);
const f10status=text=>{$('f10-status').textContent=text;};
function f10Sources(parent,eventos){
  const box=element('div',null,'f10-scroll'),count=element('p'),more=element('button','Ver mais fontes','text-button');let shown=0;
  more.type='button';const next=()=>{for(const e of eventos.slice(shown,shown+50)){const row=element('article',null,'source');row.append(element('b',e.conversa_nome),element('small',date(e.recebido_em)+' · '+e.origem_id),element('p',e.texto||(e.transcricao?'Mensagem capturada sem texto; transcrição disponível abaixo.':'Fonte sem texto; apenas metadados.')),element('small','Autor: '+(e.autor_id||'Não identificado')));if(e.transcricao){const d=element('details');d.append(element('summary','Inclui transcrição, original e tentativas'),element('p','Texto tratado: '+(e.transcricao.texto??'Sem fala transcrita.')),element('p','Original do modelo: '+(e.transcricao.textoOriginal??'Não preservado.')));for(const [i,r]of(e.transcricao.respostas||[]).entries())d.append(element('p','Tentativa '+(i+1)+': '+r.textoOriginal));row.append(d);}box.append(row);}shown=Math.min(shown+50,eventos.length);count.textContent=`${shown} de ${eventos.length} fontes mostradas`;more.hidden=shown===eventos.length;};more.onclick=next;next();parent.append(count,box,more);
}
function f10Projects(select){select.replaceChildren(new Option('Escolha um projeto',''));for(const p of f10State.projetos)select.append(new Option(p.nome,p.id));}
window.carregarCompartilhamento=async()=>{
  const revisao=revisaoDadosVisiveis,nextState=await api('/api/v3/compartilhamento');if(revisao!==revisaoDadosVisiveis)return;f10State=nextState;const state=f10State.identidade;
  $('f10-identity').textContent=state.criada?'Seu código: '+state.fingerprint:'Sua identidade ainda não foi criada.';
  $('f10-create-identity').disabled=state.criada||!state.disponivel;
  if(!state.disponivel)$('f10-identity').textContent='A proteção do sistema precisa estar disponível para criar sua identidade.';
  f10Projects($('f10-export-project'));
  const conversas=await api('/api/v3/conversas');
  if(revisao!==revisaoDadosVisiveis)return;
  $('f10-conversations').replaceChildren(...conversas.map(c=>{const label=element('label',null,'check'),input=element('input');input.type='checkbox';input.value=c.id;label.append(input,element('span',c.nome+' · '+(c.politica==='tudo'?'toda a conversa':'só minhas e dirigidas')));return label;}));
  if(!conversas.length)$('f10-conversations').append(element('p','Sem conversas ainda. Você pode criar um projeto vazio para receber fontes.'));
  $('f10-origins').replaceChildren(...f10State.origens.map(o=>{
    const box=element('details'),sum=element('summary',o.pessoa+' · '+o.fontes+' fontes'),preview=element('div'),conferir=action('Conferir remoção',async()=>{
      const p=await f10api('preparar-remocao',{fingerprint:o.fingerprint});preview.replaceChildren(element('h3','Confira antes de remover'),element('p',p.aviso));mostrarContagens(preview,p.contagens);
      if(p.arquivos.length){const files=element('details');files.append(element('summary',p.arquivos.length+' arquivos geridos'));for(const path of p.arquivos)files.append(element('p',path,'fingerprint'));preview.append(files);}
      const form=element('form'),input=element('input'),label=element('label','Digite REMOVER para apagar esta origem'),button=element('button','Remover origem','secondary');input.required=true;input.pattern='REMOVER';input.id='remove-'+o.fingerprint;label.htmlFor=input.id;form.append(label,input,button);
      form.onsubmit=e=>{e.preventDefault();run(async()=>{
        const r=await f10api('remover-origem',{id:p.id,fingerprint:o.fingerprint,confirmar:input.value});window.limparDadosVisiveis?.(r);await window.carregarCompartilhamento();await window.carregarDados?.();await window.carregarIA?.();await status();
        f10status(`${r.removidos} fontes apagadas; ${r.preservados} preservadas por serem próprias ou terem outra origem. ${r.contagens.notasDerivadas} notas vinculadas removidas. ${r.arquivosPendentes?'Há arquivos pendentes: retome a limpeza nos recibos. ':''}${r.limite}`);
      },button);};preview.append(form);
    },'secondary');box.append(sum,element('p',o.fingerprint,'fingerprint'),conferir,preview);return box;
  }));
  if(!f10State.origens.length)$('f10-origins').append(element('p','Nenhuma origem recebida.'));
};
$('f10-create-identity').onclick=()=>run(async()=>{await f10api('identidade',{});await window.carregarCompartilhamento();f10status('Identidade criada. Confira seu código acima.');},$('f10-create-identity'));
$('f10-project-form').onsubmit=e=>{e.preventDefault();run(async()=>{const p=await f10api('projeto',{nome:$('f10-name').value,conversas:[...$('f10-conversations').querySelectorAll('input:checked')].map(i=>i.value)});$('f10-name').value='';await window.carregarCompartilhamento();$('f10-export-project').value=p.id;f10status('Projeto criado. Agora você pode conferir as fontes ou receber um arquivo nele.');},e.submitter);};
$('f10-export-form').onsubmit=e=>{e.preventDefault();run(async()=>{
  const p=await f10api('preparar-exportacao',{projeto:$('f10-export-project').value,destinatario:$('f10-recipient').value});
  const box=$('f10-export-preview');box.hidden=false;box.replaceChildren(element('h3',p.conteudo.projeto.nome+' · '+p.total+' fontes'),element('p','Para: '+p.conteudo.destinatario),element('p','O arquivo contém texto, autores, identificadores e datas. Inclui transcrições disponíveis, originais do modelo e tentativas; não inclui arquivos de áudio. Não é criptografado. Qualquer pessoa com uma cópia poderá lê-lo. O nome do destinatário é uma indicação, não um bloqueio de acesso.'));
  f10Sources(box,p.conteudo.eventos);
  box.append(action('Confirmar e salvar arquivo',async()=>{const result=await f10api('exportar',{id:p.id,confirmar:true});const blob=new Blob([JSON.stringify(result.pacote)],{type:'application/json'}),url=URL.createObjectURL(blob),a=element('a');a.href=url;a.download=result.nome;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);box.hidden=true;f10status('Arquivo preparado. Conclua o salvamento na janela do sistema. Você decide como entregá-lo.');},'primary'));
},e.submitter);};
$('f10-file').onchange=()=>run(async()=>{
  const file=$('f10-file').files[0];if(!file)return;const box=$('f10-import-preview');box.replaceChildren();box.hidden=true;
  if(file.size>8*1024*1024)throw new Error('Arquivo excede 8 MB. Peça um projeto menor.');
  const p=await f10api('preparar-importacao',{arquivo:await file.text()});box.hidden=false;
  box.append(element('h3',p.projeto.nome+' · '+p.total+' fontes'),element('p','Remetente declarado: '+p.remetente.pessoa+' · '+date(p.remetente.exportado_em)),element('p','Destinatário indicado: '+p.destinatario),element('p','Assinatura íntegra. A identidade da pessoa depende da conferência do código.'),element('p',p.fingerprint,'fingerprint'));
  f10Sources(box,p.eventos);if(p.revogada){box.append(element('p','Esta origem foi removida e está bloqueada.'));return;}
  const form=element('form'),select=element('select'),fp=element('input'),label=element('label','Projeto local para receber'),fplabel=element('label','Código confirmado por outro canal'),button=element('button','Conferi o remetente · importar','primary');select.id='f10-import-project';select.required=true;label.htmlFor=select.id;f10Projects(select);fp.id='f10-fingerprint';fp.required=true;fp.maxLength=100;fp.autocomplete='off';fp.className='fingerprint';fplabel.htmlFor=fp.id;
  form.append(label,select,fplabel,fp,element('p','Receber autoriza a leitura dessas fontes. Não autoriza o restante do grupo nem ativa IA remota.'),button);
  form.onsubmit=e=>{e.preventDefault();run(async()=>{const r=await f10api('importar',{id:p.id,projeto:select.value,fingerprintConfirmada:fp.value,confirmar:true});box.hidden=true;$('f10-file').value='';await window.carregarCompartilhamento();window.limparIA?.();f10status(`${r.novos} fontes novas; ${r.existentes} já existentes. Consulte a Memória para ver a origem.`);},button);};box.append(form);
});
