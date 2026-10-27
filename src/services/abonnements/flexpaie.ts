/**
 * FlexPaie : paiement mobile money (M-Pesa, Orange Money, Airtel Money…) des abonnements Pro.
 *
 * Déroulé : Me demande le paiement (le client reçoit une demande de validation sur son téléphone), FlexPaie
 * renvoie un numéro de commande puis appelle notre adresse de retour. Me ne croit jamais le retour sur parole :
 * il revérifie la commande auprès de FlexPaie avant d'ouvrir Pro.
 *
 * Variables : FLEXPAIE_TOKEN (jeton marchand), FLEXPAIE_MARCHAND (code marchand), FLEXPAIE_URL (adresse de l'API,
 * par défaut celle de production). À vérifier avec la documentation FlexPaie fournie au marchand.
 */

export const flexpaieConfigure = (env: Record<string, string | undefined> = process.env) => !!(env.FLEXPAIE_TOKEN && env.FLEXPAIE_MARCHAND);

const base = () => (process.env.FLEXPAIE_URL || 'https://backend.flexpay.cd/api/rest/v1').trim().replace(/\/+$/, '');

export class ErreurFlexpaie extends Error {}

/**
 * Numéro au format attendu (indicatif sans « + », ex. 243812345678). Un numéro congolais écrit en local
 * (0812345678) reçoit l'indicatif 243. Renvoie null si ce n'est pas un numéro plausible.
 */
export function normaliserTelephone(brut: string): string | null {
  let n = brut.replace(/[\s.()-]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  else if (n.startsWith('00')) n = n.slice(2);
  else if (/^0\d{9}$/.test(n)) n = `243${n.slice(1)}`;
  return /^\d{11,15}$/.test(n) ? n : null;
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
  let res: Response;
  try {
    res = await fetch(`${base()}${chemin}`, {
      method: corps ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${process.env.FLEXPAIE_TOKEN}`, Accept: 'application/json', ...(corps ? { 'Content-Type': 'application/json' } : {}) },
      body: corps ? JSON.stringify(corps) : undefined,
    });
  } catch {
    throw new ErreurFlexpaie('FlexPaie injoignable');
  }
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new ErreurFlexpaie(data.message || `FlexPaie a répondu ${res.status}`);
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
    if (String(r.code) !== '0' || !r.orderNumber) throw new ErreurFlexpaie(r.message || 'Paiement refusé par FlexPaie');
    return { commande: r.orderNumber, message: r.message ?? '' };
  },

  /** Revérifie une commande auprès de FlexPaie. */
  async verifier(commande: string) {
    const r = await appel<{ code?: string | number; message?: string; transaction?: { status?: string | number; amount?: string; currency?: string; reference?: string } | null }>(`/check/${encodeURIComponent(commande)}`);
    return { etat: lireEtat(r), transaction: r.transaction ?? null, message: r.message ?? '' };
  },
};
