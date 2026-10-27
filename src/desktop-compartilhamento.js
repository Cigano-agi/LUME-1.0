import { randomUUID } from 'node:crypto';
import { Compartilhamento, canonico, verificarPacote } from './compartilhamento.js';

export class DesktopCompartilhamento {
  constructor(db,{identidade,perfil,privacidade,invalidar=()=>{}}={}){this.f=new Compartilhamento(db,{privacidade});this.identidade=identidade;this.perfil=perfil;this.invalidar=invalidar;this.previas=new Map();}
  guardar(valor){for(const [id,p] of this.previas)if(p.expira<Date.now())this.previas.delete(id);if(this.previas.size>=10)this.previas.delete(this.previas.keys().next().value);const id=randomUUID();this.previas.set(id,{...valor,expira:Date.now()+300000});return id;}
  obter(id,tipo){const p=this.previas.get(id);if(!p||p.tipo!==tipo||p.expira<Date.now())throw new Error('Prévia expirada. Confira o arquivo novamente.');return p;}
  async estado(){return {projetos:this.f.projetos(),origens:this.f.origens(),identidade:this.identidade?await this.identidade('f10-estado'):{disponivel:false,criada:false}};}
  async criarIdentidade(){if(!this.identidade)throw new Error('A proteção de identidade está indisponível.');return this.identidade('f10-criar');}
  prepararExportacao(data){const conteudo=this.f.prepararExportacao({...data,pessoa:this.perfil().nome,maquina:'Assessor desktop'});const id=this.guardar({tipo:'exportar',conteudo});return {id,conteudo,total:conteudo.eventos.length};}
  async exportar({id,confirmar}={}){
    if(confirmar!==true)throw new Error('Confirme a criação do arquivo.');
    const p=this.obter(id,'exportar');this.previas.delete(id);this.f.conferirAtual(p.conteudo);
    if(!this.identidade)throw new Error('Identidade protegida indisponível.');
    const ass=await this.identidade('f10-assinar',canonico(p.conteudo));
    this.f.conferirAtual(p.conteudo);
    const pacote={conteudo:p.conteudo,...ass};verificarPacote(pacote);
    return {nome:`assessor-projeto-${p.conteudo.id}.json`,pacote,aviso:'Arquivo não criptografado. Entregue manualmente apenas à pessoa indicada; a indicação não bloqueia outras pessoas que tenham o arquivo.'};
  }
  prepararImportacao({arquivo}={}){const v=verificarPacote(arquivo);const previa=this.f.previa(v.pacote);return {...previa,id:this.guardar({tipo:'importar',pacote:v.pacote})};}
  importar({id,projeto,fingerprintConfirmada,confirmar}={}){if(confirmar!==true)throw new Error('Confirme a importação.');const p=this.obter(id,'importar');const r=this.f.importar(p.pacote,{projeto,fingerprintConfirmada});this.previas.delete(id);this.invalidar();return r;}
  prepararRemocao(data){return this.f.prepararRemocao(data);}
  removerOrigem(data){if(!data?.id)throw new Error('Confira a prévia antes de remover a origem.');const r=this.f.removerOrigem(data);this.previas.clear();this.invalidar();return r;}
}
