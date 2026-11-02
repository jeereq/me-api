import { timingSafeEqual } from 'node:crypto';

import { delai } from '../../utils/delai.js';

/**
 * aSMSC : envoi de SMS, vérification d'un numéro par code et solde du compte (API 3.1).
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

/** Durée de vie d'un rappel : au-delà de 6 h, il ne sert plus à rien de le livrer. */
const VALIDITE_SECONDES = 6 * 3600;
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

/**
 * Les rappels qui méritent un SMS payé : ce qui est à faire. Ni les rappels discrets, ni le briefing, ni les encouragements
 * de la série, ni une alerte dont le push et l'email sont tous deux coupés.
 */
export function rappelsParSms<R extends { mode: string; cle: string; canaux?: { push: boolean; email: boolean } }>(rappels: R[]): R[] {
  return rappels.filter((r) => r.mode !== 'passif' && r.mode !== 'briefing' && !/\|serie(\||$)/.test(r.cle) && (r.canaux?.push !== false || r.canaux?.email !== false));
}

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

/** La documentation écrit aussi « SendSMS » et « Verfiy » : un 404 n'a rien envoyé, on essaie donc cette autre orthographe. */
const AUTRE_ORTHOGRAPHE: Record<string, string> = { SendSms: 'SendSMS', Verify: 'Verfiy' };

/** Appelle aSMSC en POST JSON. Une panne ne laisse jamais passer l'adresse ni le corps de la requête. */
async function appeler<T>(cfg: ConfigSms, chemin: string, corps: Record<string, unknown>): Promise<T> {
  const poster = (nom: string) => fetch(`${cfg.url}/api/${nom}`, { method: 'POST', signal: delai(), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
  let res: Response;
  try {
    res = await poster(chemin);
    if (res.status === 404 && AUTRE_ORTHOGRAPHE[chemin]) res = await poster(AUTRE_ORTHOGRAPHE[chemin]);
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
    const r = await appeler<{ message_id?: unknown; status?: string; remarks?: string }>(cfg, 'SendSms', {
      ...identifiants(cfg),
      sms_type: 'T',
      encoding: encodage,
      sender_id: cfg.expediteur,
      phonenumber: m.telephone,
      textmessage: texte,
      ValidityPeriodInSeconds: VALIDITE_SECONDES,
      uid: m.uid,
      ...(m.retour ? { callback_url: m.retour } : {}),
    });
    if (r.status !== 'S') throw new ErreurSms(r.remarks || 'SMS refusé.');
    return { messageId: r.message_id === undefined ? null : String(r.message_id) };
  },

  /** Envoie un code de vérification et renvoie l'identifiant de la demande. */
  async demanderVerification(cfg: ConfigSms, telephone: string) {
    const r = await appeler<{ verfication_id?: unknown; verification_id?: unknown; status?: string; remarks?: string }>(cfg, 'Verify', {
      ...identifiants(cfg),
      brand: cfg.marque,
      phonenumber: telephone,
      sender_id: cfg.expediteur,
    });
    // La documentation écrit « verfication_id » ; l'orthographe correcte est lue aussi, au cas où.
    const id = r.verfication_id ?? r.verification_id;
    if (r.status !== 'S' || id === undefined || id === null) throw new ErreurSms(r.remarks || 'Code non envoyé.');
    return String(id);
  },

  /** Le code saisi est-il le bon ? */
  async controlerCode(cfg: ConfigSms, verification: string, code: string) {
    const r = await appeler<{ status?: string }>(cfg, 'VerifyStatus', { verfication_id: verification, verfication_code: code });
    return r.status === 'V';
  },

  async solde(cfg: ConfigSms) {
    const r = await appeler<{ BalanceAmount?: unknown; CurrenceCode?: unknown; CurrencyCode?: unknown }>(cfg, 'CheckBalance', identifiants(cfg));
    const montant = Number(r.BalanceAmount);
    if (!Number.isFinite(montant)) throw new ErreurSms('Solde illisible.');
    return { montant, devise: String(r.CurrenceCode ?? r.CurrencyCode ?? '') };
  },
};
