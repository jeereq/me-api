/** Ce qu'un commercial peut recevoir. Un admin a tout, un utilisateur rien. Module pur, testé dans tests/roles.test.ts. */
export const MODULES = ['comptes', 'offres', 'verifications', 'versements'] as const;
export type ModuleEquipe = (typeof MODULES)[number];
type Porteur = { role: string; modules?: string[] | null };

export const aModule = (u: Porteur | undefined, m: ModuleEquipe) => !!u && (u.role === 'ADMIN' || (u.role === 'COMMERCIAL' && !!u.modules?.includes(m)));
export const modulesDe = (u: Porteur): ModuleEquipe[] => MODULES.filter((m) => aModule(u, m));

/** Offrir une formule suppose de voir les comptes : cocher l'un ajoute l'autre. */
export function modulesValides(brut: readonly string[] = []): ModuleEquipe[] {
  const choisis = new Set(brut.filter((m): m is ModuleEquipe => (MODULES as readonly string[]).includes(m)));
  if (choisis.has('offres')) choisis.add('comptes');
  return MODULES.filter((m) => choisis.has(m));
}
