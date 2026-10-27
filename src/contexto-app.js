import { randomUUID, createHash } from 'node:crypto';
import { Ingestao } from './ingestao.js';
import { normalizar, classificarFromMe } from './transporte/whatsapp.js';
import { diaLocal, agoraIso } from './relogio.js';
import { prepararEsquemaPessoas } from './pessoas.js';
import { garantirEsquema, classificar, politicaDaConversa } from './permissao.js';
import {eventoExcluido,metadadosExcluidos} from './exclusoes.js';
import {entradaDeMensagemWhatsapp,invalidarOrigemComando,prepararComandosWhatsapp,processarComando} from './comandos-whatsapp.js';
import {agendarCicloFonte} from './ciclo-captura.js';
import {LEITURA_SQL,LEITURA_PESSOAL_SQL} from './leitura-sql.js';
import {nomeWhatsappValido,salvarNomesWhatsapp,criarNomeVisivel} from './nomes-conversa.js';

// Owner-only local context store. Does not assign customer projects or run workers.
// Raw messages remain available even while media understanding is unavailable.
export class ContextoApp {
  constructor(db) {
    this.db=db; this.ingestao=new Ingestao(db);
    // Preserva a assinatura original constructor(db) conforme a spec ("acrescentar, não alterar").
    // Suporta passagem opcional de opções como segundo argumento sem alterar a aridade formal (Achado 7).
    const opcoes = (arguments.length > 1 && arguments[1] && typeof arguments[1] === 'object') ? arguments[1] : {};
    this.donoId = opcoes.donoId || process.env.ASSESSOR_DONO || null;
    this.timeZone = opcoes.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    prepararEsquemaPessoas(db);
    garantirEsquema(db);
    prepararComandosWhatsapp(db);
    db.exec(`CREATE TABLE IF NOT EXISTS conversas_app (
      id TEXT PRIMARY KEY, nome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS falhas_ingestao (
        hash TEXT PRIMARY KEY, bruto TEXT NOT NULL, erro TEXT NOT NULL, recebido_em TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grupos_app (
        id TEXT PRIMARY KEY, nome TEXT NOT NULL, descricao TEXT, dono_id TEXT, criado_em TEXT,
        tamanho INTEGER DEFAULT 0, restrito INTEGER DEFAULT 0, anuncio INTEGER DEFAULT 0, atualizado_em TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grupo_participantes (
        grupo_id TEXT NOT NULL REFERENCES grupos_app(id) ON DELETE CASCADE,
        participante_id TEXT NOT NULL, papel TEXT NOT NULL CHECK (papel IN ('admin','superadmin','membro')),
        atualizado_em TEXT NOT NULL, PRIMARY KEY (grupo_id, participante_id));
      CREATE INDEX IF NOT EXISTS idx_grupo_participantes_user ON grupo_participantes(participante_id);
      CREATE INDEX IF NOT EXISTS idx_eventos_data ON eventos(recebido_em,id);
      CREATE INDEX IF NOT EXISTS idx_contexto_leitura ON eventos(conversa_id,recebido_em,id,texto);
      CREATE INDEX IF NOT EXISTS idx_contexto_metricas ON eventos(dia_local,tipo,conversa_id,recebido_em);`);
  }

  // Grava o evento atomicamente com a coluna permissão no próprio INSERT (Achado 6).
  // Elimina a janela de corrida onde o evento ficaria com permissao = NULL se o processo caísse entre INSERT e UPDATE.
  _registrarEvento(evento, permissao) {
    const {
      conversaId,
      origemId,
      direcao = 'entrada',
      autorId = null,
      autorEDono = false,
      doProprioBot = false,
      tipo = 'desconhecido',
      bruto,
      texto = null,
      recebidoEm = new Date()
    } = evento;

    if (!conversaId) throw new Error('evento sem conversaId');
    if (!origemId) throw new Error('evento sem origemId');
    if(eventoExcluido(this.db,conversaId,origemId))return {id:null,novo:false,excluido:true};

    const existente = this.db
      .prepare('SELECT id,permissao,texto,autor_id,tipo,recebido_em FROM eventos WHERE conversa_id = ? AND origem_id = ?')
      .get(conversaId, origemId);
    if (existente) {
      // Chegada real pelo transporte é uma origem nativa independente do pacote.
      // Não deixar uma importação anterior apagar depois uma mensagem capturada aqui.
      if(existente.permissao==='compartilhado') {
        const iso=agoraIso(recebidoEm);
        if(existente.texto!==texto||existente.autor_id!==autorId||existente.tipo!==tipo||existente.recebido_em!==iso){
          this.db.prepare('DELETE FROM f10_procedencias WHERE evento_id=?').run(existente.id);
          this.db.prepare('UPDATE eventos SET origem_compartilhamento=NULL WHERE id=?').run(existente.id);
        }
        this.db.prepare(`UPDATE eventos SET direcao=?,autor_id=?,autor_e_dono=?,do_proprio_bot=?,tipo=?,bruto=?,texto=?,recebido_em=?,dia_local=?,permissao=? WHERE id=?`)
          .run(direcao,autorId,autorEDono?1:0,doProprioBot?1:0,tipo,typeof bruto==='string'?bruto:JSON.stringify(bruto??{}),texto,iso,diaLocal(recebidoEm),permissao,existente.id);
      }
      return { id: Number(existente.id), novo: false };
    }

    const iso = agoraIso(recebidoEm);
    const info = this.db
      .prepare(
        `INSERT INTO eventos
           (conversa_id, origem_id, direcao, autor_id, autor_e_dono, do_proprio_bot, projeto_id,
            tipo, bruto, texto, recebido_em, dia_local, permissao)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        conversaId,
        origemId,
        direcao,
        autorId,
        autorEDono ? 1 : 0,
        doProprioBot ? 1 : 0,
        null,
        tipo,
        typeof bruto === 'string' ? bruto : JSON.stringify(bruto ?? {}),
        texto,
        iso,
        diaLocal(recebidoEm),
        permissao
      );

    return { id: Number(info.lastInsertRowid), novo: true };
  }

  receber(lote) {
    if(!Array.isArray(lote.messages)) throw new Error('Lote sem mensagens');
    let novas=0, ignoradas=0, falhas=0;const comandos=[];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const original of lote.messages) {
        if(!original?.key?.id || !original?.key?.remoteJid || !original.message || original.key.remoteJid==='status@broadcast') {ignoradas++;continue;}
        const bruto=JSON.stringify({tipoLote:lote.type,mensagem:original},(_,v)=>typeof v==='bigint'?v.toString():v);
        this.db.exec('SAVEPOINT mensagem');
        try {
        let message=original.message;
        for(let n=0;n<8;n++) {
          const inner=message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message.viewOnceMessageV2?.message ?? message.documentWithCaptionMessage?.message;
          if(!inner) break; message=inner;
        }
        const donosLote=Array.isArray(lote.donoJids)?lote.donoJids.filter(id=>typeof id==='string'&&id.includes('@')):[];
        const donoConfigurado=typeof this.donoId==='string'&&this.donoId.includes('@')?this.donoId:null;
        const donoJid=donosLote.includes(original.key.remoteJid)?original.key.remoteJid:(donosLote[0]||donoConfigurado);
        const evento=normalizar({...original,message},{tipoLote:lote.type,donoJid});
        if(original.key.fromMe)evento.doProprioBot=classificarFromMe(this.db,original).doProprioBot;
        evento.bruto=bruto;
        const permissao = classificar(evento, {
          donoId: this.donoId,
          politica: politicaDaConversa(this.db, evento.conversaId)
        });
        const r = this._registrarEvento(evento, permissao);
        if(r.excluido){this.db.exec('RELEASE mensagem');ignoradas++;continue;}
        if(!this.db.prepare("SELECT 1 FROM etapas WHERE evento_id=? AND etapa='captura'").get(r.id)){
          const atual=this.db.prepare('SELECT tipo,recebido_em FROM eventos WHERE id=?').get(r.id);
          agendarCicloFonte(this.db,{id:r.id,tipo:atual.tipo,recebidoEm:atual.recebido_em});
        }
        // Sender names in groups are not group names; own pushName is not the peer.
        const nome=!evento.conversaId.endsWith('@g.us') && !original.key.fromMe && nomeWhatsappValido(original.pushName,evento.conversaId) ? original.pushName.trim() : null;
        // ...mas o nome do REMETENTE vale em qualquer conversa, e era jogado fora em
        // grupo -- que e onde esta quase todo mundo. Medido em 12/09: 3.394 autores no
        // banco, 193 com nome. Identidade de pessoa e coisa diferente de nome de
        // conversa, entao mora em `pessoas`, nao em `conversas_app`.
        if(!original.key.fromMe && nomeWhatsappValido(original.pushName,evento.autorId) && evento.autorId){
          try{
            salvarNomesWhatsapp(this.db,{messages:[original]},{quando:evento.recebidoEm instanceof Date?evento.recebidoEm.toISOString():evento.recebidoEm});
          }catch{ /* nome e enfeite; nunca pode derrubar a ingestao da mensagem */ }
        }
        const nomeResolvido=nome?criarNomeVisivel(this.db)(nome,evento.conversaId):null;
        this.db.prepare(`INSERT INTO conversas_app(id,nome) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET nome=CASE WHEN ? IS NOT NULL THEN excluded.nome ELSE conversas_app.nome END`).run(evento.conversaId,nomeResolvido||evento.conversaId,nomeResolvido||null);
        if(original.key.fromMe&&evento.autorEDono&&permissao==='minha'&&!evento.doProprioBot)comandos.push({original,eventoId:r.id,bruto});
        this.db.exec('RELEASE mensagem');if(r.novo)novas++;
        }catch(error){
          this.db.exec('ROLLBACK TO mensagem; RELEASE mensagem');
          this.db.prepare('INSERT OR IGNORE INTO falhas_ingestao(hash,bruto,erro,recebido_em) VALUES(?,?,?,?)').run(createHash('sha256').update(bruto).digest('hex'),bruto,String(error.message),new Date().toISOString());falhas++;
        }
      }
      // Primeiro persiste o lote inteiro; assim uma resposta pode apontar para uma
      // mensagem que veio depois no mesmo history/upsert. O parser recebe somente
      // mensagens comprovadamente enviadas pelo dono.
      for(const item of comandos){
        try{
          const entrada=entradaDeMensagemWhatsapp(item.original,{
            timeZone:this.timeZone,
            doProprioBot:false,
            origemRemovida:(conversaId,origemId)=>eventoExcluido(this.db,conversaId,origemId)||!this.db.prepare('SELECT 1 FROM eventos WHERE conversa_id=? AND origem_id=?').get(conversaId,origemId)
          });
          entrada.eventoId=item.eventoId;
          processarComando(this.db,entrada,{timeZone:this.timeZone,transacaoExistente:true,esquemaPreparado:true});
        }catch(error){
          this.db.prepare('INSERT OR IGNORE INTO falhas_ingestao(hash,bruto,erro,recebido_em) VALUES(?,?,?,?)').run(createHash('sha256').update('comando:'+item.bruto).digest('hex'),item.bruto,`Comando: ${String(error.message)}`,new Date().toISOString());falhas++;
        }
      }
      this.db.exec('COMMIT'); return {novas,ignoradas,falhas};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  atualizarMensagens(updates) {
    if (!Array.isArray(updates)) throw new TypeError('Atualizacoes de mensagens invalidas');
    let afetados=0,ignorados=0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of updates) {
        const conversaId=typeof item?.key?.remoteJid==='string'?item.key.remoteJid:'';
        const origemId=typeof item?.key?.id==='string'?item.key.id:'';
        if(!conversaId||!origemId||!item?.update?.message){ignorados++;continue;}
        afetados+=invalidarOrigemComando(this.db,{conversaId,origemId,transacaoExistente:true,esquemaPreparado:true}).afetados;
      }
      this.db.exec('COMMIT');
      return {afetados,ignorados,falhas:0};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  removerMensagens(evento) {
    const alvos=new Map();let ignorados=0;
    let afetados=0;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(evento?.all===true&&typeof evento.jid==='string'&&evento.jid){
        for(const linha of this.db.prepare('SELECT DISTINCT conversa_id,origem_id FROM lume_comandos WHERE conversa_id=?').all(evento.jid)){
          alvos.set(`${linha.conversa_id}\u0000${linha.origem_id}`,{conversaId:linha.conversa_id,origemId:linha.origem_id});
        }
      }else if(Array.isArray(evento?.keys)){
        for(const key of evento.keys){
          const conversaId=typeof key?.remoteJid==='string'?key.remoteJid:'';
          const origemId=typeof key?.id==='string'?key.id:'';
          if(!conversaId||!origemId){ignorados++;continue;}
          alvos.set(`${conversaId}\u0000${origemId}`,{conversaId,origemId});
        }
      }else ignorados++;
      for(const alvo of alvos.values()) afetados+=invalidarOrigemComando(this.db,{...alvo,removida:true,transacaoExistente:true,esquemaPreparado:true}).afetados;
      this.db.exec('COMMIT');return {afetados,ignorados,falhas:0};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  nota({texto,titulo='Nota interna',fontes=[]}) {
    if(typeof texto!=='string'||!texto.trim()||texto.length>100000) throw new Error('Escreva um contexto de até 100 mil caracteres');
    if(typeof titulo!=='string'||titulo.length>200) throw new Error('Título deve ter até 200 caracteres');
    if(!Array.isArray(fontes)||fontes.length>100||fontes.some(id=>!Number.isSafeInteger(id)||id<1))throw new Error('Fontes da nota inválidas.');
    const id='nota:'+randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const fontePermitida=this.db.prepare(`SELECT 1 FROM eventos e WHERE e.id=? AND ${LEITURA_SQL}`);
      for(const fonte of new Set(fontes))if(!fontePermitida.get(fonte))throw new Error('Fonte da nota indisponível.');
      // Notas criadas pelo dono no painel nascem diretamente com permissao='minha' no INSERT
      const r = this._registrarEvento({
        conversaId: id,
        origemId: id,
        tipo: 'nota',
        texto: texto.trim(),
        bruto: { fonte: 'painel', titulo: titulo.trim() },
        autorEDono: true
      }, 'minha');
      this.db.prepare('INSERT INTO conversas_app(id,nome) VALUES(?,?)').run(id,titulo.trim()||'Nota interna');
      for(const fonte of new Set(fontes))this.db.prepare('INSERT INTO priv_vinculos VALUES(?,?)').run(fonte,r.id);
      this.db.exec('COMMIT');return r;
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  conversas(q='') {
    const leituraX=LEITURA_PESSOAL_SQL.replace(/\be\./gu,'x.'),leituraS=LEITURA_PESSOAL_SQL.replace(/\be\./gu,'s.');
    return this.db.prepare(`SELECT c.id,c.nome,COUNT(e.id) AS total,MAX(e.recebido_em) AS ultimaMensagemEm,
      (SELECT x.texto FROM eventos x WHERE x.conversa_id=c.id AND ${leituraX} ORDER BY x.recebido_em DESC,x.id DESC LIMIT 1) AS ultimoTexto
      FROM conversas_app c LEFT JOIN eventos e ON e.conversa_id=c.id AND ${LEITURA_PESSOAL_SQL}
      WHERE (instr(lower(c.nome),lower(?))>0 OR instr(lower(c.id),lower(?))>0 OR EXISTS
        (SELECT 1 FROM eventos s WHERE s.conversa_id=c.id AND ${leituraS} AND instr(lower(COALESCE(s.texto,'')),lower(?))>0))
        AND (e.id IS NOT NULL OR EXISTS(SELECT 1 FROM grupos_app g WHERE g.id=c.id))
      GROUP BY c.id ORDER BY ultimaMensagemEm DESC LIMIT 200`).all(q,q,q);
  }
  mensagens(conversaId,{q='',antes=Number.MAX_SAFE_INTEGER}={}) {
    const cursor=antes===Number.MAX_SAFE_INTEGER?null:this.db.prepare(`SELECT e.recebido_em,e.id FROM eventos e WHERE e.id=? AND e.conversa_id=? AND ${LEITURA_PESSOAL_SQL}`).get(antes,conversaId);
    if(antes!==Number.MAX_SAFE_INTEGER&&!cursor)return {mensagens:[],proximoAntes:null};
    const linhas=this.db.prepare(`SELECT e.id,e.conversa_id,e.tipo,e.texto,e.direcao,e.recebido_em,e.autor_id FROM eventos e
      WHERE e.conversa_id=? AND ${LEITURA_PESSOAL_SQL} AND (e.recebido_em<? OR (e.recebido_em=? AND e.id<?)) AND instr(lower(COALESCE(e.texto,'')),lower(?))>0 ORDER BY e.recebido_em DESC,e.id DESC LIMIT 51`).all(conversaId,cursor?.recebido_em||'9999',cursor?.recebido_em||'9999',cursor?.id||Number.MAX_SAFE_INTEGER,q);
    const mais=linhas.length>50; const mensagens=linhas.slice(0,50);
    return {mensagens:mensagens.reverse(),proximoAntes:mais?mensagens[0].id:null};
  }
  estado() {
    return this.db.prepare(`SELECT COUNT(*) total,COUNT(DISTINCT conversa_id) conversas,
      COALESCE(SUM(dia_local=?),0) hoje,COALESCE(SUM(tipo='nota'),0) notas,MAX(recebido_em) ultimaMensagemEm FROM eventos WHERE tipo<>'notetaker_trecho'`).get(diaLocal(new Date()));
  }
  pendencias() {
    return this.db.prepare(`SELECT COALESCE(SUM(tipo='audio' AND texto IS NULL),0) audio,
      COALESCE(SUM(tipo IN ('imagem','documento','video')),0) midia,
      (SELECT COUNT(*) FROM falhas_ingestao) ingestao FROM eventos WHERE tipo<>'notetaker_trecho'`).get();
  }
  salvarGrupos(grupos) {
    const lista = Array.isArray(grupos) ? grupos : Object.values(grupos || {});
    if (!lista.length) return { atualizados: 0 };
    const agora = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insGrupo = this.db.prepare(`INSERT INTO grupos_app(id,nome,descricao,dono_id,criado_em,tamanho,restrito,anuncio,atualizado_em)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        nome=excluded.nome, descricao=excluded.descricao, dono_id=excluded.dono_id,
        tamanho=excluded.tamanho, restrito=excluded.restrito, anuncio=excluded.anuncio, atualizado_em=excluded.atualizado_em`);
      const insConversa = this.db.prepare(`INSERT INTO conversas_app(id,nome) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET nome=excluded.nome`);
      const delParticipantes = this.db.prepare(`DELETE FROM grupo_participantes WHERE grupo_id=?`);
      const insParticipante = this.db.prepare(`INSERT INTO grupo_participantes(grupo_id,participante_id,papel,atualizado_em)
        VALUES(?,?,?,?) ON CONFLICT(grupo_id,participante_id) DO UPDATE SET papel=excluded.papel, atualizado_em=excluded.atualizado_em`);
      let atualizados = 0;
      for (const g of lista) {
        if (!g?.id) continue;
        if(metadadosExcluidos(this.db,g.id))continue;
        const anterior=this.db.prepare('SELECT * FROM grupos_app WHERE id=?').get(g.id);
        const nome=nomeWhatsappValido(g.subject,g.id)?g.subject.trim():anterior?.nome||this.db.prepare('SELECT nome FROM conversas_app WHERE id=?').get(g.id)?.nome;
        if(!nome)continue;
        const dono = g.owner ?? g.subjectOwner ?? anterior?.dono_id ?? null;
        const criadoEm = g.creation ? new Date(g.creation * 1000).toISOString() : anterior?.criado_em??null;
        const tamanho = Array.isArray(g.participants) ? g.participants.length : (g.size ?? anterior?.tamanho ?? 0);
        insGrupo.run(g.id, nome, g.desc ?? anterior?.descricao ?? null, dono, criadoEm, tamanho,
          g.restrict===undefined?anterior?.restrito??0:Number(Boolean(g.restrict)),
          g.announce===undefined?anterior?.anuncio??0:Number(Boolean(g.announce)), agora);
        insConversa.run(g.id, nome);
        if (Array.isArray(g.participants)) {
          delParticipantes.run(g.id);
          for (const p of g.participants) {
            const papel = p.admin === 'superadmin' ? 'superadmin' : (p.admin === 'admin' ? 'admin' : 'membro');
            insParticipante.run(g.id, p.id, papel, agora);
          }
        }
        atualizados++;
      }
      this.db.exec('COMMIT');
      return { atualizados };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  grupos(q = '') {
    return this.db.prepare(`SELECT g.id, g.nome, g.descricao, g.dono_id, g.criado_em, g.tamanho, g.restrito, g.anuncio, g.atualizado_em,
      (SELECT COUNT(1) FROM eventos e WHERE e.conversa_id=g.id) AS totalMensagens,
      (SELECT json_group_array(json_object('id', p.participante_id, 'papel', p.papel))
       FROM grupo_participantes p WHERE p.grupo_id=g.id AND p.papel IN ('admin','superadmin')) AS admins
      FROM grupos_app g
      WHERE instr(lower(g.nome), lower(?))>0 OR instr(lower(COALESCE(g.descricao, '')), lower(?))>0
      ORDER BY totalMensagens DESC`).all(q, q).map(r => ({ ...r, admins: JSON.parse(r.admins || '[]') }));
  }
  grupo(id) {
    const g = this.db.prepare('SELECT * FROM grupos_app WHERE id=?').get(id);
    if (!g) return null;
    const participantes = this.db.prepare(`SELECT participante_id AS id, papel, atualizado_em FROM grupo_participantes
      WHERE grupo_id=? ORDER BY CASE papel WHEN 'superadmin' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, participante_id ASC`).all(id);
    return { ...g, participantes };
  }
}
