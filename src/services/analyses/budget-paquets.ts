/**
 * Une analyse par paquets fait plusieurs appels à l'IA pour une seule requête : le plafond des requêtes (60 par 10 minutes)
 * ne voit qu'un appel. Chaque paquet au-delà du premier est donc compté ici : au plus PAQUETS_PAR_FENETRE paquets
 * supplémentaires par compte et par fenêtre. Module pur, en mémoire (un seul serveur) ; testé dans tests/budget-paquets.test.ts.
 */
export const FENETRE_PAQUETS_MS = 10 * 60 * 1000;
export const PAQUETS_PAR_FENETRE = 30;

export function budgetPaquets(max = PAQUETS_PAR_FENETRE, fenetre = FENETRE_PAQUETS_MS) {
  const depenses = new Map<string, { quand: number; n: number }[]>();
  return {
    /** Réserve `paquets - 1` paquets supplémentaires pour ce compte ; faux (rien n'est réservé) si le plafond serait dépassé. */
    depenser(compte: string, paquets: number, maintenant = Date.now()): boolean {
      const extra = Math.max(0, paquets - 1);
      const recentes = (depenses.get(compte) ?? []).filter((d) => maintenant - d.quand < fenetre);
      const total = recentes.reduce((s, d) => s + d.n, 0);
      if (total + extra > max) {
        depenses.set(compte, recentes);
        return false;
      }
      if (extra) recentes.push({ quand: maintenant, n: extra });
      if (recentes.length) depenses.set(compte, recentes);
      else depenses.delete(compte);
      return true;
    },
  };
}

export const paquetsDuServeur = budgetPaquets();
