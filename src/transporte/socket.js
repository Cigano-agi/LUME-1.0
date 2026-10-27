import { abrirSessao, bloquearSessao, arquivarSessaoInvalida } from './sessao.js';
import {randomUUID} from 'node:crypto';
import {jidNormalizedUser} from '@whiskeysockets/baileys';
import {nomeWhatsappValido} from '../nomes-conversa.js';

const jidDaConta=id=>typeof id==='string'?id.replace(/^([^@:]+):\d+@/,'$1@'):null;
// Identidade suportada pelo protocolo Web; o nome do produto permanece Lume.
export const identidadeDispositivo = Browsers => Browsers.appropriate('Chrome');

/** Baileys lifecycle. Outgoing text requires a fresh, exact authorization. */
export class Conexao {
  #dados = { estado: 'desconectada', qr: null, qrGeradoEm: null, qrVersao: 0, erro: null, erroGrupos: null, conectadoEm: null, ultimaRecepcaoEm: null, ultimoFechamento: null };
  #ativo = false; #geracao = 0; #socket; #inicio; #timer; #tentativas = 0;
  #listeners = []; #fila = Promise.resolve(); #sessao; #liberar; #parada; #authInvalida = false;
  #filaGrupos = Promise.resolve(); #timerGrupos;
  #sessaoLabels=null;
  #terminal=false; #encerramento; #trabalhos=new Set(); #fechamentos=new Set(); #falhasFechamento=[]; #falhasSoltura=[];
  constructor({ authDir, aoLote, aoGrupos, aoNomes=null, aoAtualizarMensagens, aoRemoverMensagens, aoRecibos=null, autorizarEnvio=()=>false, whatsappLabels=null, historico=null, aoEstado = () => {}, aoDiagnostico = () => {}, criarSocket, recuperarSessao = arquivarSessaoInvalida }) {
    if (!authDir || typeof aoLote !== 'function') throw new TypeError('authDir e aoLote obrigatorios');
    this.authDir = authDir; this.aoLote = aoLote; this.aoGrupos = aoGrupos; this.aoAtualizarMensagens = aoAtualizarMensagens; this.aoRemoverMensagens = aoRemoverMensagens; this.aoEstado = aoEstado; this.criarSocket = criarSocket;
    this.aoDiagnostico = aoDiagnostico;
    this.aoNomes = aoNomes;
    this.recuperarSessao = recuperarSessao;
    this.whatsappLabels=whatsappLabels;
    this.historico=historico;
    this.aoRecibos=aoRecibos;this.autorizarEnvio=autorizarEnvio;
  }
  async enviarTexto(conversaId,texto,messageId) {
    if(this.#terminal||!this.#ativo||this.#dados.estado!=='conectada'||!this.#socket?.sendMessage||
      typeof conversaId!=='string'||!/^\d+@(?:s\.whatsapp\.net|lid)$/.test(conversaId)||
      typeof texto!=='string'||!texto.trim()||texto.length>3000||!/^([A-F0-9]{40})$/.test(messageId)||
      this.autorizarEnvio(conversaId,messageId,texto)!==true)throw new Error('Envio indisponível ou sem autorização vigente.');
    // No presence or read-receipt call is made as part of this transport.
    return this.#acompanhar(Promise.resolve(this.#socket.sendMessage(conversaId,{text:texto},{messageId}))
      .then(result=>result?.key?.id||null));
  }
  estado() { return { ...this.#dados, ultimoFechamento:this.#dados.ultimoFechamento?{...this.#dados.ultimoFechamento}:null }; }
  sessaoLabels(){return this.#dados.estado==='conectada'&&this.#sessaoLabels?{...this.#sessaoLabels}:null;}
  #acompanhar(trabalho) {
    const promessa=Promise.resolve(trabalho);
    const final=promessa.then(()=>{},()=>{}).finally(()=>this.#trabalhos.delete(final));
    this.#trabalhos.add(final);
    return promessa;
  }
  async sincronizarGrupos() {
    if(this.#terminal)throw Object.assign(new Error('Sincronizacao de grupos indisponivel'),{code:'GRUPOS_INDISPONIVEIS'});
    const socket = this.#socket;
    if (!this.#ativo || !socket?.groupFetchAllParticipating || this.#dados.estado !== 'conectada') {
      const erro = Object.assign(new Error('Sincronizacao de grupos indisponivel'), { code: 'GRUPOS_INDISPONIVEIS' });
      this.#estado({ erroGrupos: erro.message });
      throw erro;
    }
    return this.#processarGrupos(() => socket.groupFetchAllParticipating());
  }
  #processarGrupos(obter) {
    const geracao = this.#geracao;
    const atual = () => this.#ativo && geracao === this.#geracao;
    const validar = () => {
      if (!atual()) throw Object.assign(new Error('Sincronizacao de grupos cancelada'), { code: 'GRUPOS_CANCELADOS' });
    };
    const trabalho = this.#filaGrupos.then(async () => {
      validar();
      let grupos = await obter();
      validar();
      if (grupos == null) throw new Error('Resposta de grupos ausente');
      const preservarNome=g=>{
        if(!g||g.subject===undefined||nomeWhatsappValido(g.subject,g.id))return g;
        const {subject,...restante}=g;return restante;
      };
      grupos=Array.isArray(grupos)?grupos.map(preservarNome):Object.fromEntries(Object.entries(grupos).map(([id,g])=>[id,preservarNome(g)]));
      if (this.aoGrupos) await this.aoGrupos(grupos);
      validar();
      this.#estado({ erroGrupos: null });
      return grupos;
    }).catch(() => {
      validar(); // Old sockets cannot overwrite the current connection status.
      const erro = Object.assign(new Error('Falha ao sincronizar grupos WhatsApp'), { code: 'GRUPOS_FALHA' });
      this.#estado({ erroGrupos: erro.message });
      throw erro;
    });
    // Drain errors internally while preserving rejection for manual API callers.
    this.#filaGrupos = trabalho.catch(() => {});
    return trabalho;
  }
  #estado(patch) {
    Object.assign(this.#dados, patch);
    try { this.historico?.observarEstado(this.estado()); } catch { this.#dados.erro='Falha ao registrar cobertura do histórico'; }
    try { this.aoEstado(this.estado()); } catch { /* Observers cannot break transport. */ }
  }
  async iniciar() {
    if (this.#terminal) throw Object.assign(new Error('Conexao WhatsApp encerrada'),{code:'SOCKET_ENCERRADO'});
    if (this.#ativo) return this.#inicio;
    const anterior = this.#inicio;
    const parada = this.#parada;
    const geracao = ++this.#geracao;
    this.#ativo = true; this.#tentativas = 0;
    this.#inicio = (async () => {
      await anterior;
      await parada;
      if (!this.#ativo || geracao !== this.#geracao) return;
      if (this.#authInvalida) {
        try {
          await this.#fila;
          await this.#soltar();
          if (!this.#ativo || geracao !== this.#geracao) return;
          await this.recuperarSessao(this.authDir);
          this.#authInvalida = false;
        } catch {
          if (geracao === this.#geracao) {
            this.#ativo = false;
            this.#estado({ estado: 'auth_invalida', qr: null, qrGeradoEm: null, erro: 'Falha ao arquivar sessao invalida para novo pareamento' });
          }
          return;
        }
      }
      if (this.#ativo && geracao === this.#geracao) await this.#conectar();
    })();
    return this.#inicio;
  }
  async #conectar() {
    const geracao = ++this.#geracao;
    const atual = () => this.#ativo && geracao === this.#geracao;
    this.#estado({ estado: 'conectando', qr: null, qrGeradoEm: null, erro: null });
    try {
      let socket;
      if (this.criarSocket) socket = await this.criarSocket({ authDir: this.authDir, markOnlineOnConnect: false });
      else {
        if (!this.#liberar) this.#liberar = await bloquearSessao(this.authDir);
        if (!atual()) { await this.#soltar(); return; }
        this.#sessao ??= await abrirSessao(this.authDir);
        if (!atual()) { await this.#soltar(); return; }
        const [{ default: makeWASocket, Browsers }, { default: pino }] = await Promise.all([import('@whiskeysockets/baileys'), import('pino')]);
        if (!atual()) { await this.#soltar(); return; }
        socket = makeWASocket({ auth: this.#sessao.state, logger: pino({ level: 'silent' }), browser: identidadeDispositivo(Browsers), markOnlineOnConnect: false, syncFullHistory: true, shouldSyncHistoryMessage: () => true });
      }
      if (!atual()) { await this.#fecharSocket(socket); return; }
      this.#socket = socket;
      const sessaoId=randomUUID();let sessaoLabels=null;
      const escutar = (evento, callback) => {
        const listener = data => { if (atual()) callback(data); };
        socket.ev.on(evento, listener); this.#listeners.push([socket.ev, evento, listener]);
      };
      escutar('creds.update', () => {
        this.#sessao?.salvar().catch(() => { if (atual()) this.#estado({ erro: 'Falha ao salvar credenciais' }); });
      });
      const nomes = async lote => {
        if(!this.aoNomes)return;
        try{await this.aoNomes(lote);}
        catch{
          this.#estado({erro:'Falha ao registrar nomes do WhatsApp'});
          try{this.aoDiagnostico({evento:'nomes_whatsapp_falhou',codigo:'NOMES_FALHA'});}catch{}
        }
      };
      const receberNomes=lote=>{this.#fila=this.#fila.then(()=>nomes(lote));};
      escutar('contacts.upsert',contacts=>receberNomes({contacts}));
      escutar('contacts.update',contacts=>receberNomes({contacts}));
      escutar('chats.upsert',chats=>receberNomes({chats}));
      escutar('chats.update',chats=>receberNomes({chats}));
      escutar('lid-mapping.update',par=>receberNomes({lidPnMappings:[par]}));
      const receber = (lote,metadados=lote) => {
        this.#estado({ ultimaRecepcaoEm: new Date().toISOString() });
        const donoJids=[...new Set([socket.user?.id,socket.user?.lid].map(jidDaConta).filter(Boolean))];
        // Events are processed in arrival order; rejected batches remain visible.
        this.#fila = this.#fila.then(async () => {
          await nomes(metadados);
          const resultado=await this.aoLote({...lote,donoJids});
          this.historico?.observarLote(lote,resultado);
          if(atual()&&this.historico?.retomarAoReceber) {
            try { void this.#acompanhar(this.historico.retomarAoReceber(this,lote)).catch(()=>{}); }
            catch { /* Recovery failure remains local to history. */ }
          }
        })
          .catch(() => { this.#estado({ erro: 'Falha na ingestao do lote WhatsApp' }); });
      };
      escutar('messages.upsert', lote => receber(lote));
      escutar('messaging-history.set', lote => receber({ messages: lote.messages ?? [], type: 'history', isLatest: lote.isLatest === true },{
        contacts:lote.contacts??[],chats:lote.chats??[],lidPnMappings:lote.lidPnMappings??[],messages:lote.messages??[]
      }));
      escutar('messages.update', updates => {
        if(Array.isArray(updates)&&this.aoRecibos){
          const recibos=updates.filter(item=>Number.isInteger(item?.update?.status));
          if(recibos.length)this.#fila=this.#fila.then(()=>this.aoRecibos(recibos)).catch(()=>{this.#estado({erro:'Falha ao registrar recibo de envio'});});
        }
        if (!this.aoAtualizarMensagens || !Array.isArray(updates)) return;
        const comConteudo=updates.filter(item=>item?.update?.message);
        if (!comConteudo.length) return;
        this.#fila=this.#fila.then(async()=>{await this.aoAtualizarMensagens(comConteudo);})
          .catch(()=>{
            this.#estado({erro:'Falha ao processar atualizacao de mensagem'});
            try{this.aoDiagnostico({evento:'messages_update_falhou',codigo:'CICLO_MENSAGEM_FALHA'});}catch{}
          });
      });
      escutar('messages.delete', evento => {
        if(!this.aoRemoverMensagens||!evento)return;
        this.#fila=this.#fila.then(async()=>{await this.aoRemoverMensagens(evento);})
          .catch(()=>{
            this.#estado({erro:'Falha ao processar remocao de mensagem'});
            try{this.aoDiagnostico({evento:'messages_delete_falhou',codigo:'CICLO_MENSAGEM_FALHA'});}catch{}
          });
      });
      if(this.whatsappLabels){
        escutar('labels.edit',label=>{
          if(!sessaoLabels)return;
          const identidade={...sessaoLabels};
          this.#fila=this.#fila.then(()=>this.whatsappLabels.observarLabel(identidade,label)).catch(()=>{if(atual())this.#estado({erro:'Falha ao observar label do WhatsApp'});});
        });
        escutar('labels.association',evento=>{
          if(!sessaoLabels)return;
          const identidade={...sessaoLabels};
          this.#fila=this.#fila.then(()=>this.whatsappLabels.observarAssociacao(identidade,evento)).catch(()=>{if(atual())this.#estado({erro:'Falha ao observar associacao de label do WhatsApp'});});
        });
      }
      if (this.aoGrupos) {
        escutar('groups.upsert', grupos => { this.#processarGrupos(() => grupos).catch(() => {}); });
        escutar('groups.update', updates => { this.#processarGrupos(() => updates).catch(() => {}); });
        escutar('group-participants.update', update => {
          if (socket.groupMetadata && update?.id) {
            this.#processarGrupos(async () => {
              const meta = await socket.groupMetadata(update.id);
              return meta ? [meta] : null;
            }).catch(() => {});
          }
        });
      }
      escutar('connection.update', update => {
        if (update.qr) {
          const mudou = update.qr !== this.#dados.qr;
          this.#estado({
            estado: 'aguardando_qr', qr: update.qr, erro: null,
            qrGeradoEm: mudou ? new Date().toISOString() : this.#dados.qrGeradoEm,
            qrVersao: mudou ? this.#dados.qrVersao + 1 : this.#dados.qrVersao
          });
        }
        if (update.connection === 'open') {
          const contaId=jidNormalizedUser(socket.user?.id);
          if(contaId){
            sessaoLabels={contaId,geracao,sessaoId};
            this.#sessaoLabels={...sessaoLabels};
            this.whatsappLabels?.ativarSessao(sessaoLabels);
          }
          this.#tentativas = 0;
          this.#estado({ estado: 'conectada', qr: null, qrGeradoEm: null, erro: null, conectadoEm: new Date().toISOString(), ultimoFechamento:null });
          if(this.historico?.drenarPendentes){
            try{void this.#acompanhar(this.historico.drenarPendentes(this)).catch(()=>{});}catch{}
          }
          if (this.aoGrupos) {
            clearTimeout(this.#timerGrupos);
            this.#timerGrupos = setTimeout(() => {
              if (atual() && this.#dados.estado === 'conectada') {
                this.sincronizarGrupos().catch(erro => {
                  try { this.aoDiagnostico({
                    evento: 'sync_grupos_falhou',
                    codigo: erro?.code === 'GRUPOS_FALHA' ? 'GRUPOS_FALHA' : 'GRUPOS_INDISPONIVEIS'
                  }); } catch { /* O observador não interrompe o transporte. */ }
                });
              }
            }, 1000);
            this.#timerGrupos.unref?.();
          }
        }
        if (update.connection === 'close') {
          const codigo = Number(update.lastDisconnect?.error?.output?.statusCode ?? update.lastDisconnect?.error?.statusCode);
          // A mensagem do erro pode conter identidade, caminho ou payload remoto.
          // O estado local e os observadores recebem apenas campos fechados.
          const ultimoFechamento={
            codigo:Number.isInteger(codigo)&&codigo>=100&&codigo<=599?codigo:null,
            tentativas:this.#tentativas,em:new Date().toISOString()
          };
          this.#dados.ultimoFechamento=ultimoFechamento;
          try{this.aoDiagnostico({evento:'conexao_fechada',...ultimoFechamento});}catch{}
          this.whatsappLabels?.invalidarSessao(sessaoLabels);
          if(this.#sessaoLabels?.sessaoId===sessaoId)this.#sessaoLabels=null;
          ++this.#geracao; this.#desligar();
          if ([401, 403, 411, 440, 500].includes(codigo)) {
            this.#ativo = false;
            this.#authInvalida = codigo !== 440;
            this.#estado({ estado: codigo === 440 ? 'substituida' : 'auth_invalida', qr: null, qrGeradoEm: null, erro: `Conexao encerrada (${codigo})` });
          } else this.#reagendar(codigo === 515 && this.#tentativas === 0 ? 0 : undefined);
        }
      });
    } catch {
      if (atual()) {
        // Factory/auth failures do not disclose paths, tokens, or remote payloads.
        this.#ativo = false; this.#estado({ estado: 'erro', qr: null, qrGeradoEm: null, erro: 'Falha ao iniciar conexao WhatsApp' });
        await this.#soltar();
      }
    }
  }
  #reagendar(delay = Math.min(30_000, 1000 * 2 ** Math.min(this.#tentativas, 5))) {
    this.#tentativas++;
    this.#estado({ estado: 'reconectando', qr: null, qrGeradoEm: null, erro: 'Conexao interrompida; reconexao agendada' });
    this.#timer = setTimeout(() => { this.#timer = null; if (this.#ativo) this.#inicio = this.#conectar(); }, delay);
    this.#timer.unref?.();
  }
  #desligar() {
    this.whatsappLabels?.invalidarSessao(this.#sessaoLabels);
    this.#sessaoLabels=null;
    clearTimeout(this.#timerGrupos); this.#timerGrupos = null;
    for (const [ev, evento, listener] of this.#listeners) ev.off ? ev.off(evento, listener) : ev.removeListener(evento, listener);
    this.#listeners = [];
    const socket = this.#socket; this.#socket = null;
    return this.#fecharSocket(socket);
  }
  #fecharSocket(socket) {
    if(!socket)return Promise.resolve();
    const trabalho=Promise.resolve().then(()=>socket.end?.(undefined));
    const final=trabalho.then(()=>{},error=>{this.#falhasFechamento.push(error);}).finally(()=>this.#fechamentos.delete(final));
    this.#fechamentos.add(final);
    return final;
  }
  async #soltar() {
    const sessao=this.#sessao;this.#sessao=null;
    const liberar=this.#liberar;this.#liberar=null;
    let falha;
    try{await sessao?.concluir();}catch(error){falha=error;}
    // A trava só sai depois que a sessão terminou de persistir credenciais.
    try{await liberar?.();}catch(error){falha=falha?new AggregateError([falha,error],'Falha ao soltar sessao WhatsApp'):error;}
    if(falha){this.#falhasSoltura.push(falha);throw falha;}
  }
  baixarMidia(mensagem, tipo = 'buffer', opcoes = {}) {
    if(this.#terminal)return Promise.reject(Object.assign(new Error('Socket WhatsApp indisponivel'),{code:'SOCKET_INDISPONIVEL'}));
    return this.#acompanhar((async()=>{
    const socket = this.#socket;
    if (!socket) {
      const erro = Object.assign(new Error('Socket WhatsApp indisponivel'), { code: 'SOCKET_INDISPONIVEL' });
      throw erro;
    }
    if (typeof socket.downloadMediaMessage === 'function') {
      return socket.downloadMediaMessage(mensagem, tipo, opcoes);
    }
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    return downloadMediaMessage(
      mensagem,
      tipo,
      opcoes,
      {
        reuploadRequest: (msg) => {
          if (socket.updateMediaMessage) return socket.updateMediaMessage(msg);
          return Promise.reject(new Error('updateMediaMessage indisponivel'));
        }
      }
    );
    })());
  }
  solicitarHistorico({ chave, timestamp, limite = 50 } = {}) {
    if(this.#terminal)return Promise.reject(Object.assign(new Error('Histórico indisponível nesta conexão'),{code:'HISTORICO_INDISPONIVEL'}));
    return this.#acompanhar((async()=>{
    const socket=this.#socket,geracao=this.#geracao;
    if(!this.#ativo||this.#dados.estado!=='conectada'||typeof socket?.fetchMessageHistory!=='function') {
      throw Object.assign(new Error('Histórico indisponível nesta conexão'),{code:'HISTORICO_INDISPONIVEL'});
    }
    if(!chave||typeof chave.remoteJid!=='string'||typeof chave.id!=='string'||typeof chave.fromMe!=='boolean'||!Number.isSafeInteger(timestamp)||timestamp<=0||!Number.isSafeInteger(limite)||limite<1||limite>50)throw new TypeError('Referência de histórico inválida');
    let timer;
    let recibo;
    try {
      const fetchReal=this.#acompanhar(socket.fetchMessageHistory(limite,{remoteJid:chave.remoteJid,id:chave.id,fromMe:chave.fromMe},timestamp));
      recibo=await Promise.race([
        fetchReal,
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('WhatsApp não respondeu ao pedido de histórico'),{code:'HISTORICO_INDISPONIVEL'})),20_000);timer.unref?.();})
      ]);
    } finally { clearTimeout(timer); }
    if(geracao!==this.#geracao||socket!==this.#socket||!this.#ativo)throw Object.assign(new Error('Conexão alterada durante a recuperação'),{code:'HISTORICO_CANCELADO'});
    return { solicitado:true,recibo:typeof recibo==='string'?recibo:null };
    })());
  }
  parar() {
    if(this.#terminal)return this.#encerramento??this.#parada??Promise.resolve();
    return this.#pararAgora();
  }
  #pararAgora() {
    this.#ativo = false; ++this.#geracao;
    clearTimeout(this.#timer); this.#timer = null; const desligamento=this.#desligar();
    const anterior = this.#parada;
    this.#parada = (async () => {
      const resultados=await Promise.allSettled([anterior,desligamento,this.#fila,this.#filaGrupos].filter(Boolean));
      try{await this.#soltar();}catch(error){resultados.push({status:'rejected',reason:error});}
      this.#estado({ estado: 'desconectada', qr: null, qrGeradoEm: null, erro: null });
      const falha=resultados.find(r=>r.status==='rejected');
      if(falha)throw falha.reason;
    })();
    return this.#parada;
  }
  encerrar() {
    if(this.#encerramento)return this.#encerramento;
    this.#terminal=true;
    const inicio=this.#inicio;
    const parada=this.#pararAgora();
    const trabalhos=[...this.#trabalhos];
    this.#encerramento=(async()=>{
      const resultados=await Promise.allSettled([inicio,parada,...trabalhos].filter(Boolean));
      await Promise.allSettled([...this.#fechamentos]);
      // O início pode ter criado uma sessão depois da primeira soltura.
      await this.#soltar().catch(()=>{});
      const falhas=[...resultados.filter(r=>r.status==='rejected').map(r=>r.reason),...this.#falhasFechamento,...this.#falhasSoltura];
      if(falhas.length===1)throw falhas[0];
      if(falhas.length)throw new AggregateError(falhas,'Falha ao encerrar conexao WhatsApp');
    })();
    return this.#encerramento;
  }
}
