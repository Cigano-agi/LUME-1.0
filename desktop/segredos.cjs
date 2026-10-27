const { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign } = require('node:crypto');

// Segredos de nomes fixos. Nenhum caminho fornecido pelo renderer/worker é usado.
function criarCofre(diretorio, safeStorage) {
  const arquivo = join(diretorio, 'gemini.seguro');
  const openrouter = join(diretorio, 'openrouter.seguro');
  const telegram = join(diretorio, 'telegram.seguro');
  const pessoal = Object.freeze({chatgpt:join(diretorio,'lume-chatgpt.seguro'),github:join(diretorio,'lume-github.seguro'),clickup:join(diretorio,'lume-clickup.seguro')});
  const assinatura = join(diretorio, 'compartilhamento.seguro');
  const disponivel = () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text');
  return {
    estado() { return { disponivel: disponivel(), configurada: existsSync(arquivo) }; },
    executar(operacao, valor) {
      const nova = /^(chatgpt|github|clickup)-(estado|ler|gravar|remover)$/.exec(operacao);
      if (nova) {
        const target=pessoal[nova[1]],action=nova[2];
        if(action==='estado')return {disponivel:disponivel(),configurada:existsSync(target)};
        if(action==='remover'){if(existsSync(target))unlinkSync(target);return {ok:true};}
        if(!disponivel())throw new Error('Proteção de credenciais do sistema indisponível.');
        if(action==='ler'){if(!existsSync(target))throw new Error('Conexão pessoal ainda não configurada.');return safeStorage.decryptString(readFileSync(target));}
        if(typeof valor!=='string'||!valor||valor.length>(nova[1]==='chatgpt'?1048576:2048))throw new Error('Credencial inválida.');
        if(nova[1]==='chatgpt'){
          let data;try{data=JSON.parse(valor);}catch{throw new Error('Registro ChatGPT inválido.');}
          if(data?.version!==1||!Array.isArray(data.accounts)||data.accounts.length>16)throw new Error('Registro ChatGPT inválido.');
        }else if(/[\r\n\s]/.test(valor))throw new Error('Credencial inválida.');
        mkdirSync(diretorio,{recursive:true});writeFileSync(target+'.tmp',safeStorage.encryptString(valor),{mode:0o600});renameSync(target+'.tmp',target);return {ok:true};
      }
      if (operacao === 'telegram-estado') return { disponivel: disponivel(), configurada: existsSync(telegram) };
      if (operacao === 'telegram-remover') { if (existsSync(telegram)) unlinkSync(telegram); return { ok: true }; }
      if (['telegram-ler','telegram-gravar'].includes(operacao)) {
        if (!disponivel()) throw new Error('Proteção de credenciais do sistema indisponível.');
        if (operacao === 'telegram-ler') {
          if (!existsSync(telegram)) throw new Error('Configure o bot do Telegram.');
          return safeStorage.decryptString(readFileSync(telegram));
        }
        if (typeof valor !== 'string' || !/^\d{6,12}:[A-Za-z0-9_-]{30,100}$/.test(valor)) throw new Error('Token do Telegram inválido.');
        mkdirSync(diretorio, { recursive: true });
        writeFileSync(telegram + '.tmp', safeStorage.encryptString(valor), { mode: 0o600 });
        renameSync(telegram + '.tmp', telegram);
        return { ok: true };
      }
      if (operacao === 'openrouter-estado') return { disponivel: disponivel(), configurada: existsSync(openrouter) };
      if (operacao === 'openrouter-remover') { if (existsSync(openrouter)) unlinkSync(openrouter); return { ok: true }; }
      if (['openrouter-ler','openrouter-gravar'].includes(operacao)) {
        if (!disponivel()) throw new Error('Proteção de credenciais do sistema indisponível.');
        if (operacao === 'openrouter-ler') {
          if (!existsSync(openrouter)) throw new Error('Configure sua chave OpenRouter.');
          return safeStorage.decryptString(readFileSync(openrouter));
        }
        if (typeof valor !== 'string' || !/^sk-or-v1-[a-f0-9]{64}$/.test(valor)) throw new Error('Formato de chave OpenRouter inválido.');
        mkdirSync(diretorio, { recursive: true });
        writeFileSync(openrouter + '.tmp', safeStorage.encryptString(valor), { mode: 0o600 });
        renameSync(openrouter + '.tmp', openrouter);
        return { ok: true };
      }
      if (operacao === 'estado') return this.estado();
      if (operacao === 'remover') { if (existsSync(arquivo)) unlinkSync(arquivo); return { ok: true }; }
      if (operacao === 'f10-estado' && !existsSync(assinatura)) return { disponivel: disponivel(), criada: false };
      if (!disponivel()) throw new Error('Proteção de credenciais do sistema indisponível.');
      if (['f10-estado','f10-criar','f10-assinar'].includes(operacao)) {
        if(!existsSync(assinatura)) {
          if(operacao!=='f10-criar') throw new Error('Crie sua identidade de compartilhamento primeiro.');
          const keys=generateKeyPairSync('ed25519');
          mkdirSync(diretorio,{recursive:true});
          writeFileSync(assinatura+'.tmp',safeStorage.encryptString(keys.privateKey.export({type:'pkcs8',format:'pem'})),{mode:0o600});
          renameSync(assinatura+'.tmp',assinatura);
        }
        const key=createPrivateKey(safeStorage.decryptString(readFileSync(assinatura))),publica=createPublicKey(key);
        const chave_publica=publica.export({type:'spki',format:'pem'});
        const fingerprint=createHash('sha256').update(publica.export({type:'spki',format:'der'})).digest('hex');
        if(operacao==='f10-assinar') {
          if(typeof valor!=='string'||Buffer.byteLength(valor)>8*1024*1024||!['assessor-f10-v1','assessor-f10-v2'].includes(JSON.parse(valor)?.versao))throw new Error('Conteúdo de assinatura inválido.');
          return {chave_publica,assinatura:sign(null,Buffer.from(valor),key).toString('base64')};
        }
        return {disponivel:true,criada:true,chave_publica,fingerprint};
      }
      if (operacao === 'ler') {
        if (!existsSync(arquivo)) throw new Error('Configure sua chave Gemini.');
        return safeStorage.decryptString(readFileSync(arquivo));
      }
      if (operacao === 'gravar') {
        if (typeof valor !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(valor)) throw new Error('Formato de chave inválido.');
        mkdirSync(diretorio, { recursive: true });
        writeFileSync(arquivo + '.tmp', safeStorage.encryptString(valor), { mode: 0o600 });
        renameSync(arquivo + '.tmp', arquivo);
        return { ok: true };
      }
      throw new Error('Operação de credencial inválida.');
    }
  };
}
module.exports = { criarCofre };
