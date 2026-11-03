import { debutAbonnements, etatAbonnement, finEssaiEffective, formulePayee, palierDe, prolongerDe, type ChampsAbonnement, type Formule, type Palier } from '../abonnements/offres.js';

/**
 * L'onglet Utilisateurs de l'admin : qui a quelle offre, ce qui expire, ce qui a été payé. Module pur, testé dans tests/gestion-membres.test.ts.
 * L'admin voit le compte et son abonnement, jamais le contenu de l'espace privé.
 */

export const FILTRES = ['tous', 'abonnes', 'essai', 'sans', 'expirent', 'anciens'] as const;
export type FiltreMembres = (typeof FILTRES)[number];

/** Une période qui finit dans ces jours « expire bientôt » : c'est le moment de relancer. */
export const JOURS_EXPIRE_BIENTOT = 7;

export type CompteGestion = ChampsAbonnement & { id: string; email: string | null; telephone?: string | null; nom: string; role: 'ADMIN' | 'UTILISATEUR'; emailVerifie: boolean; createdAt: Date };

export type LigneMembre = {
  id: string;
  email: string;
  nom: string;
  role: 'ADMIN' | 'UTILISATEUR';
  emailVerifie: boolean;
  creeLe: string;
  offre: 'gratuit' | 'essai' | 'finances' | 'pro' | 'libre';
  palier: Palier;
  periode: string | null;
  jusqua: string | null;
  joursRestants: number | null;
  /** Fin d'une période payée déjà passée : un ancien abonné, à relancer. */
  expireLe: string | null;
};

/** L'offre réelle du compte, abonnements activés : la liste doit dire la même chose avant et après leur mise en service. */
export function ligneMembre(u: CompteGestion, maintenant = new Date(), depuis = debutAbonnements()): LigneMembre {
  const e = etatAbonnement(u, maintenant, true, depuis);
  const passe = u.abonnementFinLe && u.abonnementFinLe <= maintenant ? u.abonnementFinLe : null;
  return {
    id: u.id,
    // Un compte sans email se reconnaît à son numéro.
    email: u.email ?? (u.telephone ? `+${u.telephone}` : ''),
    nom: u.nom,
    role: u.role,
    emailVerifie: u.emailVerifie,
    creeLe: u.createdAt.toISOString(),
    offre: e.offre,
    palier: e.offre === 'pro' ? e.palier : 0,
    periode: e.offre === 'pro' || e.offre === 'finances' ? e.periode : null,
    jusqua: e.jusqua,
    joursRestants: e.joursRestants,
    expireLe: passe ? passe.toISOString() : null,
  };
}

const estAbonne = (l: LigneMembre) => l.offre === 'pro' || l.offre === 'finances';
const expireBientot = (l: LigneMembre) => estAbonne(l) && l.joursRestants !== null && l.joursRestants <= JOURS_EXPIRE_BIENTOT;
const correspond: Record<FiltreMembres, (l: LigneMembre) => boolean> = {
  tous: () => true,
  abonnes: estAbonne,
  essai: (l) => l.offre === 'essai',
  sans: (l) => l.offre === 'gratuit',
  expirent: expireBientot,
  anciens: (l) => l.offre === 'gratuit' && !!l.expireLe,
};

const sansAccents = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Les comptes d'un filtre et d'une recherche (nom ou email) ; ce qui expire le plus tôt d'abord, sinon les plus récents. */
export function filtrerMembres(lignes: LigneMembre[], filtre: FiltreMembres, recherche = ''): LigneMembre[] {
  const q = sansAccents(recherche.trim());
  const garde = lignes.filter((l) => correspond[filtre](l) && (!q || sansAccents(`${l.nom} ${l.email}`).includes(q)));
  if (filtre === 'expirent') return garde.sort((a, b) => (a.jusqua ?? '').localeCompare(b.jusqua ?? ''));
  return garde.sort((a, b) => b.creeLe.localeCompare(a.creeLe));
}

export type PaiementCompte = { montant: number; devise: string; payeLe: Date | null };

/** Les chiffres en tête de l'onglet. Les montants restent en centimes et par devise : on n'additionne pas des dollars et des francs. */
export function statsMembres(lignes: LigneMembre[], paiements: PaiementCompte[], maintenant = new Date()) {
  const mois = maintenant.toISOString().slice(0, 7);
  const revenus: Record<string, { total: number; mois: number }> = {};
  for (const p of paiements) {
    const r = (revenus[p.devise] ??= { total: 0, mois: 0 });
    r.total += p.montant;
    if (p.payeLe?.toISOString().slice(0, 7) === mois) r.mois += p.montant;
  }
  const compte = Object.fromEntries(FILTRES.map((f) => [f, lignes.filter(correspond[f]).length])) as Record<FiltreMembres, number>;
  return { ...compte, revenus };
}

/** Nouvelle fin d'une formule offerte : le temps déjà payé est converti comme pour un paiement, rien n'est perdu. */
export function finOfferte(u: ChampsAbonnement, formule: Formule, palier: Palier, mois: number, maintenant = new Date(), depuis = debutAbonnements()) {
  const avant = formulePayee(u);
  return prolongerDe({ fin: u.abonnementFinLe, formule: avant, palier: avant === 'pro' ? palierDe(u.abonnementPalier) : 0 }, mois, maintenant, finEssaiEffective(u.essaiJusqua, depuis), formule, formule === 'pro' ? palier : 0);
}

/** Nouvelle fin d'essai : ajoutée à l'essai en cours, sinon à partir d'aujourd'hui. */
export function finEssaiProlonge(u: Pick<ChampsAbonnement, 'essaiJusqua'>, jours: number, maintenant = new Date(), depuis = debutAbonnements()) {
  const actuelle = finEssaiEffective(u.essaiJusqua, depuis);
  const depart = actuelle && actuelle > maintenant ? actuelle : maintenant;
  return new Date(depart.getTime() + jours * 86400000);
}
