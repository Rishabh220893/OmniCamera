/**
 * Seals camera logins before they are stored (docs/adapters.md, "Onboarding"). AES-256-GCM with a key from the environment
 * (`SOURCE_SECRET_KEY`: 32 random bytes as 64 hex characters or base64). Without the key nothing secret is ever stored: a camera
 * that needs a login cannot be onboarded, and one that needs none still can.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The version tag lets the format change later.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretBox {
  seal(plain: string): string;
  /** Returns the plain text, or throws when the value was not sealed with this key (or was altered). */
  open(sealed: string): string;
}

export class SecretKeyError extends Error { constructor(message: string) { super(message); this.name = 'SecretKeyError'; } }

/** A key given as 64 hex characters or as base64 (of 32 bytes). */
export function parseSecretKey(raw: string): Buffer {
  const t = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (key.length !== 32) throw new SecretKeyError('SOURCE_SECRET_KEY must be 32 random bytes, as 64 hex characters or as base64. Make one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  return key;
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new SecretKeyError('The key must be 32 bytes.');
  const b64 = (b: Buffer) => b.toString('base64url');
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return `v1.${b64(iv)}.${b64(c.getAuthTag())}.${b64(ct)}`;
    },
    open(sealed) {
      const [v, iv, tag, ct] = sealed.split('.');
      if (v !== 'v1' || !iv || !tag || ct === undefined) throw new SecretKeyError('Not a sealed value.');
      try {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        d.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
      } catch { throw new SecretKeyError('The stored login cannot be read with this SOURCE_SECRET_KEY (wrong key, or the value was changed).'); }
    },
  };
}

/** The box for this server, or null when no key is set. A key that is set but malformed is an error, not a silent "no key". */
export function secretBoxFromEnv(env: Record<string, string | undefined>): SecretBox | null {
  const raw = env.SOURCE_SECRET_KEY;
  return raw && raw.trim() ? createSecretBox(parseSecretKey(raw)) : null;
}
