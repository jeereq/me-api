/**
 * Affectation des tâches, des relances et des rendez-vous dans l'espace partagé d'une équipe.
 *
 * Chacun porte `affecteA` : l'identifiant du compte (membre de l'équipe) à qui il est confié. L'espace est un document
 * JSON que le serveur ne lit pas élément par élément ; pour prévenir la personne, il compare la version qu'il garde avec
 * celle qu'on lui envoie et relève ce dont l'affectation vient d'apparaître ou de changer.
 * Les tâches sont dans `taches`, les relances dans `relances`, les rendez-vous dans `agenda` (une liste par jour).
 */

export type GenreAffecte = 'tache' | 'relance' | 'rdv';
export type Affectation = { genre: GenreAffecte; id: string; titre: string; /** Échéance de la tâche, jour de la relance ou du rendez-vous. */ echeance: string | null; userId: string };

/** Au plus ce nombre d'avis par enregistrement : un import ou un client qui s'emballe ne doit pas inonder une boîte mail. */
export const MAX_AVIS_PAR_ENREGISTREMENT = 20;

type Brut = Record<string, unknown>;
const estObjet = (v: unknown): v is Brut => typeof v === 'object' && v !== null && !Array.isArray(v);

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const jourOuNull = (v: unknown) => (typeof v === 'string' && JOUR.test(v) ? v : null);

type Element = { genre: GenreAffecte; id: string; titre: string; echeance: string | null; fait: boolean; affecteA: unknown };

/** Tout ce qui peut être confié dans ce document : tâches, relances, rendez-vous, dans cet ordre. */
function elementsDe(espace: unknown): Element[] {
  if (!estObjet(espace)) return [];
  const liste = (v: unknown): Brut[] => (Array.isArray(v) ? v.filter(estObjet) : []);
  const sortie: Element[] = [];
  for (const t of liste(espace.taches)) if (typeof t.id === 'string' && typeof t.titre === 'string') sortie.push({ genre: 'tache', id: t.id, titre: t.titre, echeance: jourOuNull(t.echeance), fait: t.statut === 'fait', affecteA: t.affecteA });
  for (const r of liste(espace.relances)) {
    if (typeof r.id !== 'string') continue;
    const contact = typeof r.contact === 'string' ? r.contact.trim() : '';
    const sujet = typeof r.sujet === 'string' ? r.sujet.trim() : '';
    sortie.push({ genre: 'relance', id: r.id, titre: [contact, sujet].filter(Boolean).join(' · ') || 'Relance', echeance: jourOuNull(r.date), fait: r.statut === 'repondu', affecteA: r.affecteA });
  }
  if (estObjet(espace.agenda))
    for (const [jour, evenements] of Object.entries(espace.agenda))
      for (const e of liste(evenements)) if (typeof e.id === 'string' && typeof e.titre === 'string') sortie.push({ genre: 'rdv', id: e.id, titre: e.titre, echeance: jourOuNull(jour), fait: false, affecteA: e.affecteA });
  return sortie;
}

/** Y a-t-il au moins un élément affecté dans ce document ? (Sert à éviter de relire l'ancienne version pour rien.) */
export const aDesAffectations = (espace: unknown) => elementsDe(espace).some((x) => typeof x.affecteA === 'string' && x.affecteA !== '');

/**
 * Ce qui vient d'être confié à quelqu'un entre `avant` (ce que le serveur gardait) et `apres` (ce qu'il reçoit).
 * On ne prévient pas : celui qui s'affecte à lui-même, quelqu'un qui n'est pas (ou plus) membre de l'équipe, une tâche
 * faite ou une relance obtenue, ni ce dont l'affectation n'a pas changé.
 */
export function nouvellesAffectations(avant: unknown, apres: unknown, acteurId: string, membres: ReadonlySet<string>): Affectation[] {
  const cle = (x: Pick<Element, 'genre' | 'id'>) => `${x.genre}:${x.id}`;
  const anciennes = new Map(elementsDe(avant).map((x) => [cle(x), x.affecteA]));
  const vues = new Set<string>();
  const sortie: Affectation[] = [];
  for (const x of elementsDe(apres)) {
    if (typeof x.affecteA !== 'string' || vues.has(cle(x)) || x.fait) continue;
    if (x.affecteA === acteurId || !membres.has(x.affecteA)) continue;
    if (anciennes.get(cle(x)) === x.affecteA) continue;
    vues.add(cle(x));
    sortie.push({ genre: x.genre, id: x.id, titre: x.titre.trim().slice(0, 200), echeance: x.echeance, userId: x.affecteA });
    if (sortie.length >= MAX_AVIS_PAR_ENREGISTREMENT) break;
  }
  return sortie;
}
