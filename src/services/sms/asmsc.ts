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
export function configSms(env: Env = process.env): ConfigSms | null {
  const url = env.SMS_API_URL?.trim().replace(/\/+$/, '');
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

/** Appelle aSMSC en POST JSON. Une panne ne laisse jamais passer l'adresse ni le corps de la requête. */
async function appeler<T>(cfg: ConfigSms, chemin: string, corps: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/api/${chemin}`, { method: 'POST', signal: delai(), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
  } catch {
    throw new ErreurSms('Le service SMS est injoignable.');
  }
  const data = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || data === null) throw new ErreurSms(`Le service SMS a répondu ${res.status}.`);
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
