import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// Clé dérivée de ENCRYPTION_KEY : n'importe quelle chaîne longue convient (ex. `openssl rand -hex 32`).
const key = () => {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || k.length < 32) throw new Error('ENCRYPTION_KEY doit être défini (32 caractères minimum) pour enregistrer les comptes connectés.');
  return createHash('sha256').update(k).digest();
};

/** Chiffre un jeton avant de l'enregistrer : iv.tag.contenu, en base64url. */
export function chiffrer(texte: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(texte, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function dechiffrer(valeur: string): string {
  const [iv, tag, data] = valeur.split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
