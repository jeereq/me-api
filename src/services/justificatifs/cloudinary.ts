import { createHash } from 'crypto';

import { DELAI_FICHIER_MS, delai, estDelai } from '../../utils/delai.js';

/**
 * Stockage des justificatifs chez Cloudinary, sans SDK : deux appels REST signés (dépôt, suppression).
 * La clé secrète reste sur le serveur ; l'app n'envoie que le fichier à me-api.
 */
export type ConfigCloudinary = { cloud: string; cle: string; secret: string };

/**
 * `CLOUDINARY_URL=cloudinary://<clé>:<secret>@<cloud>` (celle du tableau de bord Cloudinary),
 * ou les trois variables séparées. Null tant que rien n'est configuré.
 */
export function configCloudinary(env: NodeJS.ProcessEnv = process.env): ConfigCloudinary | null {
  const url = env.CLOUDINARY_URL?.trim();
  if (url) {
    const m = /^cloudinary:\/\/([^:]+):([^@]+)@([^/?#]+)/.exec(url);
    if (m) return { cle: decodeURIComponent(m[1]), secret: decodeURIComponent(m[2]), cloud: m[3] };
  }
  const cloud = env.CLOUDINARY_CLOUD_NAME?.trim();
  const cle = env.CLOUDINARY_API_KEY?.trim();
  const secret = env.CLOUDINARY_API_SECRET?.trim();
  return cloud && cle && secret ? { cloud, cle, secret } : null;
}

/** Signature Cloudinary : paramètres triés « a=1&b=2 », suivis du secret, en SHA-1. */
export function signer(params: Record<string, string | number>, secret: string) {
  const chaine = Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(chaine + secret).digest('hex');
}

/** Images et PDF passent en « image » : Cloudinary sait alors faire la vignette de la première page d'un PDF. */
export type GenreRessource = 'image' | 'raw';

/** « authenticated » : le fichier n'est servi qu'avec une adresse signée par le serveur. « upload » : public, ancien dépôt. */
export type AccesRessource = 'authenticated' | 'upload';

/**
 * L'adresse d'un fichier chez Cloudinary. Privé : signée avec le secret (8 caractères de SHA-1 sur la transformation
 * et le fichier, la version n'en fait pas partie). Elle reste côté serveur : l'app passe par `/justificatifs/ouvrir`.
 */
export function urlLivraison(c: ConfigCloudinary, f: { publicId: string; genre?: GenreRessource; acces: AccesRessource; transformation?: string; format?: string | null }) {
  const fichier = `${f.publicId}${f.format ? `.${f.format}` : ''}`;
  const signature = f.acces === 'authenticated' ? `s--${createHash('sha1').update(`${f.transformation ? `${f.transformation}/` : ''}${fichier}${c.secret}`).digest('base64url').slice(0, 8)}--/` : '';
  return `https://res.cloudinary.com/${encodeURIComponent(c.cloud)}/${f.genre ?? 'image'}/${f.acces}/${signature}${f.transformation ? `${f.transformation}/` : ''}v1/${fichier.split('/').map(encodeURIComponent).join('/')}`;
}

/** Le téléchargement signé et limité dans le temps de l'API Cloudinary : le recours pour un PDF que le CDN refuse de livrer. */
export function urlTelechargement(c: ConfigCloudinary, f: { publicId: string; genre?: GenreRessource; acces: AccesRessource; format: string }, maintenant = Date.now()) {
  const timestamp = Math.floor(maintenant / 1000);
  const champs = { expires_at: timestamp + 300, format: f.format, public_id: f.publicId, timestamp, type: f.acces };
  const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(champs).map(([k, v]) => [k, String(v)])), api_key: c.cle, signature: signer(champs, c.secret) });
  return `https://api.cloudinary.com/v1_1/${encodeURIComponent(c.cloud)}/${f.genre ?? 'image'}/download?${q}`;
}

export type Depot = { publicId: string; url: string; genre: GenreRessource; format: string; octets: number; pages?: number; largeur?: number; hauteur?: number };

async function appeler(c: ConfigCloudinary, chemin: string, champs: Record<string, string | number>, fichier?: { contenu: Blob; nom: string }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signes = { ...champs, timestamp };
  const form = new FormData();
  for (const [k, v] of Object.entries(signes)) form.append(k, String(v));
  form.append('api_key', c.cle);
  form.append('signature', signer(signes, c.secret));
  if (fichier) form.append('file', fichier.contenu, fichier.nom);
  // Le signal couvre l'envoi du fichier et la lecture de la réponse ; un service qui ne répond plus ne garde pas la requête ouverte.
  const signal = delai(DELAI_FICHIER_MS);
  let res: Response;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(c.cloud)}/${chemin}`, { method: 'POST', body: form, signal });
  } catch (e) {
    throw new Error(estDelai(e) ? 'Cloudinary met trop de temps à répondre.' : 'Cloudinary est injoignable.');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Cloudinary ${res.status} : ${data.error?.message ?? 'réponse illisible'}`);
  return data;
}

export const Cloudinary = {
  async deposer(c: ConfigCloudinary, fichier: { contenu: Blob; nom: string }, dossier: string, genre: GenreRessource, acces: AccesRessource = 'authenticated'): Promise<Depot> {
    const d = await appeler(c, `${genre}/upload`, { folder: dossier, type: acces }, fichier);
    return {
      publicId: String(d.public_id),
      url: String(d.secure_url),
      genre: d.resource_type === 'raw' ? 'raw' : 'image',
      format: String(d.format ?? ''),
      octets: Number(d.bytes ?? 0),
      ...(typeof d.pages === 'number' ? { pages: d.pages } : {}),
      ...(typeof d.width === 'number' ? { largeur: d.width } : {}),
      ...(typeof d.height === 'number' ? { hauteur: d.height } : {}),
    };
  },

  /** Supprime le fichier et vide le cache du CDN. Un fichier déjà absent compte comme supprimé. */
  async supprimer(c: ConfigCloudinary, publicId: string, genre: GenreRessource, acces: AccesRessource = 'upload') {
    const d = await appeler(c, `${genre}/destroy`, { public_id: publicId, invalidate: 'true', type: acces });
    if (d.result !== 'ok' && d.result !== 'not found') throw new Error(`Cloudinary : suppression refusée (${String(d.result)})`);
  },

  /** Rend privé un ancien dépôt public et vide le cache du CDN : l'ancienne adresse ne répond plus. */
  async rendrePrive(c: ConfigCloudinary, publicId: string, genre: GenreRessource) {
    await appeler(c, `${genre}/rename`, { from_public_id: publicId, to_public_id: publicId, to_type: 'authenticated', type: 'upload', invalidate: 'true' });
  },
};
