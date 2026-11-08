import { createHash } from 'crypto';

import { DELAI_FICHIER_MS, delai, estDelai } from '../../utils/delai.js';

/**
 * Stockage des justificatifs chez Cloudinary, sans SDK : deux appels REST signés (dépôt, suppression).
 * La clé secrète reste sur le serveur ; l'app n'envoie que le fichier à me-api.
 */
/**
 * `preset` : envoi par un preset non signé (CLOUDINARY_UPLOAD_PRESET), sans clé ni secret. La clé et le secret, s'ils sont
 * là, ne servent alors qu'à supprimer les fichiers ; sans eux, les fichiers restent chez Cloudinary.
 */
export type ConfigCloudinary = { cloud: string; cle: string; secret: string; preset?: string };

/**
 * `CLOUDINARY_URL=cloudinary://<clé>:<secret>@<cloud>` (celle du tableau de bord Cloudinary),
 * ou les trois variables séparées. Null tant que rien n'est configuré.
 */
/** Une variable collée telle quelle : sans le nom devant (« CLOUDINARY_URL= »), sans guillemets ni espaces autour. */
const propre = (v: string | undefined, nom: string) =>
  (v ?? '')
    .trim()
    .replace(new RegExp(`^${nom}\\s*=\\s*`, 'i'), '')
    .replace(/^["'<]+|[">']+$/g, '')
    .trim();

export function configCloudinary(env: NodeJS.ProcessEnv = process.env): ConfigCloudinary | null {
  const url = propre(env.CLOUDINARY_URL, 'CLOUDINARY_URL');
  const m = url ? /^cloudinary:\/\/([^:\s]+):([^@\s]+)@([^/?#\s]+)/i.exec(url) : null;
  const preset = propre(env.CLOUDINARY_UPLOAD_PRESET, 'CLOUDINARY_UPLOAD_PRESET');
  // Le preset l'emporte : il ne demande que le nom du compte.
  if (preset) {
    const nom = propre(env.CLOUDINARY_CLOUD_NAME, 'CLOUDINARY_CLOUD_NAME') || m?.[3] || '';
    if (nom) return { cloud: nom, cle: m ? decodeURIComponent(m[1]) : propre(env.CLOUDINARY_API_KEY, 'CLOUDINARY_API_KEY'), secret: m ? decodeURIComponent(m[2]) : propre(env.CLOUDINARY_API_SECRET, 'CLOUDINARY_API_SECRET'), preset };
  }
  if (m) return { cle: decodeURIComponent(m[1]), secret: decodeURIComponent(m[2]), cloud: m[3] };
  const cloud = propre(env.CLOUDINARY_CLOUD_NAME, 'CLOUDINARY_CLOUD_NAME');
  const cle = propre(env.CLOUDINARY_API_KEY, 'CLOUDINARY_API_KEY');
  const secret = propre(env.CLOUDINARY_API_SECRET, 'CLOUDINARY_API_SECRET');
  return cloud && cle && secret ? { cloud, cle, secret } : null;
}

/** Signature Cloudinary : paramètres triés « a=1&b=2 », suivis du secret, en SHA-1. */
export function signer(params: Record<string, string | number>, secret: string, algo: 'sha1' | 'sha256' = 'sha1') {
  const chaine = Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash(algo).update(chaine + secret).digest('hex');
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

export type Depot = { publicId: string; url: string; genre: GenreRessource; acces: AccesRessource; format: string; octets: number; pages?: number; largeur?: number; hauteur?: number };

/** Une clé et un secret permettent les gestes signés (supprimer, adresse privée, téléchargement). */
export const peutSigner = (c: ConfigCloudinary) => !!c.cle && !!c.secret;

/** Un compte Cloudinary réglé pour signer en SHA-256 refuse les signatures SHA-1 : on réessaie alors une fois en SHA-256. */
async function appeler(c: ConfigCloudinary, chemin: string, champs: Record<string, string | number>, fichier?: { contenu: Blob; nom: string }) {
  try {
    return await appelerAvec(c, chemin, champs, fichier, 'sha1');
  } catch (e) {
    if (!(e instanceof ErreurCloudinary) || e.status !== 401 || !/signature/i.test(e.detail)) throw e;
    return appelerAvec(c, chemin, champs, fichier, 'sha256');
  }
}

async function appelerAvec(c: ConfigCloudinary, chemin: string, champs: Record<string, string | number>, fichier: { contenu: Blob; nom: string } | undefined, algo: 'sha1' | 'sha256') {
  const timestamp = Math.floor(Date.now() / 1000);
  const signes = { ...champs, timestamp };
  const form = new FormData();
  for (const [k, v] of Object.entries(signes)) form.append(k, String(v));
  form.append('api_key', c.cle);
  form.append('signature', signer(signes, c.secret, algo));
  if (algo === 'sha256') form.append('signature_algorithm', 'sha256');
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
  if (!res.ok) throw new ErreurCloudinary(res.status, data.error?.message ?? 'réponse illisible');
  return data;
}

/** Un dépôt par preset non signé : le nom du compte, le preset, le dossier et le fichier, rien d'autre. */
async function deposerParPreset(c: ConfigCloudinary, fichier: { contenu: Blob; nom: string }, dossier: string, genre: GenreRessource) {
  const form = new FormData();
  form.append('upload_preset', c.preset!);
  form.append('folder', dossier);
  form.append('file', fichier.contenu, fichier.nom);
  let res: Response;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(c.cloud)}/${genre}/upload`, { method: 'POST', body: form, signal: delai(DELAI_FICHIER_MS) });
  } catch (e) {
    throw new Error(estDelai(e) ? 'Cloudinary met trop de temps à répondre.' : 'Cloudinary est injoignable.');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new ErreurCloudinary(res.status, data.error?.message ?? 'réponse illisible');
  return data;
}

/** Une réponse d'erreur de Cloudinary : son code et son message, pour dire ce qui ne va pas. */
export class ErreurCloudinary extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(`Cloudinary ${status} : ${detail}`);
  }
}

/** Ce qui empêche l'envoi, en clair : ce que l'administrateur doit corriger, ou ce que l'utilisateur peut faire. */
export function raisonCloudinary(e: unknown, detaille = false): string {
  if (e instanceof ErreurCloudinary && detaille) return `${raisonCloudinary(e)} — réponse de Cloudinary : « ${e.detail.slice(0, 160)} »`;
  if (e instanceof ErreurCloudinary) {
    const d = e.detail.toLowerCase();
    if (/whitelisted for unsigned|unsigned upload/.test(d)) return 'le preset n’est pas en mode « Unsigned » (Cloudinary › Settings › Upload presets)';
    if (/upload preset not found|preset.*not found/.test(d)) return 'le preset est introuvable (CLOUDINARY_UPLOAD_PRESET à vérifier)';
    if (e.status === 401 || /api key|signature|api_secret|unknown api/.test(d)) return 'la clé Cloudinary du serveur est refusée (CLOUDINARY_URL à vérifier)';
    if (e.status === 404 || /cloud name|cloud_name|invalid cloud/.test(d)) return 'le nom du compte Cloudinary est inconnu (CLOUDINARY_URL à vérifier)';
    if (e.status === 420 || /rate limit|quota|exceeded|limit/.test(d)) return 'le compte Cloudinary a atteint sa limite (stockage ou envois du mois)';
    if (/file size|too large/.test(d)) return 'le fichier est trop lourd pour le compte Cloudinary';
    if (/invalid image|unsupported|invalid file/.test(d)) return 'Cloudinary ne sait pas lire ce fichier : essaie une photo JPEG ou un PDF';
    if (/disabled|blocked|suspended/.test(d)) return 'le compte Cloudinary est désactivé';
    return `Cloudinary a refusé le fichier (${e.status} : ${e.detail.slice(0, 120)})`;
  }
  return e instanceof Error && /injoignable|trop de temps/.test(e.message) ? e.message.replace(/\.$/, '') : 'Cloudinary ne répond pas';
}

export const Cloudinary = {
  /** Vérifie la clé sans rien déposer (API d'administration : /ping). */
  async verifier(c: ConfigCloudinary) {
    let res: Response;
    try {
      res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(c.cloud)}/ping`, { headers: { Authorization: `Basic ${Buffer.from(`${c.cle}:${c.secret}`).toString('base64')}` }, signal: delai(15_000) });
    } catch (e) {
      throw new Error(estDelai(e) ? 'Cloudinary met trop de temps à répondre.' : 'Cloudinary est injoignable.');
    }
    const data = (await res.json().catch(() => ({}))) as { status?: string; error?: { message?: string } };
    if (!res.ok) throw new ErreurCloudinary(res.status, data.error?.message ?? 'réponse illisible');
  },

  async deposer(c: ConfigCloudinary, fichier: { contenu: Blob; nom: string }, dossier: string, genre: GenreRessource, acces: AccesRessource = 'authenticated'): Promise<Depot> {
    // Preset non signé : le type de livraison vient du preset ; ni clé ni secret.
    const d = c.preset ? await deposerParPreset(c, fichier, dossier, genre) : await appeler(c, `${genre}/upload`, { folder: dossier, type: acces }, fichier);
    return {
      publicId: String(d.public_id),
      url: String(d.secure_url),
      genre: d.resource_type === 'raw' ? 'raw' : 'image',
      acces: d.type === 'authenticated' ? 'authenticated' : c.preset ? 'upload' : acces,
      format: String(d.format ?? ''),
      octets: Number(d.bytes ?? 0),
      ...(typeof d.pages === 'number' ? { pages: d.pages } : {}),
      ...(typeof d.width === 'number' ? { largeur: d.width } : {}),
      ...(typeof d.height === 'number' ? { hauteur: d.height } : {}),
    };
  },

  /** Supprime le fichier et vide le cache du CDN. Un fichier déjà absent compte comme supprimé. */
  async supprimer(c: ConfigCloudinary, publicId: string, genre: GenreRessource, acces: AccesRessource = 'upload') {
    if (!peutSigner(c)) throw new Error('Suppression impossible sans clé ni secret : le fichier reste chez Cloudinary.');
    const d = await appeler(c, `${genre}/destroy`, { public_id: publicId, invalidate: 'true', type: acces });
    if (d.result !== 'ok' && d.result !== 'not found') throw new Error(`Cloudinary : suppression refusée (${String(d.result)})`);
  },

  /** Rend privé un ancien dépôt public et vide le cache du CDN : l'ancienne adresse ne répond plus. */
  async rendrePrive(c: ConfigCloudinary, publicId: string, genre: GenreRessource) {
    await appeler(c, `${genre}/rename`, { from_public_id: publicId, to_public_id: publicId, to_type: 'authenticated', type: 'upload', invalidate: 'true' });
  },
};
