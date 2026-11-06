import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const { echeancesTontine, rappelDuJour, rappelsDe, RAPPELS_DEFAUT, repartitionCagnotte } = await import('../src/commun/cotisations.js');
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
        if (o.not === null) return l[k] != null;
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
  const roles: Record<string, { nom: string; role: string }> = { orga: { nom: 'Jeereq Takango', role: 'UTILISATEUR' } };
  const complet = (t: Ligne) => ({
    ...t,
    organisateur: roles[t.organisateurId] ?? null,
    membres: membres.lignes.filter((m) => m.tontineId === t.id).map((m) => ({ etat: 'demande', cautionStatut: 'due', rang: null, user: null, ...m })),
    tours: tours.lignes.filter((x) => x.tontineId === t.id).sort((a, b) => a.numero - b.numero),
  });
  const brut = (l: Ligne) => ({ etat: 'demande', cautionStatut: 'due', rang: null, ...l });
  const db = {
    tontine: {
      ...tontines,
      create: async ({ data }: Ligne) => tontines.create({ data: { etat: 'ouvert', tourCourant: 0, mode: 'rotation', visibilite: 'public', cautionRequise: true, beneficiaire: null, ...data } }),
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
  return { db: db as unknown as Deps['db'], tontines, membres, tours, mvts, roles };
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
  let invitations: Ligne[];
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
    invitations = [];
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
        if (nouveau) avis.push({ userId, telephone, cle: a.cle, titre: a.titre, seul: mode === true, mode });
        return { nouveau, mail: nouveau, sms: nouveau };
      },
      comptesApprouves: async (ids) => new Set(ids.filter((x) => approuves.has(x))),
      adresseApp: () => 'https://app.test',
      envoyerInvitation: async (_u, c) => {
        invitations.push(c);
        return { mail: false, sms: true };
      },
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
      await assert.rejects(s.verserTour('Admin', t.id, 'REF123'), /n’attend pas/);
      await s.payer('paul', id, 'cotisation');
      await valider();
      await s.payer('marie', id, 'cotisation');
      await valider();
      assert.equal(t.etat, 'a_verser');
      // Sans preuve, pas de versement manuel, et jamais deux fois.
      await assert.rejects(s.verserTour('Admin', t.id), /référence/);
      await s.verserTour('Admin', t.id, 'REF123');
      assert.equal(t.etat, 'verse');
      assert.equal(t.valideParNom, 'Admin');
      await assert.rejects(s.verserTour('Admin', t.id, 'REF123'), /n’attend pas/);
    }

    assert.equal(b.tontines.lignes[0].etat, 'termine');
    const r = await s.resumeAdmin();
    assert.equal(r.cautions.length, 3);
    assert.deepEqual(r.totaux, [{ devise: 'USD', detenu: 3000 + 9000 - 8550, commission: 450 }]);
    for (const c of r.cautions) await s.rendreCaution(c.membreId, 'REF999');
    await assert.rejects(s.rendreCaution(r.cautions[0].membreId, 'REF999'), /pas à rendre/);
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
    await s.verserTour('Admin', b.tours.lignes[0].id, 'REF123');
    assert.equal((await s.detail('marie', id)).groupe.aPayer?.genre, 'cotisation');
    await s.payer('marie', id, 'cotisation');
    await valider();
    assert.equal((await s.detail('marie', id)).groupe.aPayer?.genre, 'caution');
    // Marie ne refait pas sa caution et rate le tour suivant : plus rien ne la couvre.
    await s.payer('orga', id, 'cotisation');
    await valider();
    await s.payer('paul', id, 'cotisation');
    await valider();
    await s.verserTour('Admin', b.tours.lignes[1].id, 'REF124');
    instant += 3 * JOUR;
    await assert.rejects(s.utiliserCaution('orga', m.id), /plus de caution/);
    assert.equal(b.tours.lignes[2].etat, 'collecte');
    await assert.rejects(s.verserTour('Admin', b.tours.lignes[2].id, 'REF125'), /n’attend pas/);
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
    await s.verserTour('Admin', t.id);
    assert.equal(versements.length, 1);
    assert.equal(versements[0].montant, 2850);
    assert.equal(t.etat, 'a_verser');
    await assert.rejects(s.verserTour('Admin', t.id), /déjà en cours/);
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
    await s.verserTour('Admin', b.tours.lignes[0].id);
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
    await s.verserTour('Admin', final.id, 'REF321');
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

  it('un membre ne peut plus rejoindre pendant le remboursement de sa caution', async () => {
    const { groupe } = await creer();
    await s.adherer(paul, groupe.id);
    const d = (await s.detail('orga', groupe.id)).groupe.demandes[0];
    await s.decider('orga', d.id, true);
    await s.payer('paul', groupe.id, 'caution');
    await valider();
    await s.quitter('paul', groupe.id);
    await assert.rejects(s.adherer(paul, groupe.id), /remboursement/);
    await s.rendreCaution(b.membres.lignes.find((x) => x.userId === 'paul')!.id, 'REF777');
    assert.equal((await s.adherer(paul, groupe.id)).groupe.monEtat, 'demande');
    assert.equal(b.membres.lignes.find((x) => x.userId === 'paul')!.cautionStatut, 'due');
  });
});

describe('approbation des comptes', () => {
  const { creerApprobations, typeImage } = await_module;
  type Ligne2 = Record<string, any>;
  let lignes: Ligne2[];
  let users: Record<string, Ligne2>;
  let avis: { userId: string; titre: string }[];
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
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

  it('exige le SMS, chiffre la photo, et l’efface à la décision', async () => {
    const s = creer();
    await assert.rejects(s.soumettre('b', JPEG), /SMS/);
    await assert.rejects(s.soumettre('a', new Uint8Array([1, 2, 3, 4])), /photo/);
    await assert.rejects(s.soumettre('a', new Uint8Array(6 * 1024 * 1024)), /trop lourde/);
    assert.equal((await s.soumettre('a', JPEG)).statut, 'soumise');
    assert.equal(lignes[0].piece.includes(Buffer.from(JPEG).toString('base64')), false);
    assert.deepEqual(await s.piece('a'), { type: 'image/jpeg', base64: Buffer.from(JPEG).toString('base64') });
    assert.equal((await s.comptesApprouves(['a'])).size, 0);
    await s.decider('Admin', 'a', true);
    assert.equal(lignes[0].piece, null);
    assert.equal(lignes[0].decideParNom, 'Admin');
    await assert.rejects(s.piece('a'), /Aucune photo/);
    assert.equal((await s.comptesApprouves(['a', 'b'])).has('a'), true);
    assert.equal(avis[0].titre, 'Compte approuvé');
    await assert.rejects(s.soumettre('a', JPEG), /déjà approuvé/);
  });

  it('refus avec motif, nouvelle demande possible, et approbation retirable', async () => {
    const s = creer();
    await s.soumettre('a', JPEG);
    await assert.rejects(s.decider('Admin', 'a', false), /motif/);
    await s.decider('Admin', 'a', false, 'Photo illisible');
    assert.equal((await s.etat('a')).motif, 'Photo illisible');
    assert.equal(lignes[0].piece, null);
    assert.equal((await s.soumettre('a', JPEG)).statut, 'soumise');
    await s.decider('Admin', 'a', true);
    await s.decider('Admin', 'a', false, 'Fraude');
    assert.equal((await s.comptesApprouves(['a'])).size, 0);
  });
});
