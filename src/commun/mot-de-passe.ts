/**
 * Ce qu'un mot de passe doit éviter : la même règle pour l'écran et pour le serveur. Module pur.
 * On refuse ce qui se devine vite (mots très courants, suites, nom ou adresse) plutôt que d'imposer majuscules et symboles :
 * une longue phrase facile à retenir vaut mieux qu'un mot court compliqué.
 */

export const MDP_MIN = 8;
export const MDP_MAX = 128;

const COURANTS = ['motdepasse', 'password', 'passe', 'azerty', 'qwerty', 'qwertz', 'azertyuiop', 'qwertyuiop', 'bonjour', 'soleil', 'loulou', 'marseille', 'kinshasa', 'congo', 'jesus', 'admin', 'administrateur', 'welcome', 'iloveyou', 'jetaime', 'letmein', 'monkey', 'dragon', 'football', 'secret', 'utilisateur', 'test'];
const SUITES = ['0123456789', '9876543210', 'abcdefghijklmnopqrstuvwxyz', 'azertyuiop', 'qwertyuiop'];

const propre = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

type Compte = { email?: string | null; nom?: string | null; telephone?: string | null };

/** Pourquoi ce mot de passe n'est pas accepté ; null s'il convient. */
export function refusMotDePasse(mdp: string, c: Compte = {}): string | null {
  if (mdp.length < MDP_MIN) return `${MDP_MIN} caractères minimum.`;
  if (mdp.length > MDP_MAX) return `${MDP_MAX} caractères maximum.`;
  const m = propre(mdp);
  if (new Set(m).size <= 2) return 'Trop répétitif.';
  if (SUITES.some((s) => s.includes(m))) return 'Une suite se devine vite.';
  // Un mot courant reste courant avec des chiffres ou des symboles autour.
  if (COURANTS.includes(m.replace(/^[^a-z]+|[^a-z]+$/g, ''))) return 'Trop courant.';
  const local = propre(c.email ?? '').split('@')[0];
  const nom = propre(c.nom ?? '').replace(/\s+/g, '');
  const chiffres = (c.telephone ?? '').replace(/\D/g, '').slice(-9);
  if ((local.length >= 4 && m.includes(local)) || (nom.length >= 4 && m.includes(nom)) || (chiffres.length >= 9 && m.includes(chiffres))) return 'Évite ton nom, ton adresse ou ton numéro.';
  return null;
}

/** De 1 (acceptable) à 3 (solide) : surtout la longueur. 0 si le mot de passe est refusé. */
export function forceMotDePasse(mdp: string, c: Compte = {}): 0 | 1 | 2 | 3 {
  if (refusMotDePasse(mdp, c)) return 0;
  const varietes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((r) => r.test(mdp)).length;
  const points = (mdp.length >= 12 ? 2 : mdp.length >= 10 ? 1 : 0) + (mdp.length >= 16 ? 1 : 0) + (varietes >= 3 ? 1 : 0) + (varietes === 4 ? 1 : 0);
  return points >= 3 ? 3 : points >= 1 ? 2 : 1;
}
