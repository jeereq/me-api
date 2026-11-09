/**
 * FlexPaie : paiement mobile money (M-Pesa, Orange Money, Airtel Money…) des abonnements et des cotisations.
 * Les versements (argent qui sort vers un numéro) passent par le service Payout : voir cotisations/payout.ts.
 *
 * Déroulé : Me demande le paiement (le client reçoit une demande de validation sur son téléphone), FlexPaie
 * renvoie un numéro de commande puis appelle notre adresse de retour. Me ne croit jamais le retour sur parole :
 * il revérifie la commande auprès de FlexPaie avant d'ouvrir Pro.
 *
 * Variables : FLEXPAIE_TOKEN (jeton marchand), FLEXPAIE_MARCHAND (code marchand), FLEXPAIE_URL (adresse de l'API,
 * par défaut celle de production). À vérifier avec la documentation FlexPaie fournie au marchand.
 */

import { delai, estDelai } from '../../utils/delai.js';

export const flexpaieConfigure = (env: Record<string, string | undefined> = process.env) => !!(jetonFlexpaie(env.FLEXPAIE_TOKEN) && env.FLEXPAIE_MARCHAND);

/**
 * Le jeton marchand tel qu'il faut l'envoyer : sans espaces ni retours à la ligne, sans guillemets, sans « Bearer »
 * déjà collé devant (erreurs fréquentes en recopiant la variable dans l'hébergeur).
 */
export function jetonFlexpaie(brut?: string): string {
  let t = (brut ?? '').trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
  t = t.replace(/^bearer\s+/i, '');
  return t.replace(/\s+/g, '');
}

/** Vrai si `s` est du base64url (ou base64) que décoderait un décodeur strict : bons caractères, bonne longueur, bits de fin à zéro. */
export function base64Strict(s: string): boolean {
  const sans = s.replace(/=+$/, '');
  if (!sans || !/^[A-Za-z0-9_+/-]+$/.test(sans) || sans.length % 4 === 1) return false;
  const url = sans.replace(/\+/g, '-').replace(/\//g, '_');
  return Buffer.from(url, 'base64url').toString('base64url') === url;
}

/**
 * Ce qui cloche dans le jeton FlexPaie, ou null s'il a la forme d'un JWT sain. FlexPaie décode le jeton avec un décodeur
 * base64 strict : un jeton tronqué ou altéré y fait échouer chaque appel avec « Last encoded character… Expected the
 * discarded bits to be zero ». On le repère ici, avant l'appel, pour dire clairement quoi corriger.
 */
export function problemeJeton(jeton: string): string | null {
  if (!jeton) return 'FLEXPAIE_TOKEN est vide';
  const parts = jeton.split('.');
  // Un jeton qui n'est pas un JWT : on ne sait pas le vérifier, FlexPaie tranchera.
  if (parts.length !== 3) return null;
  const noms = ['en-tête', 'contenu', 'signature'];
  const abime = parts.findIndex((p) => !base64Strict(p));
  return abime === -1 ? null : `FLEXPAIE_TOKEN est abîmé (partie « ${noms[abime]} » du jeton illisible) : recopie le jeton complet fourni par FlexPaie`;
}

const base = () => (process.env.FLEXPAIE_URL || 'https://backend.flexpay.cd/api/rest/v1').trim().replace(/\/+$/, '');

/** Erreur FlexPaie ; `configuration` : le problème vient de nos identifiants, pas du client ni de son numéro. */
export class ErreurFlexpaie extends Error {
  constructor(
    message: string,
    public configuration = false,
  ) {
    super(message);
  }
}

/** Une erreur renvoyée par FlexPaie. Celles du décodage de notre jeton marchand viennent de notre configuration, pas du client. */
export function erreurFlexpaie(message: string | undefined, repli: string): ErreurFlexpaie {
  const m = (message ?? '').trim();
  if (/base ?64|discarded bits|illegal .*character|jwt|malformed|unauthori[sz]ed|invalid token|token (is )?(invalid|expired)/i.test(m)) {
    return new ErreurFlexpaie(`FlexPaie refuse le jeton marchand (FLEXPAIE_TOKEN), à vérifier : ${m.slice(0, 200)}`, true);
  }
  return new ErreurFlexpaie(m || repli);
}

/**
 * Numéro au format attendu (indicatif sans « + », ex. 243812345678). Un numéro congolais écrit en local
 * (0812345678) reçoit l'indicatif 243. Avec un « + » ou un « 00 », le pays est explicite : les numéros courts (Danemark, Singapour)
 * passent. Renvoie null si ce n'est pas un numéro plausible.
 */
export function normaliserTelephone(brut: string): string | null {
  let n = brut.replace(/[\s.()-]/g, '');
  const international = /^(\+|00)/.test(n);
  n = n.replace(/^(\+|00)/, '');
  if (!international && /^0\d{9}$/.test(n)) n = `243${n.slice(1)}`;
  if (/^2430\d{9}$/.test(n)) n = `243${n.slice(4)}`;
  return (international ? /^\d{8,15}$/ : /^\d{11,15}$/).test(n) ? n : null;
}

/** Montant en centimes → chaîne décimale (499 → « 4.99 »). */
export const montantTexte = (centimes: number) => (centimes / 100).toFixed(2);

export type EtatCommande = 'paye' | 'echoue' | 'en_attente';

/** Lit l'état d'une transaction FlexPaie : « 0 » réussie, « 1 » échouée, le reste en attente. */
export function lireEtat(reponse: { code?: string | number; transaction?: { status?: string | number } | null }): EtatCommande {
  if (String(reponse.code) !== '0' || !reponse.transaction) return 'en_attente';
  const s = String(reponse.transaction.status);
  return s === '0' ? 'paye' : s === '1' ? 'echoue' : 'en_attente';
}

async function appel<T>(chemin: string, corps?: unknown): Promise<T> {
  const jeton = jetonFlexpaie(process.env.FLEXPAIE_TOKEN);
  const probleme = problemeJeton(jeton);
  if (probleme) throw new ErreurFlexpaie(probleme, true);
  let res: Response;
  try {
    res = await fetch(`${base()}${chemin}`, {
      method: corps ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/json', ...(corps ? { 'Content-Type': 'application/json' } : {}) },
      body: corps ? JSON.stringify(corps) : undefined,
      signal: delai(),
    });
  } catch (e) {
    throw new ErreurFlexpaie(estDelai(e) ? 'FlexPaie met trop de temps à répondre' : 'FlexPaie injoignable');
  }
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw erreurFlexpaie(data.message, `FlexPaie a répondu ${res.status}`);
  return data;
}

export const Flexpaie = {
  /** Envoie la demande de paiement sur le téléphone du client. Renvoie le numéro de commande FlexPaie. */
  async demander(p: { telephone: string; reference: string; montant: number; devise: string; retour: string }) {
    const r = await appel<{ code?: string | number; message?: string; orderNumber?: string }>('/paymentService', {
      merchant: process.env.FLEXPAIE_MARCHAND,
      type: '1',
      phone: p.telephone,
      reference: p.reference,
      amount: montantTexte(p.montant),
      currency: p.devise,
      callbackUrl: p.retour,
    });
    if (String(r.code) !== '0' || !r.orderNumber) throw erreurFlexpaie(r.message, 'Paiement refusé par FlexPaie');
    return { commande: r.orderNumber, message: r.message ?? '' };
  },

  /** Revérifie une commande auprès de FlexPaie. */
  async verifier(commande: string) {
    const r = await appel<{ code?: string | number; message?: string; transaction?: { status?: string | number; amount?: string; currency?: string; reference?: string } | null }>(`/check/${encodeURIComponent(commande)}`);
    return { etat: lireEtat(r), transaction: r.transaction ?? null, message: r.message ?? '' };
  },
};
