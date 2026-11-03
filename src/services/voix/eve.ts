import { createHash, randomBytes } from 'crypto';

import { HttpError } from '../../utils/http.js';
import { prisma } from '../../utils/prisma.js';

/**
 * Eve, la voix de l'app : ElevenLabs lit le texte, et l'audio reste quelques minutes en mémoire pour que le lecteur
 * (navigateur, iPhone, Android) le demande par une adresse. Se paie au caractère : d'où les plafonds, et les mêmes phrases relues sans repayer.
 */
const cle = () => process.env.ELEVENLABS_API_KEY?.trim() || '';
const voixId = () => process.env.ELEVENLABS_VOICE_ID?.trim() || '';
const modele = () => process.env.ELEVENLABS_MODEL?.trim() || 'eleven_flash_v2_5';
const nombre = (brut: string | undefined, defaut: number) => {
  const n = Number(brut);
  return Number.isFinite(n) && n >= 0 ? n : defaut;
};

export const MAX_TEXTE_EVE = 800;
export const MAX_TEXTE_ESSAI = 120;

const DUREE_AUDIO_MS = 5 * 60_000;
const MAX_AUDIOS = 40;

type Audio = { donnees: Buffer; empreinte: string; expire: number };
const audios = new Map<string, Audio>();

/** Une lecture préparée. Les plus anciennes partent quand il y en a trop : la mémoire reste bornée. */
function garder(jeton: string, a: Audio, maintenant = Date.now()) {
  for (const [k, v] of audios) if (v.expire <= maintenant) audios.delete(k);
  while (audios.size >= MAX_AUDIOS) audios.delete(audios.keys().next().value as string);
  audios.set(jeton, a);
}

const jourDe = (d: Date) => d.toISOString().slice(0, 10);

/** Une plage demandée par le lecteur (« bytes=0-1 ») : iOS refuse de lire un fichier sans elle. Null si elle n'est pas valable. */
export function lirePlage(entete: string | undefined, taille: number): { debut: number; fin: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(entete ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  const debut = m[1] ? Number(m[1]) : Math.max(0, taille - Number(m[2]));
  const fin = m[1] && m[2] ? Math.min(Number(m[2]), taille - 1) : taille - 1;
  return debut <= fin && debut < taille ? { debut, fin } : null;
}

async function synthese(texte: string): Promise<Buffer> {
  let r: Response;
  try {
    r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voixId())}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': cle(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: texte, model_id: modele(), language_code: 'fr' }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.error('ElevenLabs injoignable', e);
    throw new HttpError(502, 'Eve ne répond pas pour le moment.');
  }
  if (!r.ok) {
    console.error('ElevenLabs a répondu', r.status, (await r.text().catch(() => '')).slice(0, 300));
    throw new HttpError(502, 'Eve ne répond pas pour le moment.');
  }
  return Buffer.from(await r.arrayBuffer());
}

/** Compte les caractères, sauf si le plafond du jour est atteint. */
async function compter(cleUsage: string, n: number, plafond: number, message: string, maintenant: Date) {
  const jour = jourDe(maintenant);
  const u = await prisma.usageVoix.findUnique({ where: { cle_jour: { cle: cleUsage, jour } } });
  if ((u?.caracteres ?? 0) + n > plafond) throw new HttpError(429, message, 'PLAFOND_VOIX');
  await prisma.usageVoix.upsert({ where: { cle_jour: { cle: cleUsage, jour } }, create: { cle: cleUsage, jour, caracteres: n }, update: { caracteres: { increment: n } } });
}

async function preparer(texte: string, cleUsage: string, plafond: number, message: string, maintenant: Date) {
  if (!Eve.configure()) throw new HttpError(503, 'Eve n’est pas disponible.');
  const propre = texte.replace(/\s+/g, ' ').trim();
  if (!propre) throw new HttpError(400, 'Rien à lire.');
  const empreinte = createHash('sha256').update(propre).digest('hex');
  // La même phrase relue dans les minutes qui suivent ne se repaie pas.
  for (const [jeton, a] of audios) if (a.empreinte === empreinte && a.expire > maintenant.getTime()) return { jeton };
  await compter(cleUsage, propre.length, plafond, message, maintenant);
  const donnees = await synthese(propre);
  const jeton = randomBytes(24).toString('base64url');
  garder(jeton, { donnees, empreinte, expire: maintenant.getTime() + DUREE_AUDIO_MS });
  return { jeton };
}

export const Eve = {
  configure: () => !!(cle() && voixId()),

  /** Pour un compte connecté : ce que l'app lit à voix haute. Au-delà du plafond du jour, l'app reprend la voix du téléphone. */
  dire: (userId: string, texte: string, maintenant = new Date()) =>
    preparer(texte, userId, nombre(process.env.VOIX_EVE_PAR_JOUR, 3000), 'Eve a assez parlé pour aujourd’hui.', maintenant),

  /** La zone de test de la page d'accueil, ouverte à tous : un plafond commun, en plus de la limite par adresse. */
  essai: (texte: string, maintenant = new Date()) =>
    preparer(texte, 'essai', nombre(process.env.VOIX_EVE_ESSAIS_PAR_JOUR, 3000), 'L’essai d’Eve revient demain.', maintenant),

  audio(jeton: string, maintenant = Date.now()) {
    const a = audios.get(jeton);
    return a && a.expire > maintenant ? a.donnees : null;
  },

  async purger(maintenant = new Date()) {
    await prisma.usageVoix.deleteMany({ where: { jour: { lt: jourDe(new Date(maintenant.getTime() - 7 * 86_400_000)) } } });
  },
};
