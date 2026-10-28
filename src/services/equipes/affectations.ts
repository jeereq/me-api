/**
 * Affectation des tâches dans l'espace partagé d'une équipe.
 *
 * Une tâche porte `affecteA` : l'identifiant du compte (membre de l'équipe) à qui elle est confiée. L'espace est un
 * document JSON que le serveur ne lit pas tâche par tâche ; pour prévenir la personne, il compare la version qu'il
 * garde avec celle qu'on lui envoie et relève les tâches dont l'affectation vient d'apparaître ou de changer.
 */

export type Affectation = { tacheId: string; titre: string; echeance: string | null; userId: string };

/** Au plus ce nombre d'avis par enregistrement : un import ou un client qui s'emballe ne doit pas inonder une boîte mail. */
export const MAX_AVIS_PAR_ENREGISTREMENT = 20;

type Brut = Record<string, unknown>;
const estObjet = (v: unknown): v is Brut => typeof v === 'object' && v !== null && !Array.isArray(v);

const tachesDe = (espace: unknown): Brut[] => {
  const t = estObjet(espace) ? espace.taches : null;
  return Array.isArray(t) ? t.filter(estObjet) : [];
};

/** Y a-t-il au moins une tâche affectée dans ce document ? (Sert à éviter de relire l'ancienne version pour rien.) */
export const aDesAffectations = (espace: unknown) => tachesDe(espace).some((t) => typeof t.affecteA === 'string' && t.affecteA !== '');

/**
 * Les tâches qui viennent d'être confiées à quelqu'un entre `avant` (ce que le serveur gardait) et `apres` (ce qu'il reçoit).
 * On ne prévient pas : celui qui s'affecte à lui-même, quelqu'un qui n'est pas (ou plus) membre de l'équipe, une tâche
 * déjà faite, ni une tâche dont l'affectation n'a pas changé.
 */
export function nouvellesAffectations(avant: unknown, apres: unknown, acteurId: string, membres: ReadonlySet<string>): Affectation[] {
  const anciennes = new Map(tachesDe(avant).filter((t) => typeof t.id === 'string').map((t) => [t.id as string, t.affecteA]));
  const vues = new Set<string>();
  const sortie: Affectation[] = [];
  for (const t of tachesDe(apres)) {
    if (typeof t.id !== 'string' || typeof t.titre !== 'string' || typeof t.affecteA !== 'string') continue;
    if (vues.has(t.id) || t.statut === 'fait') continue;
    if (t.affecteA === acteurId || !membres.has(t.affecteA)) continue;
    if (anciennes.get(t.id) === t.affecteA) continue;
    vues.add(t.id);
    sortie.push({ tacheId: t.id, titre: t.titre.trim().slice(0, 200), echeance: typeof t.echeance === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.echeance) ? t.echeance : null, userId: t.affecteA });
    if (sortie.length >= MAX_AVIS_PAR_ENREGISTREMENT) break;
  }
  return sortie;
}
