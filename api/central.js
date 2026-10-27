import { CentralOperacional, respostaErro, segredoIgual } from '../src/operacao-central.js';
import { criarRepositorioNeon } from './_central/repositorio-neon.js';
import { bearer, corpoSeguro, json } from './_central/http.js';
import { cookieAdmin, criarSessaoAdmin, limparCookieAdmin, senhaAdminValida, sessaoAdminValida } from './_central/admin.js';
import { exigirOrigem, validarAmbienteCentral } from './_central/config.js';

const metodo=(req,esperado)=>{if(req.method!==esperado)throw Object.assign(new Error('METODO_NAO_PERMITIDO'),{codigo:'METODO_NAO_PERMITIDO',status:405});};
const exatas=(obj,chaves)=>{if(Object.keys(obj).some(chave=>!chaves.includes(chave))||chaves.some(chave=>!(chave in obj)))throw Object.assign(new Error('CAMPOS_INVALIDOS'),{codigo:'CAMPOS_INVALIDOS',status:400});};
const admin=(req,segredo)=>{if(!sessaoAdminValida(req.headers.cookie,segredo))throw Object.assign(new Error('NAO_AUTORIZADO'),{codigo:'NAO_AUTORIZADO',status:401});};

export function criarHandlerCentral({env=process.env,criarRepositorio=criarRepositorioNeon}={}){
  if(typeof criarRepositorio!=='function')throw new TypeError('criarRepositorio deve ser uma funcao');
  return async function handler(req,res){
    try{
      const config=validarAmbienteCentral(env);
      const action=String(req.query.action||'');
      if(action==='saude'){
        metodo(req,'GET');
        const banco=criarRepositorio(config.databaseUrl);
        return json(res,200,await banco.verificarSchema());
      }
      if(action==='retencao'){
        metodo(req,'GET');
        const segredo=env.CRON_SECRET;
        if(typeof segredo!=='string'||segredo.length<32||segredo.length>512)throw Object.assign(new Error('RETENCAO_NAO_CONFIGURADA'),{codigo:'RETENCAO_NAO_CONFIGURADA',status:503});
        if(!segredoIgual(String(req.headers.authorization||''),`Bearer ${segredo}`))throw Object.assign(new Error('NAO_AUTORIZADO'),{codigo:'NAO_AUTORIZADO',status:401});
        const limite=new Date(Date.now()-config.retentionDays*86400000).toISOString();
        const removidos=await criarRepositorio(config.databaseUrl).aplicarRetencao(limite);
        return json(res,200,{aplicado:true,limite,removidos});
      }
      if(action==='sessao'){
        exigirOrigem(req,config.publicOrigin);
        if(req.method==='DELETE'){res.setHeader('Set-Cookie',limparCookieAdmin);return json(res,200,{encerrada:true});}
        metodo(req,'POST');const body=corpoSeguro(req,1024);exatas(body,['senha']);
        if(!senhaAdminValida(body.senha,config.adminSecret))throw Object.assign(new Error('NAO_AUTORIZADO'),{codigo:'NAO_AUTORIZADO',status:401});
        res.setHeader('Set-Cookie',cookieAdmin(criarSessaoAdmin(config.adminSecret)));return json(res,200,{autenticada:true});
      }
      const central=new CentralOperacional({repositorio:criarRepositorio(config.databaseUrl),pepper:config.tokenPepper,versaoAtual:config.betaVersion});
      if(action==='registrar'){metodo(req,'POST');return json(res,201,await central.registrar(corpoSeguro(req)));}
      if(action==='pulso'){metodo(req,'POST');return json(res,200,await central.pulso(bearer(req),corpoSeguro(req)));}
      if(action==='feedback'){metodo(req,'POST');return json(res,201,await central.enviarFeedback(bearer(req),corpoSeguro(req,12288)));}
      if(action==='listar'){metodo(req,'GET');admin(req,config.adminSecret);return json(res,200,{instalacoes:await central.listar(),versaoAtual:config.betaVersion});}
      if(action==='listar-feedback'){metodo(req,'GET');admin(req,config.adminSecret);const {action:ignored,...filtros}=req.query;return json(res,200,await central.listarFeedback(filtros));}
      if(action==='revisar-feedback'){metodo(req,'POST');exigirOrigem(req,config.publicOrigin);admin(req,config.adminSecret);const body=corpoSeguro(req,1024);exatas(body,['estado','severidade']);return json(res,200,await central.revisarFeedback(String(req.query.id||''),body.estado,body.severidade));}
      if(action==='excluir-feedback'){metodo(req,'POST');exigirOrigem(req,config.publicOrigin);admin(req,config.adminSecret);return json(res,200,await central.excluirFeedback(String(req.query.id||'')));}
      if(action==='convite'){metodo(req,'POST');exigirOrigem(req,config.publicOrigin);admin(req,config.adminSecret);const body=corpoSeguro(req,1024);exatas(body,['rotulo']);return json(res,201,await central.criarConvite(body.rotulo));}
      if(action==='revogar-convite'){metodo(req,'POST');exigirOrigem(req,config.publicOrigin);admin(req,config.adminSecret);return json(res,200,await central.revogarConvite(String(req.query.id||'')));}
      if(action==='revogar'){metodo(req,'POST');exigirOrigem(req,config.publicOrigin);admin(req,config.adminSecret);return json(res,200,await central.revogar(String(req.query.id||'')));}
      throw Object.assign(new Error('ROTA_NAO_ENCONTRADA'),{codigo:'ROTA_NAO_ENCONTRADA',status:404});
    }catch(error){const resposta=respostaErro(error);return json(res,resposta.status,resposta.corpo);}
  };
}

export default criarHandlerCentral();
