import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const { libellePeriode, montantCotisation, numeroMasque, periodeDuJour, periodesDepuis } = await import('../src/commun/cotisations.js');
const { enCoffre } = await import('../src/utils/coffre.js');
const { creerCotisations } = await import('../src/services/cotisations/moteur.js');
type Deps = import('../src/services/cotisations/moteur.js').DepsCotisations;
type Ligne = Record<string, any>;

describe('périodes et montants', () => {
  it('découpe par mois et par semaine', () => {
    assert.equal(periodeDuJour('mensuel', '2026-11-06'), '2026-11');
    assert.equal(periodeDuJour('hebdomadaire', '2026-11-08'), '2026-11-02');
    assert.deepEqual(periodesDepuis('mensuel', '2026-11-30', '2027-02-01'), ['2026-11', '2026-12', '2027-01', '2027-02']);
    assert.deepEqual(periodesDepuis('unique', '2026-11-06', '2030-01-01'), ['unique']);
  });
  it('écrit les montants et les numéros', () => {
    assert.equal(libellePeriode('2026-11'), 'novembre 2026');
    assert.equal(libellePeriode('2026-11-02'), 'semaine du 2 novembre');
    assert.equal(montantCotisation(1050, 'USD'), '10,50 USD');
    assert.equal(montantCotisation(5000000, 'CDF'), '50 000 CDF');
    assert.equal(numeroMasque('243812345678'), '243•••••5678');
  });
});

describe('anciennes collectes', () => {
  it('plus aucune route de création ni de paiement sans compte', () => {
    const routes = readFileSync(new URL('../src/routes/cotisation.routes.ts', import.meta.url), 'utf8');
    assert.equal(routes.includes('public'), false);
    assert.equal(routes.match(/router\.post\(/g)?.length, 1);
    assert.ok(routes.includes("router.post('/flexpaie/retour'"));
    assert.equal(routes.includes('router.patch'), false);
  });

  let cot: Ligne[];
  let mem: Ligne[];
  let pai: Ligne[];
  let reponse: { etat: 'paye' | 'echoue' | 'en_attente'; transaction: { amount?: string; currency?: string } | null; message: string };
  let avis: { userId: string; titre: string }[];
  let s: ReturnType<typeof creerCotisations>;
  const U = 'u1';

  const correspond = (l: Ligne, w: Ligne = {}): boolean =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'OR') return (v as Ligne[]).some((x) => correspond(l, x));
      if (k === 'cotisation') return cot.find((c) => c.id === l.cotisationId)?.userId === (v as Ligne).userId;
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const o = v as Ligne;
        if (o.in) return o.in.includes(l[k]);
        if (o.not === null) return l[k] != null;
        if (o.gt) return l[k] > o.gt;
        if (o.lte) return l[k] <= o.lte;
      }
      return l[k] === v;
    });
  const complet = (c: Ligne) => ({
    ...c,
    user: { nom: 'Jeereq Takango', fuseau: 'Africa/Kinshasa' },
    membres: mem.filter((m) => m.cotisationId === c.id).map((m) => ({ ...m, paiements: pai.filter((p) => p.membreId === m.id) })),
    paiements: pai.filter((p) => p.cotisationId === c.id && p.mode === 'mobile' && p.statut === 'paye'),
  });

  beforeEach(() => {
    cot = [{ id: 'c1', userId: U, titre: 'Mariage', montant: 1000, devise: 'USD', rythme: 'mensuel', debut: '2026-11-01', archive: false, createdAt: new Date() }];
    mem = [{ id: 'm1', cotisationId: 'c1', contact: enCoffre({ nom: 'Marie Kabila', telephone: '243812345678' }), demandePeriode: null, createdAt: new Date() }];
    pai = [];
    reponse = { etat: 'en_attente', transaction: null, message: '' };
    avis = [];
    const db = {
      cotisation: {
        findFirst: async ({ where }: Ligne) => {
          const c = cot.find((x) => correspond(x, where));
          return c ? complet(c) : null;
        },
        findMany: async ({ where }: Ligne) => cot.filter((c) => correspond(c, where)).map(complet),
        delete: async ({ where }: Ligne) => {
          cot = cot.filter((c) => c.id !== where.id);
          mem = mem.filter((m) => m.cotisationId !== where.id);
        },
      },
      cotisationMembre: {
        findFirst: async ({ where }: Ligne) => {
          const m = mem.find((x) => correspond(x, where));
          return m ? { ...m, paiements: pai.filter((p) => p.membreId === m.id) } : null;
        },
        delete: async ({ where }: Ligne) => {
          mem = mem.filter((m) => m.id !== where.id);
          pai.filter((p) => p.membreId === where.id).forEach((p) => (p.membreId = null));
        },
      },
      paiementCotisation: {
        count: async ({ where }: Ligne) => pai.filter((p) => correspond(p, where)).length,
        updateMany: async ({ where, data }: Ligne) => {
          const l = pai.filter((p) => correspond(p, where));
          l.forEach((p) => Object.assign(p, data));
          return { count: l.length };
        },
        deleteMany: async ({ where }: Ligne) => {
          const l = pai.filter((p) => correspond(p, where));
          pai = pai.filter((p) => !l.includes(p));
          return { count: l.length };
        },
        findFirst: async ({ where }: Ligne) => pai.find((p) => correspond(p, where)) ?? null,
        findMany: async ({ where }: Ligne) => pai.filter((p) => correspond(p, where)),
        findUnique: async ({ where }: Ligne) => {
          const p = pai.find((x) => x.id === where.id);
          return p ? { membre: mem.find((m) => m.id === p.membreId) ?? null, cotisation: cot.find((c) => c.id === p.cotisationId) ?? null } : null;
        },
      },
    };
    s = creerCotisations({
      db: db as unknown as Deps['db'],
      flexpaie: { verifier: async () => reponse },
      flexpaiePret: () => true,
      prevenir: async (userId, a) => {
        avis.push({ userId, titre: a.titre });
      },
    });
  });
  const attente = () =>
    pai.push({ id: 'p1', reference: 'CO1', cotisationId: 'c1', membreId: 'm1', periode: '2026-11', montant: 1000, devise: 'USD', mode: 'mobile', statut: 'en_attente', commande: 'C1', createdAt: new Date() });

  it('reste lisible, sans numéro ni lien', async () => {
    const { cotisations } = await s.liste(U);
    assert.equal(cotisations[0].membres[0].nom, 'Marie Kabila');
    assert.equal(JSON.stringify(cotisations).includes('812345678'), false);
    assert.deepEqual((await s.liste('intrus')).cotisations, []);
  });

  it('un paiement déjà parti reste vérifié et compté une fois', async () => {
    attente();
    await s.retour({ reference: 'CO1', status: '0', amount: '10.00' });
    assert.equal(pai[0].statut, 'en_attente');
    reponse = { etat: 'paye', transaction: { amount: '10.00', currency: 'USD' }, message: '' };
    await s.retour({ reference: 'CO1' });
    await s.retour({ orderNumber: 'C1' });
    assert.equal(pai[0].statut, 'paye');
    assert.equal(avis.length, 1);
    assert.equal((await s.liste(U)).cotisations[0].encaisse, 1000);
  });

  it('refuse un montant différent ou une autre devise', async () => {
    attente();
    reponse = { etat: 'paye', transaction: { amount: '1.00', currency: 'USD' }, message: '' };
    await s.retour({ reference: 'CO1' });
    assert.equal(pai[0].statut, 'echoue');
  });

  it('rattrape un retour perdu, puis expire au bout de 24 h', async () => {
    attente();
    await s.rattraper();
    assert.equal(pai[0].statut, 'en_attente');
    await s.rattraper(Date.now() + 86400000 + 1000);
    assert.equal(pai[0].statut, 'expire');
    reponse = { etat: 'paye', transaction: { amount: '10.00', currency: 'USD' }, message: '' };
    await s.rattraper(Date.now() + 2 * 86400000);
    assert.equal(pai[0].statut, 'paye');
  });

  it('efface les données, sans perdre l’argent encaissé', async () => {
    attente();
    await assert.rejects(s.retirerMembre(U, 'm1'), /en cours/);
    await assert.rejects(s.retirerMembre('intrus', 'm1'), /introuvable/);
    reponse = { etat: 'paye', transaction: { amount: '10.00', currency: 'USD' }, message: '' };
    await s.retour({ reference: 'CO1' });
    const r = await s.retirerMembre(U, 'm1');
    assert.equal(r.cotisation.membres.length, 0);
    assert.equal(r.cotisation.encaisse, 1000);
    assert.equal(pai[0].membreId, null);
    await assert.rejects(s.supprimer(U, 'c1'), /ne peut pas être supprimée/);
  });

  it('supprime une collecte sans argent en ligne', async () => {
    pai.push({ id: 'p2', cotisationId: 'c1', membreId: 'm1', mode: 'main', statut: 'paye', periode: '2026-11', montant: 1000, createdAt: new Date() });
    await assert.rejects(s.supprimer('intrus', 'c1'), /introuvable/);
    await s.supprimer(U, 'c1');
    assert.equal(cot.length, 0);
    assert.equal(mem.length, 0);
    assert.equal(pai.length, 0);
  });
});
