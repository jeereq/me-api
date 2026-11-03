import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { delai } from '../../utils/delai.js';

/**
 * aSMSC : envoi de SMS et solde du compte (API 3.1). Le code de vérification d'un numéro est fait ici : voir creerCode.
 * Module sans base de données, testé dans tests/sms.test.ts. Le mot de passe de l'API ne sort jamais d'ici :
 * ni dans les erreurs, ni dans les journaux, et il part dans le corps des requêtes, jamais dans une adresse.
 */

export type ConfigSms = { url: string; id: string; motDePasse: string; expediteur: string; marque: string };
export type Encodage = 'T' | 'U';
export type StatutSms = 'soumis' | 'delivre' | 'echec';

export class ErreurSms extends Error {}

type Env = Record<string, string | undefined>;

/** Lit la configuration ; null tant qu'il manque l'adresse, l'identifiant, le mot de passe ou l'expéditeur. */
/**
 * L'adresse de base du service, quelle que soit la façon de la coller dans la variable : sans « https:// », entre guillemets,
 * avec le nom de la variable devant, ou le lien complet (…/api/SendSms?api_id=…), dont les paramètres ne doivent pas servir d'adresse.
 */
export function adresseService(brut: string | undefined): string {
  const a = (brut ?? '').trim().replace(/^SMS_API_URL\s*=\s*/i, '').replace(/^["']|["']$/g, '').trim().replace(/[?#].*$/, '').replace(/\/api(\/.*)?$/i, '').replace(/\/+$/, '');
  if (!a) return '';
  return /^https?:\/\//i.test(a) ? a : `https://${a}`;
}

export function configSms(env: Env = process.env): ConfigSms | null {
  const url = adresseService(env.SMS_API_URL);
  const id = env.SMS_API_ID?.trim();
  const motDePasse = env.SMS_API_PASSWORD?.trim();
  const expediteur = env.SMS_SENDER_ID?.trim();
  if (!url || !id || !motDePasse || !expediteur) return null;
  return { url, id, motDePasse, expediteur, marque: env.SMS_BRAND?.trim() || 'Me' };
}

const GSM_SIMPLE = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_DOUBLE = '^{}\\[~]|€';
const estGsm = (c: string) => GSM_SIMPLE.includes(c) || GSM_DOUBLE.includes(c);
const poidsGsm = (c: string) => (GSM_DOUBLE.includes(c) ? 2 : 1);

/**
 * Le texte d'un SMS, sur un seul message pour ne payer qu'un envoi : la ponctuation française et les accents absents de
 * l'alphabet GSM sont simplifiés (un SMS en Unicode tient en 70 caractères au lieu de 160). Unicode ne sert que si
 * le texte contient autre chose (emoji, autre alphabet).
 */
export function preparerTexte(brut: string): { texte: string; encodage: Encodage } {
  const propre = brut
    .replace(/[’‘ʼ]/g, "'")
    .replace(/«\s*/g, '"')
    .replace(/\s*»/g, '"')
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[–—·•]/g, '-')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Un accent absent de l'alphabet GSM perd son accent (ê → e) ; é, è, à, ù, ì, ò restent.
  const replie = [...propre].map((c) => (estGsm(c) ? c : c.normalize('NFD').replace(/\p{M}/gu, ''))).join('');
  const gsm = [...replie].every(estGsm);
  const limite = gsm ? 160 : 70;
  const poids = gsm ? poidsGsm : () => 1;
  let total = 0;
  for (const c of replie) total += poids(c);
  if (total <= limite) return { texte: replie, encodage: gsm ? 'T' : 'U' };
  let garde = '';
  total = 3;
  for (const c of replie) {
    if (total + poids(c) > limite) break;
    garde += c;
    total += poids(c);
  }
  return { texte: `${garde.trimEnd()}...`, encodage: gsm ? 'T' : 'U' };
}

/** Le SMS d'un passage des rappels : le rappel s'il est seul, sinon leur nombre et leurs titres. */
export function texteRappels(rappels: { titre: string; corps: string }[]): string {
  if (rappels.length === 1) return `${rappels[0].titre}. ${rappels[0].corps}`;
  return `${rappels.length} rappels : ${rappels.map((r) => r.titre).join(' ; ')}`;
}

/** Un rappel qui peut attendre : discret, briefing, encouragement de la série. Il part après les autres et ne prend pas leur place. */
export const rappelSecondaire = (r: { mode: string; cle: string }) => r.mode === 'passif' || r.mode === 'briefing' || /\|serie(\||$)/.test(r.cle);

/** Les rappels envoyés par SMS, comme par email : tous, sauf une alerte dont le push et l'email sont coupés. Le plus important d'abord, car un SMS est court. */
export function rappelsParSms<R extends { mode: string; cle: string; canaux?: { push: boolean; email: boolean } }>(rappels: R[]): R[] {
  const gardes = rappels.filter((r) => r.canaux?.push !== false || r.canaux?.email !== false);
  return [...gardes.filter((r) => !rappelSecondaire(r)), ...gardes.filter(rappelSecondaire)];
}

/** Places gardées chaque jour pour ce qui est à faire : un briefing et des rappels discrets ne les prennent pas. */
const PLACES_GARDEES = 2;
/** Reste-t-il de la place aujourd'hui pour ce SMS ? */
export const placeSms = (envoyes: number, max: number, secondaire: boolean) => envoyes < (secondaire ? Math.max(1, max - PLACES_GARDEES) : max);

/** L'état d'un SMS d'après le statut de livraison d'aSMSC. */
export function statutLivraison(dlr: unknown): StatutSms {
  const s = String(dlr ?? '').toLowerCase();
  if (s === 'delivered') return 'delivre';
  if (['undeliverable', 'expired', 'rejected', 'failed', 'dnd'].includes(s)) return 'echec';
  return 'soumis';
}

/** Compare la clé reçue sur l'adresse de retour, sans révéler où elle diffère. */
export function cleValide(recue: unknown, attendue: string | undefined): boolean {
  if (!attendue || typeof recue !== 'string') return false;
  const a = Buffer.from(recue);
  const b = Buffer.from(attendue);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Le code qui vérifie un numéro : créé ici et envoyé comme un SMS ordinaire, car tous les comptes n'ont pas la route Verify du service.
 * Seule son empreinte est gardée, liée au compte et au numéro : elle ne sert ni à retrouver le code, ni pour un autre numéro.
 */
export const creerCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const empreinteCode = (code: string, userId: string, telephone: string, secret: string) => createHmac('sha256', secret).update(`${userId}|${telephone}|${code}`).digest('hex');
export const codeValide = (recu: string, attendue: string, userId: string, telephone: string, secret: string) => {
  const a = Buffer.from(empreinteCode(recu, userId, telephone, secret));
  const b = Buffer.from(attendue);
  return a.length === b.length && timingSafeEqual(a, b);
};
export const texteCode = (marque: string, code: string) => `${marque} : ton code est ${code}. Il expire dans 10 minutes.`;

const CERTIFICATS = /CERT|SIGNATURE|TLS|SSL/i;

/** Le nom du serveur appelé : il n'a rien de secret et montre tout de suite une variable mal remplie. */
const nomServeur = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/** Ce qui a empêché de joindre le service, en clair, avec le code d'origine. Jamais les paramètres ni le corps de la requête. */
export function raisonPanne(e: unknown, serveur = ''): string {
  const err = e as { name?: string; code?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'Le service SMS met trop de temps à répondre.';
  const code = err?.cause?.code ?? err?.code ?? '';
  if (code === 'ERR_INVALID_URL') return 'L’adresse du service SMS est invalide (SMS_API_URL).';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Le serveur ne trouve pas l’adresse ${serveur || 'du service SMS'} (${code}). Vérifie SMS_API_URL.`;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_SOCKET') return `Le service SMS refuse la connexion du serveur (${code}).`;
  if (CERTIFICATS.test(code)) return `Le certificat du service SMS est refusé (${code}).`;
  return code ? `Le service SMS est injoignable (${code}).` : 'Le service SMS est injoignable.';
}

/** La documentation écrit aussi « SendSMS ». */
const AUTRE_ORTHOGRAPHE: Record<string, string> = { SendSms: 'SendSMS' };

/**
 * Appelle aSMSC en POST JSON. Un 404 n'a rien envoyé : on essaie alors l'autre orthographe, puis GET, qui est la forme des liens du panneau client.
 * Une panne ne laisse jamais passer l'adresse ni le corps de la requête.
 */
async function appeler<T>(cfg: ConfigSms, chemin: string, corps: Record<string, unknown>): Promise<T> {
  const poster = (nom: string) => fetch(`${cfg.url}/api/${nom}`, { method: 'POST', signal: delai(), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
  const lire = () => fetch(`${cfg.url}/api/${chemin}?${new URLSearchParams(Object.entries(corps).map(([k, v]): [string, string] => [k, String(v)]))}`, { signal: delai() });
  let res: Response;
  try {
    res = await poster(chemin);
    if (res.status === 404 && AUTRE_ORTHOGRAPHE[chemin]) res = await poster(AUTRE_ORTHOGRAPHE[chemin]);
    if (res.status === 404) res = await lire();
  } catch (e) {
    const raison = raisonPanne(e, nomServeur(cfg.url));
    console.error('SMS', chemin, raison);
    throw new ErreurSms(raison);
  }
  const data = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || data === null) {
    // La réponse du service dit souvent la vraie cause (compte, expéditeur) : elle ne contient pas nos identifiants.
    const precision = (data as { remarks?: unknown } | null)?.remarks;
    const raison = `Le service SMS a répondu ${res.status} sur ${nomServeur(cfg.url)}/api/${chemin}${typeof precision === 'string' && precision ? ` : ${precision.slice(0, 120)}` : ''}.`;
    console.error('SMS', raison);
    throw new ErreurSms(raison);
  }
  return data;
}

const identifiants = (cfg: ConfigSms) => ({ api_id: cfg.id, api_password: cfg.motDePasse });

export const Asmsc = {
  /** Envoie un SMS transactionnel. `uid` revient sur l'adresse de retour. */
  async envoyer(cfg: ConfigSms, m: { telephone: string; texte: string; uid: string; retour?: string }) {
    const { texte, encodage } = preparerTexte(m.texte);
    // Pas de durée de vie : le service garde sa valeur par défaut (2 jours). Il refuse au-delà de 2880, alors que sa documentation parle de secondes.
    const r = await appeler<{ message_id?: unknown; status?: string; remarks?: string }>(cfg, 'SendSms', {
      ...identifiants(cfg),
      sms_type: 'T',
      encoding: encodage,
      sender_id: cfg.expediteur,
      phonenumber: m.telephone,
      textmessage: texte,
      uid: m.uid,
      ...(m.retour ? { callback_url: m.retour } : {}),
    });
    if (r.status !== 'S') throw new ErreurSms(r.remarks || 'SMS refusé.');
    return { messageId: r.message_id === undefined ? null : String(r.message_id) };
  },

  async solde(cfg: ConfigSms) {
    const r = await appeler<{ BalanceAmount?: unknown; CurrenceCode?: unknown; CurrencyCode?: unknown }>(cfg, 'CheckBalance', identifiants(cfg));
    const montant = Number(r.BalanceAmount);
    if (!Number.isFinite(montant)) throw new ErreurSms('Solde illisible.');
    return { montant, devise: String(r.CurrenceCode ?? r.CurrencyCode ?? '') };
  },
};
