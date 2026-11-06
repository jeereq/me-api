import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const { lienSms, lienWhatsapp, libellePeriode, messageCotisation, montantCotisation, numeroMasque, periodeDuJour, periodesDepuis, premierePeriodeDue } = await import('../src/commun/cotisations.js');
const { cotisationCreerSchema, cotisationJetonSchema, cotisationMarquerSchema } = await import('../src/validators/schemas.js');
const { ErreurFlexpaie } = await import('../src/services/abonnements/flexpaie.js');
const { creerCotisations } = await import('../src/services/cotisations/moteur.js');
type Deps = import('../src/services/cotisations/moteur.js').DepsCotisations;

describe('périodes et messages', () => {
  it('découpe par mois et par semaine', () => {
    assert.equal(periodeDuJour('mensuel', '2026-11-06'), '2026-11');
    assert.equal(periodeDuJour('hebdomadaire', '2026-11-08'), '2026-11-02');
    assert.equal(periodeDuJour('hebdomadaire', '2026-11-09'), '2026-11-09');
    assert.deepEqual(periodesDepuis('mensuel', '2026-11-30', '2027-02-01'), ['2026-11', '2026-12', '2027-01', '2027-02']);
    assert.deepEqual(periodesDepuis('hebdomadaire', '2026-11-06', '2026-11-17'), ['2026-11-02', '2026-11-09', '2026-11-16']);
    assert.deepEqual(periodesDepuis('unique', '2026-11-06', '2030-01-01'), ['unique']);
  });
  it('trouve la plus ancienne période due', () => {
    assert.equal(premierePeriodeDue(['2026-10', '2026-11'], ['2026-10']), '2026-11');
    assert.equal(premierePeriodeDue(['2026-10'], ['2026-10']), null);
  });
  it('rédige la demande, avec ou sans lien', () => {
    assert.equal(libellePeriode('2026-11'), 'novembre 2026');
    assert.equal(libellePeriode('2026-11-02'), 'semaine du 2 novembre');
    assert.equal(montantCotisation(1050, 'USD'), '10,50 USD');
    const base = { nom: 'Marie Kabila', titre: 'Tontine', montant: 1000, devise: 'USD', periode: '2026-11' };
    assert.equal(messageCotisation(base), 'Bonjour Marie, cotisation « Tontine » de novembre 2026 : 10 USD.');
    assert.match(messageCotisation({ ...base, lien: 'https://me.neevo.app/c/x' }), /Paie ici : https:\/\/me\.neevo\.app\/c\/x$/);
    assert.equal(lienWhatsapp('243812345678', 'a b'), 'https://wa.me/243812345678?text=a%20b');
    assert.equal(lienSms('243812345678', 'a b'), 'sms:+243812345678?body=a%20b');
    assert.equal(numeroMasque('243812345678'), '243•••••5678');
  });
  it('valide les entrées', () => {
    assert.equal(cotisationCreerSchema.safeParse({ body: { titre: 'T', montant: 1000, devise: 'USD', rythme: 'mensuel' } }).success, true);
    assert.equal(cotisationCreerSchema.safeParse({ body: { titre: 'T', montant: 10.5, devise: 'USD', rythme: 'mensuel' } }).success, false);
    assert.equal(cotisationCreerSchema.safeParse({ body: { titre: 'T', montant: 1000, devise: 'EUR', rythme: 'mensuel' } }).success, false);
    assert.equal(cotisationJetonSchema.safeParse({ params: { jeton: '../../etc/passwd' } }).success, false);
    assert.equal(cotisationMarquerSchema.safeParse({ params: { membreId: 'm' }, body: { periode: '2026-11', paye: true } }).success, true);
  });
});

/* Base en mémoire : juste ce que le moteur demande, avec l'index « une seule attente ». */
type Ligne = Record<string, any>;
function baseMemoire() {
  const cot: Ligne[] = [];
  const mem: Ligne[] = [];
  const pai: Ligne[] = [];
  let n = 0;
  const id = () => `id${++n}`;
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
  const membreComplet = (m: Ligne) => ({
    ...m,
    cotisation: { ...cot.find((c) => c.id === m.cotisationId), user: { nom: 'Jeereq Takango', fuseau: 'Africa/Kinshasa' } },
    paiements: pai.filter((p) => p.membreId === m.id).sort((a, b) => b.createdAt - a.createdAt || b.ordre - a.ordre),
  });
  const db = {
    cotisation: {
      count: async ({ where }: Ligne) => cot.filter((c) => correspond(c, where)).length,
      create: async ({ data }: Ligne) => {
        const c = { id: id(), archive: false, createdAt: new Date(), ...data };
        cot.push(c);
        return c;
      },
      findFirst: async ({ where }: Ligne) => {
        const c = cot.find((x) => correspond(x, where));
        return c ? complet(c) : null;
      },
      findMany: async ({ where }: Ligne) => cot.filter((c) => correspond(c, where)).map(complet),
      update: async ({ where, data }: Ligne) => Object.assign(cot.find((c) => c.id === where.id)!, data),
      delete: async ({ where }: Ligne) => {
        cot.splice(cot.findIndex((c) => c.id === where.id), 1);
        mem.splice(0, mem.length, ...mem.filter((m) => m.cotisationId !== where.id));
        pai.filter((p) => p.cotisationId === where.id).forEach((p) => (p.cotisationId = null));
      },
    },
    cotisationMembre: {
      count: async ({ where }: Ligne) => mem.filter((m) => correspond(m, where)).length,
      findMany: async ({ where }: Ligne) => mem.filter((m) => correspond(m, where)),
      create: async ({ data }: Ligne) => {
        const m = { id: id(), createdAt: new Date(), demandePeriode: null, ...data };
        mem.push(m);
        return m;
      },
      findFirst: async ({ where }: Ligne) => {
        const m = mem.find((x) => correspond(x, where));
        return m ? membreComplet(m) : null;
      },
      findUnique: async ({ where }: Ligne) => {
        const m = mem.find((x) => x.jeton === where.jeton);
        return m ? membreComplet(m) : null;
      },
      update: async ({ where, data }: Ligne) => Object.assign(mem.find((m) => m.id === where.id)!, data),
      delete: async ({ where }: Ligne) => {
        mem.splice(mem.findIndex((m) => m.id === where.id), 1);
        pai.filter((p) => p.membreId === where.id).forEach((p) => (p.membreId = null));
      },
    },
    paiementCotisation: {
      count: async ({ where }: Ligne) => pai.filter((p) => correspond(p, where)).length,
      create: async ({ data }: Ligne) => {
        if (data.statut === 'en_attente' && pai.some((p) => p.membreId === data.membreId && p.periode === data.periode && p.statut === 'en_attente')) throw Object.assign(new Error('doublon'), { code: 'P2002' });
        const p = { id: id(), createdAt: new Date(), ordre: n, commande: null, message: null, ...data };
        pai.push(p);
        return p;
      },
      update: async ({ where, data }: Ligne) => Object.assign(pai.find((p) => p.id === where.id)!, data),
      updateMany: async ({ where, data }: Ligne) => {
        const l = pai.filter((p) => correspond(p, where));
        l.forEach((p) => Object.assign(p, data));
        return { count: l.length };
      },
      deleteMany: async ({ where }: Ligne) => {
        const l = pai.filter((p) => correspond(p, where));
        pai.splice(0, pai.length, ...pai.filter((p) => !l.includes(p)));
        return { count: l.length };
      },
      findFirst: async ({ where }: Ligne) => pai.find((p) => correspond(p, where)) ?? null,
      findMany: async ({ where }: Ligne) => pai.filter((p) => correspond(p, where)),
      findUnique: async ({ where }: Ligne) => {
        const p = pai.find((x) => x.id === where.id);
        if (!p) return null;
        return { membre: mem.find((m) => m.id === p.membreId) ?? null, cotisation: cot.find((c) => c.id === p.cotisationId) ?? null };
      },
    },
  };
  return { db: db as unknown as Deps['db'], pai, mem, cot };
}

describe('cotisations et paiements', () => {
  let b: ReturnType<typeof baseMemoire>;
  let demandes: { telephone: string; reference: string; montant: number; devise: string; retour: string }[];
  let reponse: { etat: 'paye' | 'echoue' | 'en_attente'; transaction: { amount?: string; currency?: string } | null; message: string };
  let enLigne: boolean;
  let avis: { userId: string; titre: string }[];
  let refusDemande: Error | null;
  let s: ReturnType<typeof creerCotisations>;
  const U = 'u1';

  beforeEach(() => {
    b = baseMemoire();
    demandes = [];
    reponse = { etat: 'en_attente', transaction: null, message: '' };
    enLigne = true;
    avis = [];
    refusDemande = null;
    s = creerCotisations({
      db: b.db,
      flexpaie: {
        demander: async (p) => {
          if (refusDemande) throw refusDemande;
          demandes.push(p);
          return { commande: `CMD${demandes.length}` };
        },
        verifier: async () => reponse,
      },
      enLigne: () => enLigne,
      flexpaiePret: () => true,
      adresseServeur: () => 'https://api.test',
      adresseApp: () => 'https://app.test',
      exigerNumero: async () => {},
      prevenir: async (userId, a) => {
        avis.push({ userId, titre: a.titre });
      },
    });
  });

  const preparer = async () => {
    const { cotisation } = await s.creer(U, { titre: 'Tontine', montant: 1000, devise: 'USD', rythme: 'mensuel' }, 'Africa/Kinshasa');
    const apres = await s.ajouterMembre(U, cotisation.id, { nom: 'Marie Kabila', telephone: '0812345678' });
    const m = apres.cotisation.membres[0];
    return { c: apres.cotisation, m, jeton: String(b.mem[0].jeton) };
  };

  it('le lien du message pointe vers la page publique', async () => {
    const { m, jeton } = await preparer();
    assert.equal(m.lien, `https://app.test/c/${jeton}`);
    assert.match(jeton, /^[A-Za-z0-9_-]{16}$/);
  });

  it('chiffre le contact et n’accepte pas deux fois le même numéro', async () => {
    const { c, m } = await preparer();
    assert.equal(m.telephone, '243812345678');
    assert.equal(JSON.stringify(b.mem[0].contact).includes('243812345678'), false);
    await assert.rejects(s.ajouterMembre(U, c.id, { nom: 'Autre', telephone: '+243 812 345 678' }), /déjà dans le groupe/);
    await assert.rejects(s.ajouterMembre(U, c.id, { nom: 'Autre', telephone: '12' }), /invalide/);
  });

  it('refuse les autres comptes', async () => {
    const { c, m } = await preparer();
    await assert.rejects(s.modifier('intrus', c.id, { titre: 'x' }), /introuvable/);
    await assert.rejects(s.marquer('intrus', m.id, c.periode, true), /introuvable/);
    await assert.rejects(s.retirerMembre('intrus', m.id), /introuvable/);
    assert.deepEqual((await s.liste('intrus')).cotisations, []);
  });

  it('paiement fermé : pas de lien, pas de demande, suivi à la main', async () => {
    enLigne = false;
    const { c, m } = await preparer();
    assert.equal(m.lien, null);
    await assert.rejects(s.payer(b.mem[0].jeton), /pas encore ouvert/);
    assert.equal(demandes.length, 0);
    const v = await s.marquer(U, m.id, c.periode, true);
    assert.deepEqual(v.cotisation.membres[0].paiements.map((p) => p.mode), ['main']);
    assert.equal(v.cotisation.encaisse, 0);
    const annule = await s.marquer(U, m.id, c.periode, false);
    assert.deepEqual(annule.cotisation.membres[0].paiements, []);
  });

  it('la page publique ne montre que le prénom et un numéro masqué', async () => {
    const { jeton } = await preparer();
    const p = await s.page(jeton);
    assert.equal(p.nom, 'Marie');
    assert.equal(p.organisateur, 'Jeereq');
    assert.equal(p.telephone, '243•••••5678');
    assert.equal(p.etat, 'a_payer');
    assert.equal(JSON.stringify(p).includes('812345678'), false);
    await assert.rejects(s.page('inconnu'), /plus valable/);
  });

  it('demande vers le numéro du membre, puis compte le paiement vérifié une seule fois', async () => {
    const { c, jeton } = await preparer();
    const p = await s.payer(jeton);
    assert.equal(p.etat, 'en_attente');
    assert.equal(demandes[0].telephone, '243812345678');
    assert.equal(demandes[0].retour, 'https://api.test/api/cotisations/flexpaie/retour');
    assert.match(demandes[0].reference, /^CO/);
    assert.equal(b.pai[0].telephone, '243•••••5678');
    // Double clic : aucune deuxième demande.
    await s.payer(jeton);
    assert.equal(demandes.length, 1);
    reponse = { etat: 'paye', transaction: { amount: '10.00', currency: 'USD' }, message: '' };
    await s.retour({ reference: demandes[0].reference });
    await s.retour({ orderNumber: 'CMD1' });
    assert.equal(b.pai[0].statut, 'paye');
    assert.equal(avis.length, 1);
    assert.match(avis[0].titre, /Marie a payé 10 USD/);
    assert.equal((await s.page(jeton)).etat, 'a_jour');
    assert.equal((await s.liste(U)).cotisations[0].encaisse, 1000);
    await assert.rejects(s.supprimer(U, c.id), /termine cette cotisation/);
    await s.payer(jeton);
    assert.equal(demandes.length, 1);
  });

  it('un retour sans vérification FlexPaie ne compte pas', async () => {
    const { jeton } = await preparer();
    await s.payer(jeton);
    await s.retour({ reference: demandes[0].reference, status: '0', amount: '10.00' });
    assert.equal(b.pai[0].statut, 'en_attente');
  });

  it('refuse un montant différent ou une autre devise', async () => {
    const { jeton } = await preparer();
    await s.payer(jeton);
    reponse = { etat: 'paye', transaction: { amount: '1.00', currency: 'USD' }, message: '' };
    assert.equal((await s.page(jeton)).refus, true);
    assert.equal(b.pai[0].statut, 'echoue');
    await s.payer(jeton);
    reponse = { etat: 'paye', transaction: { amount: '10.00', currency: 'CDF' }, message: '' };
    await s.page(jeton);
    assert.equal(b.pai[1].statut, 'echoue');
    assert.equal((await s.liste(U)).cotisations[0].encaisse, 0);
  });

  it('sans montant confirmé, le paiement reste à vérifier', async () => {
    const { jeton } = await preparer();
    await s.payer(jeton);
    reponse = { etat: 'paye', transaction: null, message: '' };
    assert.equal((await s.page(jeton)).etat, 'en_attente');
  });

  it('abandon : on peut redemander, et une demande validée en retard évite de payer deux fois', async () => {
    const { jeton } = await preparer();
    await s.payer(jeton);
    assert.equal((await s.abandonner(jeton)).etat, 'a_payer');
    reponse = { etat: 'paye', transaction: { amount: '10.00', currency: 'USD' }, message: '' };
    const p = await s.payer(jeton);
    assert.equal(p.etat, 'a_jour');
    assert.equal(demandes.length, 1);
    assert.equal(b.pai[0].statut, 'paye');
  });

  it('limite à 5 demandes par jour', async () => {
    const { jeton } = await preparer();
    for (let i = 0; i < 5; i++) {
      await s.payer(jeton);
      await s.abandonner(jeton);
    }
    await assert.rejects(s.payer(jeton), /Trop de demandes/);
    assert.equal(demandes.length, 5);
  });

  it('une panne FlexPaie laisse la demande en échec, sans bloquer la suivante', async () => {
    const { jeton } = await preparer();
    refusDemande = new ErreurFlexpaie('refus');
    await assert.rejects(s.payer(jeton), /n’a pas pu partir/);
    assert.equal(b.pai[0].statut, 'echoue');
    refusDemande = null;
    assert.equal((await s.payer(jeton)).etat, 'en_attente');
  });

  it('terminée : plus de nouvelle demande', async () => {
    const { c, jeton } = await preparer();
    await s.modifier(U, c.id, { archive: true });
    assert.equal((await s.page(jeton)).etat, 'terminee');
    await assert.rejects(s.payer(jeton), /terminée/);
  });

  it('retire un membre sans perdre l’argent encaissé', async () => {
    const { c, m, jeton } = await preparer();
    await s.payer(jeton);
    await assert.rejects(s.retirerMembre(U, m.id), /en cours/);
    reponse = { etat: 'paye', transaction: { amount: '10.00', currency: 'USD' }, message: '' };
    await s.page(jeton);
    const v = await s.retirerMembre(U, m.id);
    assert.equal(v.cotisation.membres.length, 0);
    assert.equal(v.cotisation.encaisse, 1000);
    assert.equal(b.pai[0].membreId, null);
    assert.equal(b.pai[0].cotisationId, c.id);
  });

  it('rattrape un retour perdu, puis expire au bout de 24 h', async () => {
    const { jeton } = await preparer();
    await s.payer(jeton);
    await s.rattraper();
    assert.equal(b.pai[0].statut, 'en_attente');
    await s.rattraper(Date.now() + 86400000 + 1000);
    assert.equal(b.pai[0].statut, 'expire');
    reponse = { etat: 'paye', transaction: { amount: '10.00', currency: 'USD' }, message: '' };
    await s.rattraper(Date.now() + 2 * 86400000);
    assert.equal(b.pai[0].statut, 'paye');
  });
});
