/**
 * FlexPaie Payout : envoyer de l'argent vers un numéro mobile money (versement d'une cagnotte, caution rendue).
 *
 * Service distinct du paiement des abonnements : il a son propre identifiant et mot de passe, échangés contre un jeton
 * de durée limitée (authentification), puis trois appels : envoi (pay), vérification d'une transaction (check) et solde
 * du compte marchand (balance). Me ne croit jamais un retour sur parole : chaque versement est revérifié.
 *
 * Variables (Render) :
 * - FLEXPAIE_PAYOUT_URL : l'adresse du service Payout donnée par FlexPaie (ex. https://hote:port), sans chemin.
 * - FLEXPAIE_PAYOUT_USERNAME, FLEXPAIE_PAYOUT_PASSWORD : l'identifiant du module PayoutService du marchand.
 * - FLEXPAIE_PAYOUT_MARCHAND : le code marchand (par défaut FLEXPAIE_MARCHAND).
 * - FLEXPAIE_PAYOUT_CHEMIN_PAY : chemin de l'envoi si FlexPaie en donne un autre (par défaut /api/rest/v1/pay).
 */

import { delai, estDelai } from '../../utils/delai.js';
import { ErreurFlexpaie, montantTexte } from '../abonnements/flexpaie.js';

type Env = Record<string, string | undefined>;
const propre = (v?: string) => (v ?? '').trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
const base = (env: Env = process.env) => propre(env.FLEXPAIE_PAYOUT_URL).replace(/\/+$/, '');
const marchand = (env: Env = process.env) => propre(env.FLEXPAIE_PAYOUT_MARCHAND) || propre(env.FLEXPAIE_MARCHAND);
const cheminPay = (env: Env = process.env) => `/${(propre(env.FLEXPAIE_PAYOUT_CHEMIN_PAY) || 'api/rest/v1/pay').replace(/^\/+/, '')}`;

/** Le service Payout a tout ce qu'il faut pour envoyer de l'argent. */
export const payoutConfigure = (env: Env = process.env) => !!(base(env) && propre(env.FLEXPAIE_PAYOUT_USERNAME) && propre(env.FLEXPAIE_PAYOUT_PASSWORD) && marchand(env));

/** Ce qui manque pour activer les versements automatiques : les noms des variables, jamais leurs valeurs. */
export function manquePayout(env: Env = process.env): string[] {
  return [
    !base(env) ? 'FLEXPAIE_PAYOUT_URL' : '',
    !propre(env.FLEXPAIE_PAYOUT_USERNAME) ? 'FLEXPAIE_PAYOUT_USERNAME' : '',
    !propre(env.FLEXPAIE_PAYOUT_PASSWORD) ? 'FLEXPAIE_PAYOUT_PASSWORD' : '',
    !marchand(env) ? 'FLEXPAIE_PAYOUT_MARCHAND' : '',
  ].filter(Boolean);
}

/**
 * Le statut d'un envoi refusé, en clair. FlexPaie répond « 0XX0 » quand la requête est partie ; les autres disent pourquoi
 * elle ne l'est pas (les X varient : on lit le dernier chiffre).
 */
export function raisonPayout(status: string | undefined, message?: string): { texte: string; jeton: boolean; reessayer: boolean } {
  const fin = (status ?? '').trim().slice(-1);
  if (fin === '1') return { texte: 'Un autre versement est en cours chez FlexPaie : réessaie dans 30 secondes.', jeton: false, reessayer: true };
  if (fin === '2') return { texte: 'Solde FlexPaie insuffisant pour ce versement.', jeton: false, reessayer: false };
  if (fin === '3') return { texte: 'Ce numéro n’est pas pris en charge par FlexPaie.', jeton: false, reessayer: false };
  if (fin === '4') return { texte: 'Jeton FlexPaie refusé.', jeton: true, reessayer: false };
  return { texte: message?.trim() ? `FlexPaie : ${message.trim().slice(0, 160)}` : 'Versement refusé par FlexPaie.', jeton: false, reessayer: false };
}

/** L'état d'une transaction vérifiée : « 0 » réussie, « 1 » échouée, sinon (introuvable, pas encore traitée) en attente. */
export function etatPayout(r: { code?: string | number; status?: string | number }): 'paye' | 'echoue' | 'en_attente' {
  if (String(r.code ?? '') !== '0') return 'en_attente';
  const s = String(r.status ?? '').trim();
  return s === '0' ? 'paye' : s === '1' ? 'echoue' : 'en_attente';
}

let jeton: { valeur: string; expire: number } | null = null;
/** Pour les tests. */
export const oublierJetonPayout = () => {
  jeton = null;
};

async function requete<T>(chemin: string, init: { method: 'GET' | 'POST'; corps?: unknown; auth?: string }): Promise<{ statut: number; data: T & { message?: string } }> {
  let res: Response;
  try {
    res = await fetch(`${base()}${chemin}`, {
      method: init.method,
      headers: { Accept: 'application/json', ...(init.corps ? { 'Content-Type': 'application/json' } : {}), ...(init.auth ? { Authorization: init.auth } : {}) },
      body: init.corps ? JSON.stringify(init.corps) : undefined,
      signal: delai(),
    });
  } catch (e) {
    throw new ErreurFlexpaie(estDelai(e) ? 'FlexPaie Payout met trop de temps à répondre' : 'FlexPaie Payout injoignable');
  }
  return { statut: res.status, data: (await res.json().catch(() => ({}))) as T & { message?: string } };
}

/** Le jeton d'autorisation, gardé jusqu'à une minute avant son expiration. */
async function autorisation(forcer = false): Promise<string> {
  if (!payoutConfigure()) throw new ErreurFlexpaie(`Versements FlexPaie non configurés : ${manquePayout().join(', ')}.`, true);
  if (!forcer && jeton && jeton.expire > Date.now()) return jeton.valeur;
  const { statut, data } = await requete<{ code?: string | number; token?: string; expire_in?: number | string }>('/api/v1/auth/authenticate', {
    method: 'POST',
    corps: { username: propre(process.env.FLEXPAIE_PAYOUT_USERNAME), password: propre(process.env.FLEXPAIE_PAYOUT_PASSWORD) },
  });
  if (statut >= 400 || String(data.code ?? '') !== '0' || !data.token) throw new ErreurFlexpaie('FlexPaie Payout refuse l’identifiant ou le mot de passe (FLEXPAIE_PAYOUT_USERNAME, FLEXPAIE_PAYOUT_PASSWORD).', true);
  const valeur = /^bearer\s/i.test(data.token.trim()) ? data.token.trim() : `Bearer ${data.token.trim()}`;
  const duree = Math.max(60, Number(data.expire_in) || 3600);
  jeton = { valeur, expire: Date.now() + (duree - 60) * 1000 };
  return valeur;
}

/** Un appel authentifié ; un jeton refusé est renouvelé une fois. */
async function appel<T extends { code?: string | number; status?: string | number }>(chemin: string, init: { method: 'GET' | 'POST'; corps?: unknown }): Promise<T & { message?: string }> {
  for (const forcer of [false, true]) {
    const r = await requete<T>(chemin, { ...init, auth: await autorisation(forcer) });
    const refuse = r.statut === 401 || r.statut === 403 || (raisonPayout(String(r.data.status ?? '')).jeton && String(r.data.code ?? '') !== '0');
    if (refuse && !forcer) continue;
    if (r.statut >= 500) throw new ErreurFlexpaie(`FlexPaie Payout a répondu ${r.statut}`);
    return r.data;
  }
  throw new ErreurFlexpaie('Jeton FlexPaie Payout refusé.', true);
}

export const Payout = {
  /** Envoie `montant` (centimes) vers `telephone`. Renvoie le numéro de commande FlexPaie. */
  async verser(p: { telephone: string; reference: string; montant: number; devise: string; retour: string; description?: string }) {
    const r = await appel<{ code?: string | number; status?: string; orderNumber?: string }>(cheminPay(), {
      method: 'POST',
      corps: { merchant: marchand(), type: '1', reference: p.reference, amount: montantTexte(p.montant), currency: p.devise, customer: p.telephone, description: (p.description ?? `Versement Me ${p.reference}`).slice(0, 120), callback_url: p.retour },
    });
    if (String(r.code ?? '') !== '0' || !r.orderNumber) {
      const raison = raisonPayout(r.status, r.message);
      throw new ErreurFlexpaie(raison.texte, raison.jeton);
    }
    return { commande: r.orderNumber, message: r.message ?? '' };
  },

  /** Revérifie un versement auprès de FlexPaie. */
  async verifier(commande: string) {
    const r = await appel<{ code?: string | number; status?: string | number; reference?: string; providerReference?: string }>(`/api/rest/v1/check/${encodeURIComponent(commande)}`, { method: 'GET' });
    return { etat: etatPayout(r), message: r.message ?? '', operateur: r.providerReference ?? null, reference: r.reference ?? null };
  },

  /** Le solde du compte marchand, par devise, en centimes. */
  async solde() {
    const r = await appel<{ code?: string | number; balances?: { currency?: string; amount?: string | number }[] }>(`/api/rest/v1/balance/${encodeURIComponent(marchand())}`, { method: 'GET' });
    if (String(r.code ?? '') !== '0') throw new ErreurFlexpaie(r.message?.trim() || 'Solde FlexPaie indisponible.');
    return (r.balances ?? []).filter((b) => b.currency).map((b) => ({ devise: String(b.currency), montant: Math.round(Number(b.amount ?? 0) * 100) }));
  },
};
