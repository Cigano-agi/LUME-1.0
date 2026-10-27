// Theme preference is local to this installation. Apply before rendering the app.
(() => {
  const key='lume-theme-choice';
  const allowed=new Set(['system','light','dark']);
  const system=matchMedia('(prefers-color-scheme: dark)');
  let choice;
  try{choice=localStorage.getItem(key);}catch{}
  if(!allowed.has(choice))choice='system';
  const apply=()=>{
    document.documentElement.dataset.themeChoice=choice;
    document.documentElement.dataset.theme=choice==='system'?(system.matches?'dark':'light'):choice;
  };
  apply();
  system.addEventListener?.('change',()=>{if(choice==='system')apply();});
  document.addEventListener('DOMContentLoaded',()=>{
    const control=document.getElementById('theme-mode');
    if(!control)return;
    control.value=choice;
    control.addEventListener('change',()=>{
      if(!allowed.has(control.value))return;
      choice=control.value;
      try{localStorage.setItem(key,choice);}catch{}
      apply();
    });
  });
})();
