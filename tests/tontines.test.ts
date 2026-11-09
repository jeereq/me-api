import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const { echeancesTontine, limitesDe, LIMITES_DEFAUT, rappelDuJour, rappelsDe, RAPPELS_DEFAUT, reglesPlateformeDe, REGLES_PLATEFORME_DEFAUT, repartitionCagnotte } = await import('../src/commun/cotisations.js');
const { tontineAdhererSchema, tontineCreerSchema, tontineRappelsSchema } = await import('../src/validators/schemas.js');
const { creerTontines } = await import('../src/services/cotisations/tontines.js');
const { FONCTIONS_FINANCES, formuleDe, photoManquante } = await import('../src/services/abonnements/offres.js');
const await_module = await import('../src/services/cotisations/approbations.js');
type Deps = import('../src/services/cotisations/tontines.js').DepsTontines;
type Ligne = Record<string, any>;
let horloge = () => Date.now();

function table(uniques: (l: Ligne, t: Ligne[]) => boolean = () => false) {
  const lignes: Ligne[] = [];
  let n = 0;
  const correspond = (l: Ligne, w: Ligne = {}): boolean =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'OR') return (v as Ligne[]).some((x) => correspond(l, x));
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const o = v as Ligne;
        if (o.in) return o.in.includes(l[k]);
        if ('not' in o) return o.not === null ? l[k] != null : l[k] !== o.not;
        if (o.gt) return l[k] > o.gt;
        if (o.lte) return l[k] <= o.lte;
      }
      return l[k] === v;
    });
  return {
    lignes,
    correspond,
    count: async ({ where }: Ligne) => lignes.filter((l) => correspond(l, where)).length,
    create: async ({ data }: Ligne) => {
      const l = { id: `i${++n}${Math.random().toString(36).slice(2, 6)}`, createdAt: new Date(horloge() + n), ...data };
      if (uniques(l, lignes)) throw Object.assign(new Error('doublon'), { code: 'P2002' });
      lignes.push(l);
      return l;
    },
    update: async ({ where, data }: Ligne) => Object.assign(lignes.find((l) => l.id === where.id)!, data),
    findMany: async ({ where }: Ligne = {}) => lignes.filter((l) => correspond(l, where)),
    findFirst: async ({ where }: Ligne = {}) => lignes.find((l) => correspond(l, where)) ?? null,
    deleteMany: async ({ where }: Ligne) => {
      const avant = lignes.length;
      for (let i = lignes.length - 1; i >= 0; i--) if (correspond(lignes[i], where)) lignes.splice(i, 1);
      return { count: avant - lignes.length };
    },
    updateMany: async ({ where, data }: Ligne) => {
      const t = lignes.filter((l) => correspond(l, where));
      t.forEach((l) => Object.assign(l, data));
      return { count: t.length };
    },
  };
}

function baseMemoire() {
  const tontines = table();
  const membres = table((l, t) => t.some((x) => x.tontineId === l.tontineId && x.userId === l.userId));
  const tours = table();
  const mvts = table((l, t) => {
    const entree = ['caution', 'cotisation'].includes(l.genre);
    if (entree && l.statut === 'en_attente' && t.some((x) => x.membreId === l.membreId && x.statut === 'en_attente' && ['caution', 'cotisation'].includes(x.genre))) return true;
    if (l.genre === 'versement' && t.some((x) => x.genre === 'versement' && x.tourId === l.tourId && ['en_attente', 'paye'].includes(x.statut))) return true;
    if (l.genre === 'caution_rendue' && t.some((x) => x.genre === 'caution_rendue' && x.membreId === l.membreId && ['en_attente', 'paye'].includes(x.statut))) return true;
    return false;
  });
  const roles: Record<string, { nom: string; role: string; photoUrl?: string }> = { orga: { nom: 'Jeereq Takango', role: 'UTILISATEUR' } };
  const complet = (t: Ligne) => ({
    ...t,
    organisateur: roles[t.organisateurId] ?? null,
    membres: membres.lignes.filter((m) => m.tontineId === t.id).map((m) => ({ etat: 'demande', cautionStatut: 'due', rang: null, user: null, ...m })),
    tours: tours.lignes.filter((x) => x.tontineId === t.id).sort((a, b) => a.numero - b.numero).map((x) => ({ especes: 0, ...x })),
    invitations: invitations.lignes.filter((x) => x.tontineId === t.id).sort((a, b) => b.envoyeLe - a.envoyeLe),
  });
  const brut = (l: Ligne) => ({ etat: 'demande', cautionStatut: 'due', rang: null, ...l });
  const alertes = table();
  const signalements = table();
  const invitations = table();
  const db = {
    alerteAnnuaire: alertes,
    signalementTontine: signalements,
    tontineInvitation: invitations,
    tontine: {
      ...tontines,
      create: async ({ data }: Ligne) => tontines.create({ data: { etat: 'ouvert', tourCourant: 0, mode: 'rotation', visibilite: 'public', cautionRequise: true, beneficiaire: null, retireAnnuaireLe: null, ...data } }),
      findUnique: async ({ where }: Ligne) => {
        const t = tontines.lignes.find((x) => (where.codeInvitation ? x.codeInvitation === where.codeInvitation : x.id === where.id));
        return t ? complet(t) : null;
      },
      findMany: async ({ where }: Ligne) => tontines.lignes.filter((t) => tontines.correspond(t, where)).map(complet),
    },
    tontineMembre: {
      ...membres,
      create: async ({ data }: Ligne) => membres.create({ data: { etat: 'demande', cautionStatut: 'due', rang: null, ...data } }),
      findUnique: async ({ where }: Ligne) => {
        const m = membres.lignes.find((x) => x.id === where.id);
        return m ? brut(m) : null;
      },
      findMany: async ({ where }: Ligne) => membres.lignes.filter((m) => membres.correspond(m, where)).map(brut),
    },
    tontineTour: {
      ...tours,
      findUnique: async ({ where }: Ligne) => tours.lignes.find((x) => x.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }: Ligne) => tours.lignes.find((x) => x.id === where.id)!,
      findMany: async ({ where, include }: Ligne) =>
        tours.lignes.filter((x) => tours.correspond(x, where)).map((x) => (include ? { ...x, tontine: tontines.lignes.find((t) => t.id === x.tontineId) } : x)),
    },
    tontineMouvement: {
      ...mvts,
      create: async ({ data }: Ligne) => mvts.create({ data: { commande: null, message: null, ...data } }),
      findMany: async ({ where }: Ligne) => mvts.lignes.filter((m) => mvts.correspond(m, where)),
      findFirst: async ({ where }: Ligne) => mvts.lignes.find((m) => mvts.correspond(m, where)) ?? null,
    },
  };
  return { db: db as unknown as Deps['db'], tontines, membres, tours, mvts, roles, alertes, signalements, invitations };
}

describe('calculs des tontines', () => {
  it('retient 5 % sur la cagnotte', () => {
    assert.deepEqual(repartitionCagnotte(1000, 10), { brut: 10000, commission: 500, net: 9500 });
    assert.deepEqual(repartitionCagnotte(333, 3), { brut: 999, commission: 50, net: 949 });
  });
  it('calcule les échéances selon le rythme', () => {
    assert.deepEqual(echeancesTontine('quotidien', '2026-11-30', 2), ['2026-12-01', '2026-12-02']);
    assert.deepEqual(echeancesTontine('hebdomadaire', '2026-11-06', 2), ['2026-11-13', '2026-11-20']);
    assert.deepEqual(echeancesTontine('mensuel', '2027-01-31', 3), ['2027-02-28', '2027-03-31', '2027-04-30']);
  });
  it('exige les conditions acceptées et un dossier complet', () => {
    assert.equal(tontineAdhererSchema.safeParse({ params: { id: 'x' }, body: {} }).success, false);
    assert.equal(tontineAdhererSchema.safeParse({ params: { id: 'x' }, body: { accepte: true } }).success, true);
    const base = { nom: 'Groupe', montant: 1000, devise: 'USD', rythme: 'quotidien', places: 3, mode: 'rotation', visibilite: 'public', accepte: true };
    assert.equal(tontineCreerSchema.safeParse({ body: base }).success, true);
    assert.equal(tontineCreerSchema.safeParse({ body: { ...base, accepte: false } }).success, false);
    assert.equal(tontineCreerSchema.safeParse({ body: { ...base, places: 1 } }).success, false);
    assert.equal(tontineCreerSchema.safeParse({ body: { ...base, rythme: 'annuel' } }).success, false);
    assert.equal(tontineCreerSchema.safeParse({ body: { ...base, rythme: 'unique' } }).success, false);
    assert.equal(tontineCreerSchema.safeParse({ body: { ...base, visibilite: 'prive' } }).success, false);
    assert.equal(tontineCreerSchema.safeParse({ body: { ...base, mode: 'objectif' } }).success, false);
    assert.equal(tontineCreerSchema.safeParse({ body: { ...base, mode: 'objectif', rythme: 'unique', raison: 'Mariage', beneficiaire: { nom: 'Jean', telephone: '0812345678' }, dateFin: '2026-12-01' } }).success, true);
  });
});

describe('limites de l’admin', () => {
  it('reprennent les valeurs par défaut si le réglage manque ou est faux', () => {
    assert.deepEqual(limitesDe(null), LIMITES_DEFAUT);
    assert.deepEqual(limitesDe({ montantMax: { USD: -5, CDF: 'x' }, membresMax: 1 }), { ...LIMITES_DEFAUT, membresMax: 2 });
    assert.equal(limitesDe({ membresMax: 999 }).membresMax, 200);
    assert.equal(limitesDe({ montantMax: { USD: 5000 } }).montantMax.USD, 5000);
  });
});

describe('rappels de groupe', () => {
  it('sont dus aux jours choisis', () => {
    const r = { avant: [3, 0], apres: [1], mail: true, sms: false };
    assert.equal(rappelDuJour(r, '2026-11-07', '2026-11-10'), 'avant:3');
    assert.equal(rappelDuJour(r, '2026-11-08', '2026-11-10'), null);
    assert.equal(rappelDuJour(r, '2026-11-10', '2026-11-10'), 'avant:0');
    assert.equal(rappelDuJour(r, '2026-11-11', '2026-11-10'), 'apres:1');
    assert.equal(rappelDuJour(r, '2026-11-12', '2026-11-10'), null);
  });
  it('gardent toujours au moins un rappel', () => {
    assert.deepEqual(rappelsDe(null), RAPPELS_DEFAUT);
    assert.deepEqual(rappelsDe({ avant: [], apres: [], mail: false, sms: false }), { ...RAPPELS_DEFAUT, mail: false, sms: false });
    assert.deepEqual(rappelsDe({ avant: [99, 3], apres: [99], mail: true, sms: true }), { avant: [3], apres: [], mail: true, sms: true });
    assert.equal(tontineRappelsSchema.safeParse({ params: { id: 'x' }, body: { avant: [], apres: [], mail: true, sms: true } }).success, false);
    assert.equal(tontineRappelsSchema.safeParse({ params: { id: 'x' }, body: { avant: [1], apres: [], mail: false, sms: false } }).success, true);
  });
});

describe('accès aux cotisations', () => {
  it('créer, rejoindre et demander l’approbation exigent au moins Finances ; payer reste ouvert', () => {
    const routes = readFileSync(new URL('../src/routes/tontine.routes.ts', import.meta.url), 'utf8');
    for (const r of ["post('/',", "post('/:id/adherer',", "post('/invitation/:code',", "post('/eligibilite',", "post('/eligibilite/code',", "post('/eligibilite/confirmer',"]) {
      const ligne = routes.split('\n').find((l) => l.includes(r));
      assert.ok(ligne?.includes("requireFonction('cotisations')"), r);
    }
    assert.equal(routes.split('\n').find((l) => l.includes("post('/:id/payer',"))?.includes('requireFonction'), false);
  });
  it('les options de Finances demandent une photo de profil, sauf pour les admins', () => {
    assert.equal(photoManquante({ role: 'UTILISATEUR', photoUrl: null }, 'cotisations'), true);
    assert.equal(photoManquante({ role: 'UTILISATEUR', photoUrl: 'https://x/p.jpg' }, 'cotisations'), false);
    assert.equal(photoManquante({ role: 'ADMIN', photoUrl: null }, 'cotisations'), false);
    assert.equal(photoManquante({ role: 'UTILISATEUR', photoUrl: null }, 'assistant'), false);
  });
  it('Gratuit n’y a pas droit, Finances et Pro oui', () => {
    assert.equal(formuleDe('cotisations'), 'finances');
    assert.ok(FONCTIONS_FINANCES.cotisations);
  });
});

describe('une tontine de bout en bout', () => {
  const ADMIN = { id: 'admin', nom: 'Admin', admin: true };
  let b: ReturnType<typeof baseMemoire>;
  let s: ReturnType<typeof creerTontines>;
  let demandes: Ligne[];
  let versements: Ligne[];
  let etats: Map<string, { etat: 'paye' | 'echoue' | 'en_attente'; montant?: string; devise?: string }>;
  let ouvert: (role: string | null) => boolean;
  let api: boolean;
  let avis: { userId: string; telephone: string | null; cle: string; titre: string; seul?: boolean; mode?: unknown }[];
  let vus: Set<string>;
  let instant: number;
  let approuves: Set<string>;
  let limites: { montantMax: { USD: number; CDF: number }; membresMax: number };
  let invitations: Ligne[];
  // Les anciens tests : 5 % partout, et chaque membre lance son paiement.
  let cadre = reglesPlateformeDe({ prive: { demandes: 'tous' }, public: { commissionBps: 500, demandes: 'tous' } });
  const JOUR = 86400000;
  const orga = { id: 'orga', nom: 'Jeereq Takango', fuseau: 'Africa/Kinshasa', telephone: '243812345670' };
  const paul = { id: 'paul', nom: 'Paul Kasongo', fuseau: 'Africa/Kinshasa', telephone: '243812345671' };
  const marie = { id: 'marie', nom: 'Marie Kabila', fuseau: 'Africa/Kinshasa', telephone: '243812345672' };
  const invite = { id: 'invite', nom: 'Sarah Tshibanda', fuseau: 'Africa/Kinshasa', telephone: null };

  beforeEach(() => {
    b = baseMemoire();
    demandes = [];
    versements = [];
    etats = new Map();
    ouvert = () => true;
    api = false;
    avis = [];
    vus = new Set();
    instant = Date.UTC(2026, 10, 6, 12);
    horloge = () => instant;
    approuves = new Set(['orga', 'paul', 'marie']);
    limites = limitesDe(null);
    invitations = [];
    cadre = reglesPlateformeDe({ prive: { demandes: 'tous' }, public: { commissionBps: 500, demandes: 'tous' } });
    s = creerTontines({
      db: b.db,
      flexpaie: {
        demander: async (p) => {
          demandes.push(p);
          return { commande: `C${demandes.length}` };
        },
        verser: async (p) => {
          versements.push(p);
          return { commande: `V${versements.length}` };
        },
        verifier: async (commande) => {
          const e = etats.get(commande) ?? { etat: 'en_attente' as const };
          return { etat: e.etat, transaction: e.montant ? { amount: e.montant, currency: e.devise ?? 'USD' } : null, message: '' };
        },
      },
      paiementOuvert: (r) => ouvert(r),
      versementApi: () => api,
      flexpaiePret: () => true,
      adresseServeur: () => 'https://api.test',
      exigerNumero: async () => {},
      avertir: async (userId, telephone, a, mode) => {
        const nouveau = !vus.has(`${userId}|${a.cle}`);
        vus.add(`${userId}|${a.cle}`);
        if (nouveau) avis.push({ userId, telephone, cle: a.cle, titre: a.titre, url: a.url, seul: mode === true, mode });
        return { nouveau, mail: nouveau, sms: nouveau };
      },
      comptesApprouves: async (ids) => new Set(ids.filter((x) => approuves.has(x))),
      adresseApp: () => 'https://app.test',
      limites: async () => limites,
      envoyerInvitation: async (_u, c) => {
        invitations.push(c);
        return { mail: false, sms: true };
      },
      responsablesVersements: async () => ['admin'],
      reglesPlateforme: async () => cadre,
      maintenant: () => instant,
      // Tirage fixe : l'ordre reste celui de la liste.
      tirer: (max) => max - 1,
    });
  });

  const creer = () => s.creer(orga, { nom: 'Famille', montant: 1000, devise: 'USD', rythme: 'quotidien', places: 3, mode: 'rotation', visibilite: 'public' });
  /** Le dernier paiement demandé est validé chez FlexPaie, puis annoncé par son retour. */
  async function valider(montant = '10.00') {
    const m = b.mvts.lignes.at(-1)!;
    etats.set(m.commande, { etat: 'paye', montant });
    await s.retour({ orderNumber: m.commande });
  }
  async function complet() {
    const { groupe } = await creer();
    await s.adherer(paul, groupe.id);
    await s.adherer(marie, groupe.id);
    for (const m of (await s.detail('orga', groupe.id)).groupe.demandes) await s.decider('orga', m.id, true);
    for (const u of ['orga', 'paul', 'marie']) {
      await s.payer(u, groupe.id, 'caution');
      await valider();
    }
    return groupe.id;
  }
  async function cotiserTous(id: string) {
    for (const u of ['orga', 'paul', 'marie']) {
      await s.payer(u, id, 'cotisation');
      await valider();
    }
  }

  it('va de la création à la fin, et garde exactement 5 %', async () => {
    const id = await complet();
    const apres = await s.demarrer('orga', id);
    assert.equal(apres.groupe.etat, 'en_cours');
    assert.equal(apres.groupe.tours.length, 3);
    assert.equal(apres.groupe.tours[0].net, 2850);
    assert.equal(new Set(apres.groupe.tours.map((x) => x.beneficiaire)).size, 3);

    for (let tour = 1; tour <= 3; tour++) {
      const g = (await s.detail('paul', id)).groupe;
      assert.equal(g.tourCourant, tour);
      assert.equal(g.aPayer?.genre, 'cotisation');
      await s.payer('orga', id, 'cotisation');
      await valider();
      // Tant que tout le monde n'a pas payé, rien ne peut être versé.
      const t = b.tours.lignes.find((x) => x.numero === tour)!;
      await assert.rejects(s.verserTour(ADMIN, t.id, 'REF123'), /n’attend pas/);
      await s.payer('paul', id, 'cotisation');
      await valider();
      await s.payer('marie', id, 'cotisation');
      await valider();
      assert.equal(t.etat, 'a_verser');
      // Sans preuve, pas de versement manuel, et jamais deux fois.
      await assert.rejects(s.verserTour(ADMIN, t.id), /référence/);
      await s.verserTour(ADMIN, t.id, 'REF123');
      assert.equal(t.etat, 'verse');
      assert.equal(t.valideParNom, 'Admin');
      await assert.rejects(s.verserTour(ADMIN, t.id, 'REF123'), /n’attend pas/);
    }

    assert.equal(b.tontines.lignes[0].etat, 'termine');
    const r = await s.resumeAdmin();
    assert.equal(r.cautions.length, 3);
    assert.deepEqual(r.totaux, [{ devise: 'USD', detenu: 3000 + 9000 - 8550, commission: 450 }]);
    for (const c of r.cautions) await s.rendreCaution(ADMIN, c.membreId, 'REF999');
    await assert.rejects(s.rendreCaution(ADMIN, r.cautions[0].membreId, 'REF999'), /pas à rendre/);
    const fin = await s.resumeAdmin();
    // Tout a été rendu : il ne reste que la commission.
    assert.deepEqual(fin.totaux, [{ devise: 'USD', detenu: 450, commission: 450 }]);
    assert.equal(fin.cautions.length, 0);
  });

  it('paiements fermés : pas de demande ni de démarrage', async () => {
    const id = await complet();
    ouvert = () => false;
    const n = demandes.length;
    await assert.rejects(s.demarrer('orga', id), /pas encore ouvert/);
    await assert.rejects(s.payer('paul', id, 'cotisation'), /pas encore ouvert/);
    assert.equal(demandes.length, n);
  });

  it('refuse de démarrer un groupe incomplet ou sans cautions', async () => {
    const { groupe } = await creer();
    await assert.rejects(s.demarrer('orga', groupe.id), /pas complet/);
    await s.adherer(paul, groupe.id);
    await s.adherer(marie, groupe.id);
    for (const m of (await s.detail('orga', groupe.id)).groupe.demandes) await s.decider('orga', m.id, true);
    await assert.rejects(s.demarrer('orga', groupe.id), /cautions/);
    await assert.rejects(s.demarrer('paul', groupe.id), /organisateur/);
  });

  it('protège les données et les gestes réservés', async () => {
    const id = await complet();
    await s.demarrer('orga', id);
    const inconnu = (await s.detail('intrus', id)).groupe;
    assert.deepEqual(inconnu.membres, []);
    assert.deepEqual(inconnu.tours, []);
    assert.equal(inconnu.moi, null);
    const vue = JSON.stringify((await s.detail('paul', id)).groupe);
    assert.equal(vue.includes('812345670'), false);
    assert.equal(vue.includes('812345672'), false);
    assert.equal((await s.detail('paul', id)).groupe.demandes.length, 0);
    await assert.rejects(s.payer('intrus', id, 'cotisation'), /pas membre/);
    const m = b.membres.lignes.find((x) => x.userId === 'marie')!;
    await assert.rejects(s.rappeler('paul', m.id), /organisateur/);
    await assert.rejects(s.utiliserCaution('paul', m.id), /organisateur/);
    assert.equal(JSON.stringify(b.membres.lignes[0].contact).includes('812345670'), false);
  });

  it('une demande refusée ou un groupe plein ferme l’adhésion', async () => {
    const { groupe } = await creer();
    await s.adherer(paul, groupe.id);
    const d = (await s.detail('orga', groupe.id)).groupe.demandes[0];
    await s.decider('orga', d.id, false);
    await assert.rejects(s.adherer(paul, groupe.id), /refusé/);
    approuves.delete('marie');
    await assert.rejects(s.adherer(marie, groupe.id), /approuver/);
    approuves.add('marie');
    assert.equal((await s.annuaire('marie')).groupes.length, 1);
  });

  it('rien n’est crédité sans vérification, ni si le montant diffère', async () => {
    const { groupe } = await creer();
    await s.payer('orga', groupe.id, 'caution');
    const m = b.mvts.lignes[0];
    await s.retour({ orderNumber: m.commande, status: '0', amount: '10.00' });
    assert.equal(m.statut, 'en_attente');
    assert.equal(b.membres.lignes[0].cautionStatut, 'due');
    await valider('1.00');
    assert.equal(m.statut, 'echoue');
    assert.equal(b.membres.lignes[0].cautionStatut, 'due');
    assert.equal((await s.detail('orga', groupe.id)).groupe.refus, true);
  });

  it('un double clic ne crée qu’une demande, et 5 par jour au maximum', async () => {
    const { groupe } = await creer();
    await s.payer('orga', groupe.id, 'caution');
    await s.payer('orga', groupe.id, 'caution');
    assert.equal(demandes.length, 1);
    await s.abandonner('orga', groupe.id);
    for (let i = 0; i < 4; i++) {
      await s.payer('orga', groupe.id, 'caution');
      await s.abandonner('orga', groupe.id);
    }
    assert.equal(demandes.length, 5);
    await assert.rejects(s.payer('orga', groupe.id, 'caution'), /Trop de demandes/);
  });

  it('un paiement abandonné puis validé n’est pas redemandé', async () => {
    const { groupe } = await creer();
    await s.payer('orga', groupe.id, 'caution');
    await s.abandonner('orga', groupe.id);
    etats.set('C1', { etat: 'paye', montant: '10.00' });
    await s.payer('orga', groupe.id, 'caution');
    assert.equal(demandes.length, 1);
    assert.equal(b.membres.lignes[0].cautionStatut, 'payee');
  });

  it('la caution couvre un impayé après l’échéance, une seule fois', async () => {
    const id = await complet();
    await s.demarrer('orga', id);
    const m = b.membres.lignes.find((x) => x.userId === 'marie')!;
    await s.payer('orga', id, 'cotisation');
    await valider();
    await s.payer('paul', id, 'cotisation');
    await valider();
    await assert.rejects(s.utiliserCaution('orga', m.id), /pas encore passée/);
    instant += 2 * JOUR;
    await s.utiliserCaution('orga', m.id);
    assert.equal(m.cautionStatut, 'utilisee');
    assert.equal(b.tours.lignes[0].etat, 'a_verser');
    assert.ok(avis.some((a) => a.userId === 'marie' && /caution a couvert/.test(a.titre)));
    // Le tour suivant : Marie doit cotiser, puis refaire sa caution.
    await s.verserTour(ADMIN, b.tours.lignes[0].id, 'REF123');
    assert.equal((await s.detail('marie', id)).groupe.aPayer?.genre, 'cotisation');
    await s.payer('marie', id, 'cotisation');
    await valider();
    assert.equal((await s.detail('marie', id)).groupe.aPayer?.genre, 'caution');
    // Marie ne refait pas sa caution et rate le tour suivant : plus rien ne la couvre.
    await s.payer('orga', id, 'cotisation');
    await valider();
    await s.payer('paul', id, 'cotisation');
    await valider();
    await s.verserTour(ADMIN, b.tours.lignes[1].id, 'REF124');
    instant += 3 * JOUR;
    await assert.rejects(s.utiliserCaution('orga', m.id), /plus de caution/);
    assert.equal(b.tours.lignes[2].etat, 'collecte');
    await assert.rejects(s.verserTour(ADMIN, b.tours.lignes[2].id, 'REF125'), /n’attend pas/);
  });

  it('quitter ou annuler avant le démarrage rend la caution ; après, non', async () => {
    const { groupe } = await creer();
    await s.adherer(paul, groupe.id);
    const d = (await s.detail('orga', groupe.id)).groupe.demandes[0];
    await s.decider('orga', d.id, true);
    await s.payer('paul', groupe.id, 'caution');
    await valider();
    await s.quitter('paul', groupe.id);
    const p = b.membres.lignes.find((x) => x.userId === 'paul')!;
    assert.equal(p.etat, 'parti');
    assert.equal(p.cautionStatut, 'a_rendre');
    await assert.rejects(s.quitter('orga', groupe.id), /Annule/);
    await s.payer('orga', groupe.id, 'caution');
    await valider();
    await s.annuler('orga', groupe.id);
    assert.equal(b.membres.lignes[0].cautionStatut, 'a_rendre');

    const id2 = await complet();
    await s.demarrer('orga', id2);
    await assert.rejects(s.quitter('paul', id2), /a démarré/);
    await assert.rejects(s.annuler('orga', id2), /a démarré/);
  });

  it('versement par API : compte seulement après vérification, jamais deux fois', async () => {
    api = true;
    const id = await complet();
    await s.demarrer('orga', id);
    await cotiserTous(id);
    const t = b.tours.lignes[0];
    await s.verserTour(ADMIN, t.id);
    assert.equal(versements.length, 1);
    assert.equal(versements[0].montant, 2850);
    assert.equal(t.etat, 'a_verser');
    await assert.rejects(s.verserTour(ADMIN, t.id), /déjà en cours/);
    assert.equal(versements.length, 1);
    etats.set('V1', { etat: 'paye', montant: '28.50' });
    await s.retour({ orderNumber: 'V1' });
    assert.equal(t.etat, 'verse');
    assert.equal(b.tours.lignes[1].etat, 'collecte');
  });

  it('une sortie sans réponse reste en attente, sans jamais expirer', async () => {
    api = true;
    const id = await complet();
    await s.demarrer('orga', id);
    await cotiserTous(id);
    await s.verserTour(ADMIN, b.tours.lignes[0].id);
    await s.rattraper(instant + 3 * JOUR);
    assert.equal(b.mvts.lignes.at(-1)!.statut, 'en_attente');
  });

  it('envoie chaque avis une seule fois, sur le numéro du membre', async () => {
    const id = await complet();
    await s.demarrer('orga', id);
    const m = b.membres.lignes.find((x) => x.userId === 'paul')!;
    assert.equal((await s.rappeler('orga', m.id)).nouveau, true);
    assert.equal((await s.rappeler('orga', m.id)).nouveau, false);
    instant += JOUR;
    assert.equal((await s.rappeler('orga', m.id)).nouveau, true);
    assert.equal(avis.find((a) => a.userId === 'paul' && a.cle.startsWith('tontine:rappel'))?.telephone, '243812345671');

    avis = [];
    await s.rattraper(instant);
    await s.rattraper(instant);
    const relances = avis.filter((a) => a.cle.startsWith('tontine:echeance'));
    assert.equal(relances.length, 3);
    await s.payer('paul', id, 'cotisation');
    await valider();
    avis = [];
    instant += JOUR;
    await s.rattraper(instant);
    assert.deepEqual(avis.filter((a) => a.cle.includes(':apres:1')).map((a) => a.userId).sort(), ['marie', 'orga']);
  });

  it('annuaire : seuls les groupes publics des comptes approuvés sont visibles', async () => {
    await creer();
    await s.creer(orga, { nom: 'Privé', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 3, mode: 'rotation', visibilite: 'prive', telephone: '0812345670' });
    assert.deepEqual((await s.annuaire('marie')).groupes.map((g) => g.nom), ['Famille']);
    approuves.delete('orga');
    assert.deepEqual((await s.annuaire('marie')).groupes, []);
    await assert.rejects(s.creer(orga, { nom: 'Autre', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 3, mode: 'rotation', visibilite: 'public' }), /approuver/);
  });

  it('groupe privé : invitation sans approbation, caution au choix, initiateur qui paie pour un membre', async () => {
    const { groupe } = await s.creer(orga, { nom: 'Amis', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 2, mode: 'rotation', visibilite: 'prive', cautionRequise: false, telephone: '0812345670' });
    assert.equal(groupe.cautionRequise, false);
    assert.equal(groupe.aPayer, null);
    const code = b.tontines.lignes[0].codeInvitation;
    assert.match(code, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(groupe.lienInvitation, `https://app.test/g/${code}`);
    await assert.rejects(s.adherer(paul, groupe.id), /introuvable/);
    assert.equal((await s.invitation(code)).groupe.nom, 'Amis');
    await s.inviter('orga', groupe.id, '0812345673');
    assert.match(invitations[0].texte, new RegExp(`/g/${code}`));
    await assert.rejects(s.inviter('paul', groupe.id, '0812345673'), /organisateur/);
    const r = await s.rejoindreParInvitation(invite, code, '0812345673');
    assert.equal(r.groupe.monEtat, 'accepte');
    await assert.rejects(s.rejoindreParInvitation(marie, code, '0812345672'), /complet/);
    await assert.rejects(s.invitation('inconnu'), /plus valable/);
    await s.demarrer('orga', groupe.id);
    assert.equal(b.tontines.lignes[0].etat, 'en_cours');
    await assert.rejects(s.invitation(code), /plus valable/);
    await s.payer('orga', groupe.id, 'cotisation');
    await valider();
    const m = b.membres.lignes.find((x) => x.userId === 'invite')!;
    // Le paiement part vers le numéro de l'initiateur, et compte pour le membre.
    await s.payerPourMembre('orga', m.id);
    assert.equal(demandes.at(-1)!.telephone, '243812345670');
    await valider();
    assert.equal(b.tours.lignes[0].etat, 'a_verser');
    await assert.rejects(s.payerPourMembre('invite', m.id), /organisateur/);
  });

  it('rotation publique : la caution reste obligatoire', async () => {
    const { groupe } = await s.creer(orga, { nom: 'Pub', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 2, mode: 'rotation', visibilite: 'public', cautionRequise: false });
    assert.equal(groupe.cautionRequise, true);
    assert.equal(groupe.aPayer?.genre, 'caution');
  });

  const objectif = (extra = {}) => s.creer(orga, { nom: 'Mariage', montant: 1000, devise: 'USD', rythme: 'hebdomadaire', places: 3, mode: 'objectif', visibilite: 'prive', telephone: '0812345670', raison: 'Mariage de Jean', beneficiaire: { nom: 'Jean Mbuyi', telephone: '0812345679' }, dateFin: '2026-11-20', ...extra });

  it('raison précise : ouverte tout de suite, sans caution ni tirage, bénéficiaire chiffré', async () => {
    const { groupe } = await objectif();
    assert.equal(groupe.etat, 'en_cours');
    assert.equal(groupe.cautionRequise, false);
    assert.equal(groupe.beneficiaireNom, 'Jean Mbuyi');
    assert.equal(groupe.totalPrevu, 1000 * 3 * 2);
    assert.deepEqual(b.tours.lignes.map((x) => [x.numero, x.echeance, x.etat]), [[1, '2026-11-13', 'collecte'], [2, '2026-11-20', 'a_venir']]);
    assert.equal(JSON.stringify(b.tontines.lignes[0].beneficiaire).includes('812345679'), false);
    assert.equal(JSON.stringify((await s.detail('orga', groupe.id)).groupe).includes('812345679'), false);
    await assert.rejects(s.demarrer('orga', groupe.id), /déjà ouverte/);
    await assert.rejects(objectif({ dateFin: '2026-11-01' }), /date de fin/);
    await assert.rejects(objectif({ beneficiaire: { nom: 'Jean', telephone: '12' } }), /bénéficiaire/);
  });

  it('raison précise : à la date de fin, le bénéficiaire reçoit ce qui a été payé, moins 5 %', async () => {
    const { groupe } = await objectif();
    const code = b.tontines.lignes[0].codeInvitation;
    await s.rejoindreParInvitation(invite, code, '0812345673');
    await s.payer('orga', groupe.id, 'cotisation');
    await valider();
    assert.equal((await s.detail('orga', groupe.id)).groupe.aPayer, null);
    instant = Date.UTC(2026, 10, 14, 12);
    await s.rattraper(instant);
    assert.equal(b.tours.lignes[1].etat, 'collecte');
    await s.payer('invite', groupe.id, 'cotisation');
    await valider();
    // Une demande reste en attente quand la date passe : la clôture l'attend.
    instant = Date.UTC(2026, 10, 20, 22);
    await s.payer('invite', groupe.id, 'cotisation');
    instant = Date.UTC(2026, 10, 21, 2);
    await s.rattraper(instant);
    assert.equal(b.tours.lignes.some((x) => x.numero === 0), false);
    await valider();
    await s.rattraper(instant);
    const final = b.tours.lignes.find((x) => x.numero === 0)!;
    assert.equal(final.brut, 3000);
    assert.equal(final.commission, 150);
    assert.equal(final.net, 2850);
    assert.equal((await s.detail('invite', groupe.id)).groupe.aPayer, null);
    await assert.rejects(s.payer('orga', groupe.id, 'cotisation').then(() => {
      if (demandes.length > 3) throw new Error('clôturée');
    }).then(() => {
      throw new Error('aucune demande');
    }), /aucune demande/);
    const r = await s.resumeAdmin();
    assert.equal(r.versements[0].beneficiaire, 'Jean Mbuyi');
    assert.equal(r.versements[0].telephone, '243812345679');
    assert.equal(r.versements[0].raison, 'Mariage de Jean');
    await s.verserTour(ADMIN, final.id, 'REF321');
    assert.equal(b.tontines.lignes[0].etat, 'termine');
    assert.deepEqual((await s.resumeAdmin()).totaux, [{ devise: 'USD', detenu: 150, commission: 150 }]);
  });

  it('raison précise : sans paiement, rien à verser ; annulation refusée après un paiement', async () => {
    const a = await objectif();
    const c = await objectif({ nom: 'Autre' });
    await s.annuler('orga', c.groupe.id);
    assert.equal(b.tontines.lignes[1].etat, 'annule');
    await s.payer('orga', a.groupe.id, 'cotisation');
    await valider();
    await assert.rejects(s.annuler('orga', a.groupe.id), /date de fin/);
    const d2 = await objectif({ nom: 'Vide' });
    instant += 30 * JOUR;
    await s.rattraper(instant);
    assert.equal(b.tontines.lignes.find((t) => t.id === d2.groupe.id)!.etat, 'termine');
  });

  it('raison précise : un membre arrivé plus tard ne doit que les périodes à venir', async () => {
    const { groupe } = await objectif();
    instant += 8 * JOUR;
    await s.rattraper(instant);
    const code = b.tontines.lignes[0].codeInvitation;
    await s.rejoindreParInvitation(invite, code, '0812345673');
    await s.payer('invite', groupe.id, 'cotisation');
    assert.equal(b.mvts.lignes.at(-1)!.tourId, b.tours.lignes[1].id);
  });

  it('retirer un membre : caution à rendre, et impossible après le démarrage', async () => {
    const { groupe } = await s.creer(orga, { nom: 'Amis', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 2, mode: 'rotation', visibilite: 'prive', telephone: '0812345670' });
    const code = b.tontines.lignes[0].codeInvitation;
    await s.rejoindreParInvitation(invite, code, '0812345673');
    await s.payer('invite', groupe.id, 'caution');
    await valider();
    const m = b.membres.lignes.find((x) => x.userId === 'invite')!;
    await assert.rejects(s.retirer('invite', m.id), /organisateur/);
    await s.retirer('orga', m.id);
    assert.equal(m.etat, 'refuse');
    assert.equal(m.cautionStatut, 'a_rendre');
    await assert.rejects(s.rejoindreParInvitation(invite, code, '0812345673'), /retiré/);
  });

  it('rappels obligatoires : réglés par l’initiateur, envoyés à l’heure, sur ses canaux', async () => {
    const id = await complet();
    await s.demarrer('orga', id);
    await assert.rejects(s.reglerRappels('paul', id, { avant: [3], apres: [], mail: false, sms: true }), /organisateur/);
    const r = await s.reglerRappels('orga', id, { avant: [0], apres: [], mail: false, sms: true });
    assert.deepEqual(r.groupe.rappels, { avant: [0], apres: [], mail: false, sms: true });
    avis = [];
    // Échéance du tour 1 : le 7 novembre. Pas de rappel la veille, ni avant 8 h (heure de Kinshasa).
    await s.rattraper(Date.UTC(2026, 10, 6, 15));
    assert.equal(avis.filter((a) => a.cle.startsWith('tontine:echeance')).length, 0);
    await s.rattraper(Date.UTC(2026, 10, 7, 5));
    assert.equal(avis.filter((a) => a.cle.startsWith('tontine:echeance')).length, 0);
    instant = Date.UTC(2026, 10, 7, 8);
    await s.rattraper(instant);
    const envoyes = avis.filter((a) => a.cle.startsWith('tontine:echeance'));
    assert.equal(envoyes.length, 3);
    assert.deepEqual(envoyes[0].mode, { mail: false, sms: true });
    await s.rattraper(instant);
    assert.equal(avis.filter((a) => a.cle.startsWith('tontine:echeance')).length, 3);
  });

  it('annuaire : filtre par type, rythme, devise et montant', async () => {
    const base = { places: 3, mode: 'rotation', visibilite: 'public' } as const;
    await s.creer(orga, { ...base, nom: 'Petit', montant: 500, devise: 'USD', rythme: 'quotidien' });
    await s.creer(orga, { ...base, nom: 'Grand', montant: 5000, devise: 'USD', rythme: 'mensuel' });
    await s.creer(orga, { ...base, nom: 'Franc', montant: 500000, devise: 'CDF', rythme: 'mensuel' });
    const noms = async (f: object) => (await s.annuaire(null, f)).groupes.map((g) => g.nom).sort();
    assert.deepEqual(await noms({ rythme: 'mensuel' }), ['Franc', 'Grand']);
    assert.deepEqual(await noms({ devise: 'USD', montantMax: 1000 }), ['Petit']);
    assert.deepEqual(await noms({ mode: 'objectif' }), []);
    assert.deepEqual(await noms({ q: 'fra' }), ['Franc']);
  });

  it('annuaire public : lisible sans compte, sans photo ni groupe privé', async () => {
    b.roles.orga.photoUrl = 'https://x/p.jpg';
    await creer();
    await s.creer(orga, { nom: 'Privé', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 3, mode: 'rotation', visibilite: 'prive', telephone: '0812345670' });
    const r = await s.annuaire(null);
    assert.deepEqual(r.groupes.map((g) => g.nom), ['Famille']);
    assert.equal(r.groupes[0].organisateur, 'Jeereq');
    assert.equal(r.groupes[0].organisateurPhoto, null);
    assert.equal(r.groupes[0].monEtat, null);
    assert.equal(JSON.stringify(r).includes('812345'), false);
    assert.equal((await s.annuaire('marie')).groupes[0].organisateurPhoto, 'https://x/p.jpg');
  });

  it('annuaire : trie, et masque les groupes déjà démarrés sur demande', async () => {
    const base = { places: 3, mode: 'rotation', visibilite: 'public', devise: 'USD', rythme: 'mensuel' } as const;
    await s.creer(orga, { ...base, nom: 'Cher', montant: 5000 });
    await s.creer(orga, { ...base, nom: 'Petit', montant: 500 });
    const presque = await s.creer(orga, { ...base, nom: 'Presque', montant: 1000 });
    await s.adherer(paul, presque.groupe.id);
    await s.decider('orga', b.membres.lignes.find((m) => m.userId === 'paul')!.id, true);
    const noms = async (f: object) => (await s.annuaire(null, f)).groupes.map((g) => g.nom);
    assert.deepEqual(await noms({}), ['Presque', 'Petit', 'Cher']);
    assert.deepEqual(await noms({ tri: 'montant' }), ['Petit', 'Presque', 'Cher']);
    assert.equal((await noms({ tri: 'places' }))[0], 'Presque');
    b.tontines.lignes.find((t) => t.nom === 'Cher')!.etat = 'en_cours';
    assert.deepEqual(await noms({ ouverts: true }), ['Presque', 'Petit']);
  });

  it('annuaire : la page d’un groupe, et ce qu’on sait de l’organisateur', async () => {
    b.roles.orga.photoUrl = 'https://x/p.jpg';
    const { groupe } = await creer();
    const pub = (await s.groupeAnnuaire(null, groupe.id)).groupe;
    assert.equal(pub.nom, 'Famille');
    assert.equal(pub.organisateurPhoto, null);
    assert.equal(pub.lien, `https://app.test/annuaire/famille-${groupe.id}`);
    assert.deepEqual(pub.confiance, { termines: 0, versements: 0, aTemps: 0, depuis: null });
    const ancien = b.tontines.lignes[0];
    b.tontines.lignes.push({ ...ancien, id: 'vieux', etat: 'termine', nom: 'Vieux' });
    b.tours.lignes.push({ id: 't1', tontineId: 'vieux', numero: 1, etat: 'verse', echeance: '2026-10-01', valideLe: new Date('2026-10-02T10:00:00Z') });
    b.tours.lignes.push({ id: 't2', tontineId: 'vieux', numero: 2, etat: 'verse', echeance: '2026-10-08', valideLe: new Date('2026-10-20T10:00:00Z') });
    const c = (await s.annuaire(null)).groupes.find((g) => g.nom === 'Famille')!.confiance;
    assert.deepEqual(c, { termines: 1, versements: 2, aTemps: 1, depuis: null });
    await assert.rejects(s.groupeAnnuaire(null, 'inconnu'), /plus dans l’annuaire/);
    approuves.delete('orga');
    await assert.rejects(s.groupeAnnuaire(null, groupe.id), /plus dans l’annuaire/);
    assert.equal((await s.groupeAnnuaire('orga', groupe.id)).groupe.nom, 'Famille');
  });

  it('alertes : prévient dans l’app quand un nouveau groupe correspond', async () => {
    await s.creerAlerte('paul', { rythme: 'mensuel', devise: 'USD', montantMax: 2000 });
    await s.creerAlerte('paul', { rythme: 'mensuel', devise: 'USD', montantMax: 2000 });
    await s.creerAlerte('marie', { q: 'famille' });
    await s.creerAlerte('orga', {});
    assert.equal((await s.mesAlertes('paul')).alertes.length, 1);
    await s.creer(orga, { nom: 'Famille', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 3, mode: 'rotation', visibilite: 'public' });
    await s.creer(orga, { nom: 'Grand', montant: 9000, devise: 'USD', rythme: 'mensuel', places: 3, mode: 'rotation', visibilite: 'public' });
    await s.creer(orga, { nom: 'Privé', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 3, mode: 'rotation', visibilite: 'prive', telephone: '0812345670' });
    await new Promise((r) => setTimeout(r, 20));
    const alertes = avis.filter((a) => a.cle.startsWith('annuaire:'));
    assert.deepEqual(alertes.map((a) => a.userId).sort(), ['marie', 'paul']);
    assert.equal(alertes.every((a) => a.seul), true);
    for (let i = 0; i < 4; i++) await s.creerAlerte('paul', { q: `g${i}` });
    await assert.rejects(s.creerAlerte('paul', { q: 'trop' }), /5 alertes au maximum/);
    const id = (await s.mesAlertes('paul')).alertes[0].id;
    assert.equal((await s.supprimerAlerte('marie', id)).alertes.length, 1);
    assert.equal((await s.supprimerAlerte('paul', id)).alertes.length, 4);
  });

  it('signalements : l’équipe retire un groupe de l’annuaire, ses membres le gardent', async () => {
    const { groupe } = await creer();
    await assert.rejects(s.signaler('orga', groupe.id, 'arnaque'), /propre groupe/);
    await s.signaler('paul', groupe.id, 'arnaque', 'Demande de payer hors de Me');
    await s.signaler('paul', groupe.id, 'trompeur');
    await s.signaler('marie', groupe.id, 'autre');
    const liste = (await s.adminSignalements()).signalements;
    assert.equal(liste.length, 1);
    assert.equal(liste[0].nombre, 2);
    assert.deepEqual(liste[0].motifs.map((m) => m.motif).sort(), ['autre', 'trompeur']);
    assert.equal((await s.adminDeciderSignalement({ id: 'admin', nom: 'Admin', admin: true }, groupe.id, 'retirer')).signalements.length, 0);
    assert.equal((await s.annuaire(null)).groupes.length, 0);
    await assert.rejects(s.adherer(marie, groupe.id), /plus dans l’annuaire/);
    assert.equal((await s.groupeAnnuaire('orga', groupe.id)).groupe.nom, 'Famille');
    assert.equal(avis.some((a) => a.userId === 'orga' && a.cle === `tontine:retire:${groupe.id}`), true);
    await s.signaler('paul', groupe.id, 'arnaque');
    await s.adminDeciderSignalement({ id: 'admin', nom: 'Admin', admin: true }, groupe.id, 'rejeter');
    assert.equal(b.signalements.lignes.every((x) => x.statut !== 'ouvert'), true);
  });

  it('respecte les limites de l’admin, à la création seulement', async () => {
    const base = { nom: 'G', devise: 'USD', rythme: 'mensuel' as const, mode: 'rotation' as const, visibilite: 'public' as const };
    limites = { montantMax: { USD: 5000, CDF: 900000 }, membresMax: 4 };
    await assert.rejects(s.creer(orga, { ...base, montant: 5001, places: 3 }), /ne peut pas dépasser 50 USD/);
    await assert.rejects(s.creer(orga, { ...base, montant: 1000, places: 5 }), /dépasser 4 membres/);
    await assert.rejects(s.creer(orga, { ...base, devise: 'CDF', montant: 900001, places: 3 }), /ne peut pas dépasser 9 000,01|ne peut pas dépasser 9 000 CDF/);
    assert.equal((await s.creer(orga, { ...base, montant: 5000, places: 4 })).groupe.places, 4);
    limites = { montantMax: { USD: 100, CDF: 100 }, membresMax: 2 };
    assert.equal(b.tontines.lignes[0].places, 4);
  });

  it('refuse une cagnotte que la base ne saurait pas compter', async () => {
    limites = { montantMax: { USD: 100000000, CDF: 100000000 }, membresMax: 200 };
    await assert.rejects(s.creer(orga, { nom: 'G', devise: 'CDF', rythme: 'mensuel', mode: 'rotation', visibilite: 'public', montant: 100000000, places: 50 }), /trop élevée/);
  });

  it('un commercial ne valide jamais pour lui-même, et son nom reste noté', async () => {
    const id = await complet();
    await s.demarrer('orga', id);
    await cotiserTous(id);
    const t = b.tours.lignes[0];
    const benef = b.membres.lignes.find((m) => m.id === t.beneficiaireId)!;
    await assert.rejects(s.verserTour({ id: benef.userId, nom: 'Com', admin: false }, t.id, 'REF123'), /autre responsable/);
    assert.equal(t.etat, 'a_verser');
    await s.verserTour({ id: 'com', nom: 'Fatou Commerciale', admin: false }, t.id, 'REF123');
    assert.equal(t.valideParNom, 'Fatou Commerciale');
    assert.equal(b.mvts.lignes.at(-1)!.validePar, 'Fatou Commerciale');
  });

  it('un initiateur commercial ne valide pas le versement de sa propre raison précise', async () => {
    const { groupe } = await objectif();
    await s.payer('orga', groupe.id, 'cotisation');
    await valider();
    instant = Date.UTC(2026, 10, 25, 12);
    await s.rattraper(instant);
    const final = b.tours.lignes.find((x) => x.numero === 0)!;
    await assert.rejects(s.verserTour({ id: 'orga', nom: 'Jeereq', admin: false }, final.id, 'REF123'), /autre responsable/);
    await s.verserTour(ADMIN, final.id, 'REF123');
    assert.equal(final.etat, 'verse');
  });

  it('un membre ne peut plus rejoindre pendant le remboursement de sa caution', async () => {
    const { groupe } = await creer();
    await s.adherer(paul, groupe.id);
    const d = (await s.detail('orga', groupe.id)).groupe.demandes[0];
    await s.decider('orga', d.id, true);
    await s.payer('paul', groupe.id, 'caution');
    await valider();
    await s.quitter('paul', groupe.id);
    await assert.rejects(s.adherer(paul, groupe.id), /remboursement/);
    await s.rendreCaution(ADMIN, b.membres.lignes.find((x) => x.userId === 'paul')!.id, 'REF777');
    assert.equal((await s.adherer(paul, groupe.id)).groupe.monEtat, 'demande');
    assert.equal(b.membres.lignes.find((x) => x.userId === 'paul')!.cautionStatut, 'due');
  });

  const prive = (regles?: Ligne) => s.creer(orga, { nom: 'Amis', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 2, mode: 'rotation', visibilite: 'prive', cautionRequise: false, telephone: '0812345670', regles });

  it('invitations envoyées : visibles par l’organisateur, numéro masqué, rejointes', async () => {
    const { groupe } = await prive();
    await s.inviter('orga', groupe.id, '0812345673');
    await s.inviter('orga', groupe.id, '0812345673');
    let g = (await s.detail('orga', groupe.id)).groupe;
    assert.equal(g.invitations.length, 1);
    assert.equal(g.invitations[0].envois, 2);
    assert.equal(g.invitations[0].rejointLe, null);
    assert.doesNotMatch(JSON.stringify(b.invitations.lignes), /812345673/);
    await s.rejoindreParInvitation(invite, b.tontines.lignes[0].codeInvitation, '0812345673');
    g = (await s.detail('orga', groupe.id)).groupe;
    assert.ok(g.invitations[0].rejointLe);
    assert.deepEqual((await s.detail('invite', groupe.id)).groupe.invitations, []);
  });

  it('espèces : notées par l’organisateur, hors du versement et de la commission', async () => {
    await assert.rejects(async () => {
      const { groupe } = await prive();
      await s.rejoindreParInvitation(invite, b.tontines.lignes[0].codeInvitation, '0812345673');
      await s.demarrer('orga', groupe.id);
      await s.noterEspeces('orga', b.membres.lignes.find((x) => x.userId === 'invite')!.id);
    }, /n’accepte pas les espèces/);
    b = baseMemoire();
  });

  it('espèces acceptées : le membre est prévenu, Me ne verse que la part mobile', async () => {
    const { groupe } = await prive({ especes: true });
    assert.equal(groupe.regles.especes, true);
    await s.rejoindreParInvitation(invite, b.tontines.lignes[0].codeInvitation, '0812345673');
    await s.demarrer('orga', groupe.id);
    const m = b.membres.lignes.find((x) => x.userId === 'invite')!;
    await assert.rejects(s.noterEspeces('invite', m.id), /organisateur/);
    await s.noterEspeces('orga', m.id);
    assert.ok(avis.some((a) => a.userId === 'invite' && /espèces/.test(a.titre)));
    // Une deuxième fois : rien n'est dû.
    await assert.rejects(s.noterEspeces('orga', m.id), /pas de cotisation/);
    await s.payer('orga', groupe.id, 'cotisation');
    await valider();
    const t = b.tours.lignes.find((x) => x.numero === 1)!;
    assert.equal(t.etat, 'a_verser');
    assert.deepEqual([t.brut, t.commission, t.net, t.especes], [1000, 50, 950, 1000]);
    // Une rotation publique n'accepte jamais les espèces.
    const pub = await s.creer(orga, { nom: 'Public', montant: 1000, devise: 'USD', rythme: 'quotidien', places: 3, mode: 'rotation', visibilite: 'public', regles: { especes: true } });
    assert.equal(pub.groupe.regles.especes, false);
  });

  it('pénalité de retard : ajoutée après la grâce, versée au bénéficiaire', async () => {
    const { groupe } = await prive({ penalite: { montant: 200, grace: 2 } });
    await s.rejoindreParInvitation(invite, b.tontines.lignes[0].codeInvitation, '0812345673');
    await s.demarrer('orga', groupe.id);
    const echeance = b.tours.lignes.find((x) => x.numero === 1)!.echeance;
    instant = Date.parse(`${echeance}T12:00:00Z`) + 2 * JOUR;
    assert.equal((await s.detail('orga', groupe.id)).groupe.aPayer?.montant, 1000);
    instant += JOUR;
    const g = (await s.detail('orga', groupe.id)).groupe;
    assert.deepEqual([g.aPayer?.montant, g.aPayer?.penalite], [1200, 200]);
    await s.payer('orga', groupe.id, 'cotisation');
    await valider('12.00');
    await s.payerPourMembre('orga', b.membres.lignes.find((x) => x.userId === 'invite')!.id);
    await valider('12.00');
    const t = b.tours.lignes.find((x) => x.numero === 1)!;
    assert.equal(t.brut, 2400);
    const vu = (await s.detail('orga', groupe.id)).groupe;
    assert.ok(vu.membres.every((x) => x.retards === 1));
    assert.match(vu.texteRegles.join(' '), /pénalité après 2 jours de grâce/);
  });

  it('ordre des tours : d’arrivée, ou choisi par l’organisateur avant le démarrage', async () => {
    const { groupe } = await prive({ ordre: 'organisateur' });
    await s.rejoindreParInvitation(invite, b.tontines.lignes[0].codeInvitation, '0812345673');
    await assert.rejects(s.demarrer('orga', groupe.id), /ordre des tours/);
    const ids = b.membres.lignes.map((x) => x.id);
    await assert.rejects(s.ordonner('orga', groupe.id, [ids[0]]), /chaque membre/);
    await s.ordonner('orga', groupe.id, [ids[1], ids[0]]);
    const g = (await s.demarrer('orga', groupe.id)).groupe;
    assert.deepEqual(g.tours.map((x) => x.beneficiaire), ['Sarah Tshibanda', 'Jeereq Takango']);
    await assert.rejects(s.reglerRegles('orga', groupe.id, { ordre: 'tirage' }), /a démarré/);
  });

  it('règles : modifiables avant le démarrage, les membres sont prévenus', async () => {
    const { groupe } = await prive();
    await s.rejoindreParInvitation(invite, b.tontines.lignes[0].codeInvitation, '0812345673');
    const g = (await s.reglerRegles('orga', groupe.id, { ordre: 'arrivee', exclusion: { retards: 3 }, penalite: { montant: 999999, grace: 5 } })).groupe;
    assert.equal(g.regles.ordre, 'arrivee');
    // Pénalité ramenée à zéro si elle dépasse une cotisation, grâce non proposée ignorée.
    assert.deepEqual(g.regles.penalite, { montant: 0, grace: 0 });
    assert.ok(avis.some((a) => a.userId === 'invite' && a.titre === 'Règles du groupe modifiées'));
    await assert.rejects(s.reglerRegles('invite', groupe.id, { ordre: 'tirage' }), /organisateur/);
    const d = (await s.demarrer('orga', groupe.id)).groupe;
    assert.deepEqual(d.tours.map((x) => x.beneficiaire), ['Jeereq Takango', 'Sarah Tshibanda']);
  });

  it('conditions d’entrée : compte approuvé, et pas trop de retards ailleurs', async () => {
    const { groupe } = await prive({ entree: { compteApprouve: true } });
    await assert.rejects(s.rejoindreParInvitation(invite, b.tontines.lignes[0].codeInvitation, '0812345673'), /compte approuvé/);
    approuves.add('invite');
    assert.equal((await s.rejoindreParInvitation(invite, b.tontines.lignes[0].codeInvitation, '0812345673')).groupe.monEtat, 'accepte');
    // Paul a un retard dans un autre groupe.
    const autre = await s.creer(paul, { nom: 'Autre', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 2, mode: 'rotation', visibilite: 'prive', cautionRequise: false, telephone: '0812345671' });
    await s.rejoindreParInvitation(marie, b.tontines.lignes.find((x) => x.id === autre.groupe.id)!.codeInvitation, '0812345672');
    await s.demarrer('paul', autre.groupe.id);
    instant = Date.parse(`${b.tours.lignes.find((x) => x.tontineId === autre.groupe.id && x.numero === 1)!.echeance}T12:00:00Z`) + 2 * JOUR;
    const strict = await s.creer(orga, { nom: 'Strict', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 3, mode: 'rotation', visibilite: 'public', regles: { entree: { retardsMax: 0, automatique: true } } });
    await assert.rejects(s.adherer(paul, strict.groupe.id), /sans retard/);
    // Entrée d'office : Marie a payé ? Non plus : elle aussi est en retard dans « Autre ».
    await assert.rejects(s.adherer(marie, strict.groupe.id), /sans retard/);
  });

  it('exclusion : après le seuil de retards, pour une raison précise seulement', async () => {
    const o = await s.creer(orga, { nom: 'Mariage', montant: 1000, devise: 'USD', rythme: 'hebdomadaire', places: 5, mode: 'objectif', visibilite: 'prive', telephone: '0812345670', raison: 'Mariage', beneficiaire: { nom: 'Jean', telephone: '0812345679' }, dateFin: '2027-01-30', regles: { exclusion: { retards: 2 } } });
    await s.rejoindreParInvitation(invite, b.tontines.lignes.find((x) => x.id === o.groupe.id)!.codeInvitation, '0812345673');
    const m = b.membres.lignes.find((x) => x.userId === 'invite')!;
    await assert.rejects(s.exclure('orga', m.id), /2 retards/);
    instant += 20 * JOUR;
    await s.rattraper(instant);
    assert.ok((await s.detail('orga', o.groupe.id)).groupe.membres.find((x) => x.id === m.id)!.retards >= 2);
    await s.exclure('orga', m.id);
    assert.equal(b.membres.lignes.find((x) => x.id === m.id)!.etat, 'exclu');
    assert.ok(avis.some((a) => a.userId === 'invite' && a.titre === 'Exclu du groupe'));
  });

  it('l’initiateur déclenche la demande de paiement sur le numéro du membre', async () => {
    const id = await complet();
    await s.demarrer('orga', id);
    const paulId = b.membres.lignes.find((x) => x.userId === 'paul')!.id;
    await assert.rejects(s.demanderPaiement('paul', paulId), /organisateur/);
    await s.demanderPaiement('orga', paulId);
    assert.equal(demandes.at(-1)!.telephone, '243812345671');
    assert.equal(demandes.at(-1)!.montant, 1000);
    assert.ok(avis.some((a) => a.userId === 'paul' && /à valider/.test(a.titre) && a.seul));
    await assert.rejects(s.demanderPaiement('orga', paulId), /déjà en cours/);
    await valider();
    // Paul a payé : plus rien à demander ; « à tous » ne demande qu'à Marie.
    await assert.rejects(s.demanderPaiement('orga', paulId), /rien à payer/);
    const r = await s.demanderATous('orga', id);
    assert.deepEqual([r.envoyees, r.enCours], [1, 0]);
    assert.equal(demandes.at(-1)!.telephone, '243812345672');
    ouvert = () => false;
    await assert.rejects(s.demanderPaiement('orga', paulId), /pas encore ouvert/);
  });

  it('cagnotte complète : l’initiateur demande le versement, l’équipe est prévenue', async () => {
    const id = await complet();
    await s.demarrer('orga', id);
    await assert.rejects(s.demanderVersement('orga', id), /pas encore complète/);
    await cotiserTous(id);
    // L'équipe est prévenue dès que la cagnotte est complète, avec le lien vers l'écran des versements.
    assert.ok(avis.some((a) => a.userId === 'admin' && /^À verser : 28,50 USD/.test(a.titre) && a.url === '/utilisateurs?page=cotisations'));
    await assert.rejects(s.demanderVersement('paul', id), /organisateur/);
    const g = (await s.demanderVersement('orga', id)).groupe;
    assert.ok(g.tours[0].versementDemandeLe);
    assert.ok(avis.some((a) => a.userId === 'admin' && /^Versement demandé : 28,50 USD/.test(a.titre)));
    await assert.rejects(s.demanderVersement('orga', id), /relancer demain/);
    instant += 25 * JOUR / 24;
    await s.demanderVersement('orga', id);
    assert.ok(avis.some((a) => a.userId === 'admin' && /^Relance/.test(a.titre)));
    const r = await s.resumeAdmin();
    assert.equal(r.versements[0].demandes, 2);
  });

  it('règles de la plateforme : 10 % dans l’annuaire, demandes par l’initiateur', async () => {
    cadre = REGLES_PLATEFORME_DEFAUT;
    const pub = (await creer()).groupe;
    assert.equal(pub.commissionBps, 1000);
    assert.deepEqual([pub.brut, pub.commission, pub.net], [3000, 300, 2700]);
    assert.equal(pub.demandesParInitiateur, true);
    const pv = (await s.creer(orga, { nom: 'Amis', montant: 1000, devise: 'USD', rythme: 'mensuel', places: 2, mode: 'rotation', visibilite: 'prive', cautionRequise: false, telephone: '0812345670' })).groupe;
    assert.equal(pv.commission, 100);
    // Un membre ne lance pas lui-même la demande ; l'initiateur, si.
    await s.adherer(paul, pub.id);
    await s.decider('orga', b.membres.lignes.find((x) => x.userId === 'paul')!.id, true);
    await assert.rejects(s.payer('paul', pub.id, 'caution'), /t’enverra la demande/);
    await s.payer('orga', pub.id, 'caution');
    await s.demanderPaiement('orga', b.membres.lignes.find((x) => x.userId === 'paul')!.id);
    assert.equal(demandes.at(-1)!.telephone, '243812345671');
  });

  it('règles de la plateforme : cadre imposé aux règles du groupe', async () => {
    cadre = reglesPlateformeDe({ prive: { especes: false, penaliteMaxPct: 10, compteApprouve: true, retardsMax: 1, cautionObligatoire: true } });
    const g = (await prive({ especes: true, penalite: { montant: 500, grace: 0 }, entree: { retardsMax: 3 } })).groupe;
    assert.equal(g.regles.especes, false);
    assert.equal(g.regles.penalite.montant, 100);
    assert.equal(g.regles.entree.compteApprouve, true);
    assert.equal(g.regles.entree.retardsMax, 1);
    assert.equal(g.cautionRequise, true);
    // L'annuaire n'accepte jamais d'espèces et exige toujours l'approbation.
    assert.deepEqual([reglesPlateformeDe({ public: { especes: true, compteApprouve: false } }).public.especes, reglesPlateformeDe({ public: { compteApprouve: false } }).public.compteApprouve], [false, true]);
    assert.equal(reglesPlateformeDe({ prive: { commissionBps: 99999 } }).prive.commissionBps, 500);
  });
});

describe('approbation des comptes', () => {
  const { creerApprobations, estMajeur, typeImage } = await_module;
  type Ligne2 = Record<string, any>;
  let lignes: Ligne2[];
  let users: Record<string, Ligne2>;
  let avis: { userId: string; titre: string }[];
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const DOSSIER = { nomComplet: 'Marie Kabila', dateNaissance: '1990-05-12', ville: 'Kinshasa', commune: 'Gombe', activite: 'Commerçante', typePiece: 'carte_electeur' as const, capaciteMensuelle: 50, contactNom: 'Paul', contactTelephone: '0812345671' };
  const creer = () =>
    creerApprobations({
      db: {
        approbationCompte: {
          findUnique: async ({ where }: Ligne2) => lignes.find((l) => l.userId === where.userId) ?? null,
          findMany: async ({ where }: Ligne2) => lignes.filter((l) => (where.userId?.in ? where.userId.in.includes(l.userId) : true) && (where.statut?.in ? where.statut.in.includes(l.statut) : where.statut ? l.statut === where.statut : true)).map((l) => ({ ...l, user: users[l.userId] })),
          upsert: async ({ where, create, update }: Ligne2) => {
            const l = lignes.find((x) => x.userId === where.userId);
            if (l) Object.assign(l, update);
            else lignes.push({ statut: 'soumise', createdAt: new Date(), ...create });
          },
          update: async ({ where, data }: Ligne2) => Object.assign(lignes.find((x) => x.userId === where.userId)!, data),
        },
        user: {
          findUniqueOrThrow: async ({ where }: Ligne2) => users[where.id],
          findUnique: async ({ where }: Ligne2) => users[where.id] ?? null,
        },
      } as never,
      avertir: async (userId, _t, a) => {
        avis.push({ userId, titre: a.titre });
      },
    });

  beforeEach(() => {
    lignes = [];
    users = { a: { nom: 'Marie K', telephone: '243812345672', email: null }, b: { nom: 'Paul', telephone: null, email: null } };
    avis = [];
  });

  it('reconnaît les images par leur contenu', () => {
    assert.equal(typeImage(JPEG), 'image/jpeg');
    assert.equal(typeImage(new Uint8Array([0x25, 0x50, 0x44, 0x46])), null);
    assert.equal(typeImage(new Uint8Array([0x3c, 0x73, 0x76, 0x67])), null);
  });

  it('vérifie l’âge et chiffre le dossier', async () => {
    const s = creer();
    assert.equal(estMajeur('2008-11-06', '2026-11-06'), true);
    assert.equal(estMajeur('2008-11-07', '2026-11-06'), false);
    await assert.rejects(s.soumettre('a', JPEG, { ...DOSSIER, dateNaissance: '2015-01-01' }), /18 ans/);
    await s.soumettre('a', JPEG, DOSSIER);
    assert.equal(JSON.stringify(lignes[0].dossier).includes('Kabila'), false);
    assert.equal((await s.dossier('a')).dossier?.ville, 'Kinshasa');
    await s.decider('Admin', 'a', true);
    const apres = await s.dossier('a');
    assert.equal(apres.base64, null);
    assert.equal(apres.dossier?.nomComplet, 'Marie Kabila');
    await s.decider('Admin', 'a', false, 'Fraude');
    assert.equal((await s.dossier('a')).dossier, null);
  });

  it('exige le SMS, chiffre la photo, et l’efface à la décision', async () => {
    const s = creer();
    await assert.rejects(s.soumettre('b', JPEG, DOSSIER), /SMS/);
    await assert.rejects(s.soumettre('a', new Uint8Array([1, 2, 3, 4]), DOSSIER), /photo/);
    await assert.rejects(s.soumettre('a', new Uint8Array(6 * 1024 * 1024), DOSSIER), /trop lourde/);
    assert.equal((await s.soumettre('a', JPEG, DOSSIER)).statut, 'soumise');
    assert.equal(lignes[0].piece.includes(Buffer.from(JPEG).toString('base64')), false);
    const lu = await s.dossier('a');
    assert.equal(lu.type, 'image/jpeg');
    assert.equal(lu.base64, Buffer.from(JPEG).toString('base64'));
    assert.equal((await s.comptesApprouves(['a'])).size, 0);
    await s.decider('Admin', 'a', true);
    assert.equal(lignes[0].piece, null);
    assert.equal(lignes[0].decideParNom, 'Admin');
    assert.equal((await s.dossier('a')).base64, null);
    assert.equal((await s.comptesApprouves(['a', 'b'])).has('a'), true);
    assert.equal(avis[0].titre, 'Compte approuvé');
    await assert.rejects(s.soumettre('a', JPEG, DOSSIER), /déjà approuvé/);
  });

  it('refus avec motif, nouvelle demande possible, et approbation retirable', async () => {
    const s = creer();
    await s.soumettre('a', JPEG, DOSSIER);
    await assert.rejects(s.decider('Admin', 'a', false), /motif/);
    await s.decider('Admin', 'a', false, 'Photo illisible');
    assert.equal((await s.etat('a')).motif, 'Photo illisible');
    assert.equal(lignes[0].piece, null);
    assert.equal((await s.soumettre('a', JPEG, DOSSIER)).statut, 'soumise');
    await s.decider('Admin', 'a', true);
    await s.decider('Admin', 'a', false, 'Fraude');
    assert.equal((await s.comptesApprouves(['a'])).size, 0);
  });
});
