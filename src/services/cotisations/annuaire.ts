/**
 * Les outils de l'annuaire : trier, reconnaître ce qu'une alerte attend, et dire ce qu'on sait d'un organisateur.
 * Aucun accès à la base ici : `tontines.ts` charge les données.
 */

export type TriAnnuaire = 'recent' | 'montant' | 'places';
export type FiltresAlerte = { q?: string; mode?: string; rythme?: string; devise?: string; montantMax?: number };
export type FiltresAnnuaire = FiltresAlerte & { tri?: TriAnnuaire; ouverts?: boolean };

/** Ce que l'annuaire dit d'un organisateur : seulement des faits vérifiables sur Me. */
export type Confiance = { termines: number; versements: number; aTemps: number; depuis: string | null };

export const MAX_ALERTES = 5;
export const MOTIFS_SIGNALEMENT = ['arnaque', 'trompeur', 'inapproprie', 'autre'] as const;
export type MotifSignalement = (typeof MOTIFS_SIGNALEMENT)[number];

type Trie = { montant: number; places: number; inscrits: number; createdAt: Date };

/** « Bientôt complets » : le moins de places libres d'abord. À égalité, le plus récent. */
export function trier<T extends Trie>(groupes: T[], tri: TriAnnuaire = 'recent'): T[] {
  const recent = (a: T, b: T) => b.createdAt.getTime() - a.createdAt.getTime();
  const ordre = tri === 'montant' ? (a: T, b: T) => a.montant - b.montant || recent(a, b) : tri === 'places' ? (a: T, b: T) => a.places - a.inscrits - (b.places - b.inscrits) || recent(a, b) : recent;
  return [...groupes].sort(ordre);
}

const sansAccents = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Le groupe répond-il à la recherche enregistrée ? Un critère absent accepte tout. */
export function correspondAlerte(f: FiltresAlerte, g: { nom: string; mode: string; rythme: string; devise: string; montant: number }) {
  if (f.mode && f.mode !== g.mode) return false;
  if (f.rythme && f.rythme !== g.rythme) return false;
  if (f.devise && f.devise !== g.devise) return false;
  if (f.montantMax && g.montant > f.montantMax) return false;
  if (f.q?.trim() && !sansAccents(g.nom).includes(sansAccents(f.q.trim()))) return false;
  return true;
}

/** Deux alertes identiques n'en font qu'une. */
export const cleAlerte = (f: FiltresAlerte) => JSON.stringify([f.q?.trim().toLowerCase() || '', f.mode || '', f.rythme || '', f.devise || '', f.montantMax || 0]);

const plusJours = (jour: string, n: number) => {
  const d = new Date(`${jour}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Un versement validé jusqu'à deux jours après l'échéance compte comme à temps : la validation suit la collecte. */
export function confianceDe(groupes: { etat: string; tours: { etat: string; echeance: string; valideLe: Date | null }[] }[], depuis: Date | null): Confiance {
  const verses = groupes.flatMap((g) => g.tours.filter((t) => t.etat === 'verse'));
  return {
    termines: groupes.filter((g) => g.etat === 'termine').length,
    versements: verses.length,
    aTemps: verses.filter((t) => t.valideLe && t.valideLe.toISOString().slice(0, 10) <= plusJours(t.echeance, 2)).length,
    depuis: depuis ? depuis.toISOString().slice(0, 7) : null,
  };
}
