let carregando=null;
async function abrirGuia(){
  let dialog=document.getElementById('beta-dialog');
  if(dialog){dialog.showModal();return;}
  if(carregando)return carregando;
  carregando=(async()=>{
    const response=await fetch('/beta');if(!response.ok)throw Error('Não foi possível abrir o guia.');
    const doc=new DOMParser().parseFromString(await response.text(),'text/html'),content=doc.getElementById('beta-page');
    if(!content)throw Error('O guia não está disponível nesta versão.');
    dialog=document.createElement('dialog');dialog.id='beta-dialog';dialog.className='beta-dialog';dialog.setAttribute('aria-label','Guia do beta');
    const row=document.createElement('div'),close=document.createElement('button');row.className='beta-close-row';close.type='button';close.className='secondary';close.textContent='Voltar ao aplicativo';close.addEventListener('click',()=>dialog.close());row.append(close);
    const container=document.createElement('div');container.id='beta-page';container.className='beta-page';for(const child of content.childNodes)container.append(child.cloneNode(true));
    dialog.append(row,container);document.body.append(dialog);
    try{await import('./beta.js');dialog.showModal();}catch(error){dialog.remove();throw error;}
  })();
  try{await carregando;}catch(error){const status=document.getElementById('beta-open-status');if(status)status.textContent=error.message;}finally{carregando=null;}
}
for(const button of document.querySelectorAll('[data-beta-open]'))button.addEventListener('click',abrirGuia);
if(location.hash==='#beta')abrirGuia();
