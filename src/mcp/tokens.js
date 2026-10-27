import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { McpError } from './errors.js';

const b64 = value => Buffer.from(value).toString('base64url');
const unb64 = value => Buffer.from(value, 'base64url');

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

export class McpTokens {
  constructor(secret = randomBytes(32), { agora = () => Date.now() } = {}) {
    this.key = createHash('sha256').update(secret).digest();
    this.agora = agora;
  }
  criar(prefixo, payload, ttlMs) {
    const body = ttlMs == null ? payload : { ...payload, exp: this.agora() + ttlMs };
    const plain = Buffer.from(JSON.stringify(body));
    // IDs de fonte precisam ser estáveis para deduplicação e desempate. O nonce
    // determinístico só é usado quando o mesmo payload produz exatamente o mesmo
    // texto cifrado; cursores, que carregam validade temporal, continuam aleatórios.
    const iv = ttlMs == null ? createHmac('sha256', this.key).update(prefixo).update(plain).digest().subarray(0, 12) : randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return `${prefixo}_${b64(Buffer.concat([iv, cipher.getAuthTag(), encrypted]))}`;
  }
  abrir(token, prefixo, codigo = 'INVALID_CURSOR') {
    try {
      if (typeof token !== 'string' || !token.startsWith(prefixo + '_')) throw new Error();
      const bytes = unb64(token.slice(prefixo.length + 1));
      if (bytes.length < 29) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
      if (payload.exp !== undefined && (!Number.isFinite(payload.exp) || payload.exp <= this.agora())) throw new Error();
      return payload;
    } catch {
      throw new McpError(codigo);
    }
  }
}
