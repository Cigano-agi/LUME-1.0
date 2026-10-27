const campos=(data,names)=>{
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!names.includes(k)))throw new Error('Campos inválidos.');
};
export async function pessoalGet(service,path,query={}) {
  if(!service)return {enabled:false,available:false,chatgpt:{available:false},conversas:[],pendencias:[],autonomiaLiberada:false};
  if(path==='/api/v3/pessoal')return service.estado();
  if(path==='/api/v3/pessoal/conversas')return service.buscarConversas(query);
  if(path==='/api/v3/pessoal/organizacao'){
    const result=service.organizacao.listar({limite:100});
    const nome=service.db.prepare('SELECT nome FROM conversas_app WHERE id=?');
    for(const grupo of ['comercial','tarefas','projetos'])
      result[grupo]=result[grupo].map(item=>({...item,conversaNome:nome.get(item.conversaId)?.nome??null}));
    return result;
  }
  if(path==='/api/v3/pessoal/classificador')return service.classificador?.estado()??{enabled:false,configurada:false,limiteMensalMicrousd:0};
  if(path==='/api/v3/pessoal/companheiro')return service.companheiro?.estado()??{enabled:false,som:false,disponivel:false};
  if(path==='/api/v3/pessoal/avaliacao')return service.avaliacao.estado();
  if(path==='/api/v3/pessoal/avaliacao/relatorio')return service.avaliacao.estado({relatorio:true});
  if(path==='/api/v3/pessoal/chatgpt')return service.chatgpt.estado();
  if(path==='/api/v3/pessoal/chatgpt/modelos')return {modelos:await service.chatgpt.modelos()};
  throw new Error('Rota indisponível.');
}
export async function pessoalPost(service,path,data) {
  if(!service)throw new Error('Disponível no aplicativo desktop.');
  if(path==='/api/v3/pessoal/companheiro'){
    campos(data,['enabled','som','tema','movimento','volume','pausado','adiadoId','adiadoAte']);if(!service.companheiro)throw Error('Preferência indisponível.');
    return service.companheiro.configurar(data);
  }
  if(path==='/api/v3/pessoal/mensagem/preparar'){campos(data,['conversaId','baloes','motivo']);return service.prepararMensagemDono(data);}
  if(path==='/api/v3/pessoal/acompanhamento'){
    campos(data,['acaoId','confirmar']);if(data.confirmar!==true)throw Error('Confirme o acompanhamento deste assunto.');
    const item=service.acompanhar(data.acaoId);return {acaoId:item.acao.id,registrado:true};
  }
  if(path==='/api/v3/pessoal/mensagem/aprovar'){
    campos(data,['id','versao','confirmar']);if(data.confirmar!==true)throw Error('Confirme essa versão e destinatário.');
    return service.aprovar(data.id,data.versao,'local:owner');
  }
  if(path==='/api/v3/pessoal/avaliacao/iniciar'){campos(data,['confirmar']);return service.avaliacao.iniciar(data);}
  if(path==='/api/v3/pessoal/avaliacao/proximo'){campos(data,[]);return service.avaliacao.proximo({signal:service.controller.signal});}
  if(path==='/api/v3/pessoal/avaliacao/revisar'){campos(data,['id','digest','interpretacao','fontes','resposta','criticoAtendido','revisadoPor','evidencia']);return service.avaliacao.revisar(data);}
  if(path==='/api/v3/pessoal/avaliacao/aceitar'){campos(data,['confirmar']);return service.avaliacao.aceitar(data);}
  if(path==='/api/v3/pessoal/config'){campos(data,['enabled']);return service.configurar(data);}
  if(path==='/api/v3/pessoal/conversa'){campos(data,['conversaId','categoria','modo','remoto']);return service.configurarConversa(data);}
  if(path==='/api/v3/pessoal/atendimento'){campos(data,['conversaId','acao','minutos','inicio','fim']);return service.configurarAtendimento(data);}
  if(path==='/api/v3/pessoal/classificador'){
    campos(data,['enabled','confirmar','limiteMensalMicrousd']);if(!service.classificador)throw Error('Classificador indisponível.');return service.classificador.configurar(data);
  }
  if(path==='/api/v3/pessoal/vinculo'){campos(data,['conversaId','tipo','recurso','remover']);return service.ferramentas.vincular(data);}
  if(path==='/api/v3/pessoal/credencial'){
    campos(data,['tipo','token']);
    if(!['github','clickup'].includes(data.tipo)||typeof data.token!=='string'||data.token.length<10||data.token.length>2048||/\s/.test(data.token))throw Error('Credencial inválida.');
    if(!service.salvarCredencial)throw Error('Cofre indisponível.');
    await service.salvarCredencial(data.tipo,data.token);return {configurada:true};
  }
  if(path==='/api/v3/pessoal/chatgpt/login'){campos(data,['accountId']);return service.chatgpt.iniciarLogin(data);}
  if(path==='/api/v3/pessoal/chatgpt/modelo'){campos(data,['model']);return service.chatgpt.selecionarModelo(data.model);}
  if(path==='/api/v3/pessoal/chatgpt/conta'){campos(data,['id']);return service.chatgpt.selecionarConta(data.id);}
  campos(data,[]);
  if(path==='/api/v3/pessoal/chatgpt/testar')return service.chatgpt.responder({instructions:'Responda apenas: Lume conectado.',input:[{role:'user',content:'Verificação de conexão do Lume, sem conteúdo privado.'}]});
  if(path==='/api/v3/pessoal/chatgpt/sair')return service.chatgpt.sair();
  if(path==='/api/v3/pessoal/chatgpt/retomar'){service.chatgpt.retomar();return service.chatgpt.estado();}
  throw Error('Rota indisponível.');
}
