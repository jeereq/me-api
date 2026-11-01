/**
 * L'analyse des mails préparée par le serveur, avec une vraie base PostgreSQL et un faux OpenAI.
 * Ignoré tant que TEST_DATABASE_URL n'est pas donné (la CI n'a pas de base) :
 *
 *   TEST_DATABASE_URL=postgresql://me:me@localhost:5432/me_test npx prisma migrate deploy   # une fois, sur une base vide
 *   TEST_DATABASE_URL=postgresql://me:me@localhost:5432/me_test npm test
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

const URL_BASE = process.env.TEST_DATABASE_URL;

describe('analyse des mails préparée par le serveur (base de données)', { skip: !URL_BASE && 'TEST_DATABASE_URL absent' }, () => {
  type Modules = {
    prisma: typeof import('../src/utils/prisma.js').prisma;
    service: typeof import('../src/services/AnalyseMailService.js').AnalyseMailService;
    google: typeof import('../src/services/integrations/google.js').google;
    chiffrer: typeof import('../src/utils/crypto.js').chiffrer;
  };
  let m: Modules;
  let ia: Server;
  /** Les demandes reçues par le faux OpenAI : le modèle demandé et les données JSON des mails. */
  let demandes: { modele: string; donnees: { aujourdhui: string; crm?: { relances: { ref: string }[]; taches: unknown[]; projets: unknown[] }; mails: { id: string; texte: string }[] } }[] = [];
  let lectures: string[] = [];
  const aujourdhui = new Date().toISOString().slice(0, 10);

  before(async () => {
    Object.assign(process.env, { DATABASE_URL: URL_BASE, JWT_SECRET: 'x'.repeat(40), ENCRYPTION_KEY: 'k'.repeat(40), OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'petit', OPENAI_MODEL_FORT: 'fort', ABONNEMENTS: 'true' });
    ia = createServer((req, res) => {
      let corps = '';
      req.on('data', (c) => (corps += c));
      req.on('end', () => {
        const { model, messages } = JSON.parse(corps) as { model: string; messages: { role: string; content: string }[] };
        const utilisateur = messages.find((x) => x.role === 'user')!.content;
        const donnees = JSON.parse(utilisateur.slice(utilisateur.indexOf('<mails>\n') + 8, utilisateur.indexOf('\n</mails>')));
        demandes.push({ modele: model, donnees });
        const analyses = donnees.mails.map((x: { id: string }) => ({ id: x.id, resume: `${model} : ${x.id}`, urgence: 'normale', action: x.id.endsWith('news') ? 'rien' : 'repondre', categorie: 'autre', reponse: '', tache: '', echeance: null, montant: null, rdv_date: null, rdv_heure: null, relance: null, projet: null }));
        res.setHeader('content-type', 'application/json').end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ analyses }) } }] }));
      });
    });
    await new Promise<void>((r) => ia.listen(0, r));
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(ia.address() as AddressInfo).port}`;
    m = {
      prisma: (await import('../src/utils/prisma.js')).prisma,
      service: (await import('../src/services/AnalyseMailService.js')).AnalyseMailService,
      google: (await import('../src/services/integrations/google.js')).google,
      chiffrer: (await import('../src/utils/crypto.js')).chiffrer,
    };
    // Gmail est remplacé : le mail lu dépend seulement de son identifiant.
    m.google.lireMail = async (_jetons, mailId) => {
      lectures.push(mailId);
      return { id: mailId, sujet: `Sujet ${mailId}`, de: 'Paul Martin', adresse: 'Paul Martin <paul@martin.fr>', a: [], cc: [], date: aujourdhui, texte: `Bonjour ${mailId}\n\nLe 1 oct. 2026, Moi a écrit :\n> historique`, piecesJointes: ['devis.pdf'], fil: [{ id: 'avant', de: 'Moi', texte: 'Un devis ?', piecesJointes: [] }] };
    };
  });

  after(async () => {
    ia?.close();
    await m?.prisma.$disconnect();
  });

  let n = 0;
  /** Un compte avec un Gmail connecté, trois mails reçus non lus (dont une lettre d'info) et un mail trop vieux. */
  async function compte(o: { pro?: boolean; auto?: boolean } = {}) {
    const k = `${Date.now()}${n++}`;
    const user = await m.prisma.user.create({
      data: {
        email: `u${k}@test.fr`,
        fuseau: 'Europe/Paris',
        ...(o.pro === false ? {} : { abonnementFinLe: new Date(Date.now() + 30 * 86400000), abonnementPeriode: 'mensuel' }),
        espace: { create: { data: { audio: { ton: 'direct' }, relances: [{ id: 'r1', contact: 'Paul', sujet: 'Devis', statut: 'a_faire', date: '2026-10-20' }], taches: [{ id: 't1', titre: 'Payer OVH', statut: 'en_attente', creeLe: '2026-10-30' }], projets: [] } } },
      },
    });
    const mail = (id: string, x = {}) => ({ id, sujet: `Sujet ${id}`, contact: 'Paul Martin', adresse: 'Paul Martin <paul@martin.fr>', date: aujourdhui, heure: '08:00', sens: 'recu', nonLu: true, ...x });
    const i = await m.prisma.integration.create({
      data: {
        userId: user.id,
        fournisseur: 'GOOGLE',
        compte: `g${k}@gmail.com`,
        accessToken: m.chiffrer('jeton'),
        prefs: o.auto ? { analyseAuto: true } : {},
        donnees: { agenda: [], taches: [], relances: [], mails: [mail(`a${k}`), mail(`b${k}`, { heure: '09:00' }), mail(`${k}news`, { heure: '07:00' }), mail(`vieux${k}`, { date: '2026-01-01' })] },
      },
    });
    return { user, i, k, ref: (mailId: string) => `ext:${i.id}:${mailId}` };
  }

  beforeEach(() => {
    demandes = [];
    lectures = [];
  });

  it('lit les mails lui-même, trie avec le petit modèle, reprend les importants avec le modèle fort, et garde le résultat', async () => {
    const c = await compte();
    const r = await m.service.analyser(c.user.id, { mails: [c.ref(`a${c.k}`), c.ref(`${c.k}news`)] });
    assert.deepEqual([r.fraiches, r.enCache, r.illisibles], [2, 0, []]);
    assert.deepEqual(lectures.sort(), [`a${c.k}`, `${c.k}news`].sort());
    // Tri de deux mails par le petit modèle, puis reprise du seul mail qui attend une réponse par le modèle fort.
    assert.deepEqual(demandes.map((d) => [d.modele, d.donnees.mails.length]), [['petit', 2], ['fort', 1]]);
    const tri = demandes[0].donnees;
    assert.equal(tri.mails[0].texte.includes('historique'), false, 'historique cité retiré');
    assert.match(String(tri.aujourdhui), /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(tri.crm?.relances.map((x) => x.ref), ['r:r1'], 'contexte lu dans l’espace du compte');
    assert.equal(r.analyses.find((a) => a.id === c.ref(`a${c.k}`))?.resume, `fort : ${c.ref(`a${c.k}`)}`);
    assert.equal(r.analyses.find((a) => a.id === c.ref(`${c.k}news`))?.resume, `petit : ${c.ref(`${c.k}news`)}`);
    const lignes = await m.prisma.analyseMail.findMany({ where: { integrationId: c.i.id } });
    assert.equal(lignes.length, 2);
    assert.equal(lignes[0].modele, 'petit+fort');
    assert.equal(JSON.stringify(lignes).includes('Bonjour'), false, 'le texte du mail n’est pas gardé');
  });

  it('rouvrir ne coûte rien : ni lecture chez Gmail, ni demande à l’IA', async () => {
    const c = await compte();
    const mails = [c.ref(`a${c.k}`), c.ref(`b${c.k}`)];
    await m.service.analyser(c.user.id, { mails });
    demandes = [];
    lectures = [];
    const r = await m.service.analyser(c.user.id, { mails });
    assert.deepEqual([r.fraiches, r.enCache], [0, 2]);
    assert.deepEqual([demandes.length, lectures.length], [0, 0]);
    assert.deepEqual(r.analyses.map((a) => a.id), mails);
  });

  it('refait l’analyse quand les consignes ou le ton changent', async () => {
    const c = await compte();
    const mails = [c.ref(`a${c.k}`)];
    await m.service.analyser(c.user.id, { mails });
    demandes = [];
    assert.equal((await m.service.analyser(c.user.id, { mails, consignes: 'Repère les impayés' })).fraiches, 1);
    assert.equal((await m.service.analyser(c.user.id, { mails, consignes: 'Repère   les impayés' })).enCache, 1, 'mêmes consignes à l’espace près');
    assert.equal((await m.service.analyser(c.user.id, { mails, consignes: 'Repère les impayés', ton: 'coach' })).fraiches, 1);
    assert.equal(await m.prisma.analyseMail.count({ where: { integrationId: c.i.id } }), 1, 'une seule ligne par mail');
  });

  it('le contexte envoyé par l’app remplace celui de l’espace privé', async () => {
    const c = await compte();
    await m.service.analyser(c.user.id, { mails: [c.ref(`a${c.k}`)], crm: { relances: [], taches: [], projets: [{ ref: 'p:eq', nom: 'Équipe' }] } });
    assert.deepEqual(demandes[0].donnees.crm?.relances, []);
    assert.equal(JSON.stringify(demandes[0].donnees.crm).includes('p:eq'), true);
  });

  it('ne lit jamais le mail d’un autre compte', async () => {
    const [a, b] = [await compte(), await compte()];
    const r = await m.service.analyser(a.user.id, { mails: [b.ref(`a${b.k}`), 'ext:inconnu:x', 'pas-une-ref'] });
    assert.deepEqual([r.analyses.length, r.illisibles.length, lectures.length, demandes.length], [0, 3, 0, 0]);
  });

  it('une analyse de plus de 30 jours est refaite, puis le ménage de nuit l’efface', async () => {
    const c = await compte();
    const mails = [c.ref(`a${c.k}`)];
    await m.service.analyser(c.user.id, { mails });
    await m.prisma.$executeRaw`UPDATE "AnalyseMail" SET "majLe" = now() - interval '31 days' WHERE "integrationId" = ${c.i.id}`;
    assert.equal((await m.service.analyser(c.user.id, { mails })).fraiches, 1);
    await m.prisma.$executeRaw`UPDATE "AnalyseMail" SET "majLe" = now() - interval '31 days' WHERE "integrationId" = ${c.i.id}`;
    const r = await m.service.purger();
    assert.ok(r.effacees >= 1);
    assert.equal(await m.prisma.analyseMail.count({ where: { integrationId: c.i.id } }), 0);
  });

  it('les analyses disparaissent avec le compte connecté et avec le compte', async () => {
    const [a, b] = [await compte(), await compte()];
    for (const c of [a, b]) await m.service.analyser(c.user.id, { mails: [c.ref(`a${c.k}`)] });
    await m.prisma.integration.delete({ where: { id: a.i.id } });
    assert.equal(await m.prisma.analyseMail.count({ where: { userId: a.user.id } }), 0);
    await m.prisma.user.delete({ where: { id: b.user.id } });
    assert.equal(await m.prisma.analyseMail.count({ where: { userId: b.user.id } }), 0);
  });

  it('prépare à l’avance les nouveaux mails des comptes qui le demandent, une seule fois', async () => {
    const [voulu, pasVoulu, sansPro] = [await compte({ auto: true }), await compte({ auto: false }), await compte({ auto: true, pro: false })];
    const r = await m.service.preparerNouveaux();
    assert.ok(r.comptes >= 1);
    const analyses = async (c: { i: { id: string } }) => (await m.prisma.analyseMail.findMany({ where: { integrationId: c.i.id } })).map((x) => x.mailId).sort();
    // Les trois mails récents, pas le vieux ; rien pour qui n'a pas choisi, rien sans Pro.
    assert.deepEqual(await analyses(voulu), [`a${voulu.k}`, `b${voulu.k}`, `${voulu.k}news`].sort());
    assert.deepEqual(await analyses(pasVoulu), []);
    assert.deepEqual(await analyses(sansPro), []);
    demandes = [];
    await m.service.preparerNouveaux();
    assert.equal(demandes.filter((d) => d.donnees.mails.some((x) => x.id.includes(voulu.i.id))).length, 0, 'rien à refaire au passage suivant');
  });

  it('les analyses préparées à l’avance sont celles que l’app retrouve en rouvrant', async () => {
    const c = await compte({ auto: true });
    await m.service.preparerNouveaux();
    demandes = [];
    lectures = [];
    // L'app envoie le ton de son espace (« direct ») et le même contexte : tout est déjà prêt.
    const r = await m.service.analyser(c.user.id, { mails: [c.ref(`a${c.k}`), c.ref(`b${c.k}`)], ton: 'direct' });
    assert.deepEqual([r.enCache, r.fraiches, demandes.length, lectures.length], [2, 0, 0, 0]);
  });
});
