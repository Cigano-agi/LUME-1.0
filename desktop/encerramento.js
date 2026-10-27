// Composição terminal: o corte ocorre no mesmo turno; o banco só fecha após
// todos os trabalhos e seus finalizers concluírem, mesmo quando um falha.
export function criarEncerramentoDesktop({cortar,drenar,fecharBanco,aposFecharBanco=()=>{},sair}) {
  let encerramento;
  return function encerrar() {
    if(encerramento)return encerramento;
    const iniciar=fn=>{try{return Promise.resolve(fn());}catch(error){return Promise.reject(error);}};
    const corte=iniciar(cortar);
    const trabalhos=drenar.map(iniciar);
    encerramento=Promise.allSettled([corte,...trabalhos]).then(async resultados=>{
      const falha=resultados.find(resultado=>resultado.status==='rejected');
      if(falha)throw falha.reason;
      await fecharBanco();
      await aposFecharBanco();
      await sair(0);
    });
    return encerramento;
  };
}
