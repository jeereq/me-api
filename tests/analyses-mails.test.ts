import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { consignesPropres } from '../src/services/analyse-mails.js';
import {
  AGE_MAX_JOURS,
  analyserLot,
  AUTO_JOURS,
  contexteDepuisEspace,
  empreinte,
  limiteAge,
  lireRef,
  mailPourIA,
  mailsAPreparer,
  memeContact,
  refMail,
  tonDe,
  type AnalyseIA,
  type Dependances,
} from '../src/services/analyses/regles.js';
import { MODELE_FORT_DEFAUT, modeleFortChoisi } from '../src/services/assistant-modele.js';
import { analyseMailsSchema, patchIntegrationSchema } from '../src/validators/schemas.js';

describe('références de mails', () => {
  it('découpe ext:<compte>:<mail>, le mail pouvant contenir des « : »', () => {
    assert.deepEqual(lireRef('ext:c1:18f3a'), { integrationId: 'c1', mailId: '18f3a' });
    assert.deepEqual(lireRef('ext:c1:AAMk:x='), { integrationId: 'c1', mailId: 'AAMk:x=' });
    assert.equal(refMail('c1', '18f3a'), 'ext:c1:18f3a');
    for (const mauvais of ['c1:18f3a', 'ext:c1', 'ext::x', 'ext:c1:', '']) assert.equal(lireRef(mauvais), null, mauvais);
  });
});

describe('ce qui se garde 30 jours', () => {
  it('l’empreinte change avec le ton ou les consignes, pas avec les espaces ni la casse du ton', () => {
    const base = empreinte('motivant', undefined);
    assert.equal(base, empreinte(' Motivant ', ''));
    assert.equal(base, empreinte('motivant', '   '));
    assert.notEqual(base, empreinte('direct', undefined));
    assert.notEqual(base, empreinte('motivant', 'Repère les impayés'));
    assert.equal(empreinte('motivant', 'Repère   les impayés'), empreinte('motivant', 'Repère les impayés'));
    assert.equal(empreinte(undefined, undefined), empreinte('neutre', undefined));
  });
  it('les consignes sont nettoyées comme dans le prompt', () => {
    assert.equal(consignesPropres('  a \n\n b  '), 'a b');
    assert.equal(consignesPropres('x'.repeat(2000)).length, 600);
    assert.equal(consignesPropres(undefined), '');
  });
  it('une analyse de plus de 30 jours est trop vieille', () => {
    const maintenant = new Date('2026-11-01T12:00:00Z');
    assert.equal(AGE_MAX_JOURS, 30);
    assert.equal(limiteAge(maintenant).toISOString(), '2026-10-02T12:00:00.000Z');
  });
});

describe('le mail tel que l’IA le reçoit', () => {
  it('nettoie le texte et le fil, borne leur taille, garde les pièces jointes', () => {
    const m = mailPourIA(
      'ext:c1:m1',
      {
        sujet: 'Re: Devis',
        de: 'Paul',
        adresse: 'paul@x.fr',
        date: '2026-10-30',
        texte: 'OK pour jeudi.\n\nLe 29 oct. 2026, Moi <m@x.fr> a écrit :\n> Jeudi ?',
        piecesJointes: ['devis.pdf'],
        fil: [1, 2, 3, 4, 5].map((i) => ({ de: `P${i}`, texte: `Message ${i}\n-- \nSignature ${'x'.repeat(2000)}` })),
      },
      'pro',
    );
    assert.equal(m.id, 'ext:c1:m1');
    assert.equal(m.texte, 'OK pour jeudi.');
    assert.equal(m.boite, 'pro');
    assert.deepEqual(m.pj, ['devis.pdf']);
    assert.deepEqual(m.precedents?.map((p) => [p.de, p.texte]), [['P3', 'Message 3'], ['P4', 'Message 4'], ['P5', 'Message 5']]);
  });
  it('retombe sur l’extrait quand le texte est vide, et n’ajoute rien d’inutile', () => {
    const m = mailPourIA('ext:c1:m2', { sujet: 'Salut', de: 'Lou' }, 'perso', 'Premiers mots');
    assert.equal(m.texte, 'Premiers mots');
    assert.equal('precedents' in m, false);
    assert.equal('pj' in m, false);
  });
});

describe('contexte de Me lu dans l’espace', () => {
  const espace = {
    audio: { ton: 'direct' },
    relances: [
      { id: '1', contact: 'Paul', sujet: 'Devis', statut: 'a_faire', date: '2026-10-20' },
      { id: '2', contact: 'Karim', sujet: 'Contrat', statut: 'relance', date: '2026-10-21', mail: { fil: 'c1:f9' } },
      { id: '3', contact: 'Paul', sujet: 'Fini', statut: 'repondu', date: '2026-10-01' },
      { id: '4', contact: 'Sophie', sujet: 'Autre', statut: 'a_faire', date: '2026-10-02' },
    ],
    taches: [
      { id: 'a', titre: 'Vieille', statut: 'en_attente', creeLe: '2026-01-01', echeance: null },
      { id: 'b', titre: 'Faite', statut: 'fait', creeLe: '2026-10-30' },
      { id: 'c', titre: 'Récente', statut: 'en_attente', creeLe: '2026-10-29', echeance: '2026-11-03T10:00' },
    ],
    projets: [{ id: 'p1', nom: 'Cuisine' }, { id: 'p2', nom: 'Vieux', archive: true }],
  };
  it('relances ouvertes de l’expéditeur ou du fil, tâches ouvertes récentes d’abord, projets en cours', () => {
    const c = contexteDepuisEspace(espace, [{ contact: 'Paul Martin', adresse: 'Paul Martin <paul@martin.fr>', cleFil: 'c1:f1' }, { contact: 'K', adresse: 'k@x.fr', cleFil: 'c1:f9' }]);
    assert.deepEqual(c.relances.map((r) => r.ref), ['r:1', 'r:2']);
    assert.deepEqual(c.taches, [{ ref: 't:c', titre: 'Récente', echeance: '2026-11-03' }, { ref: 't:a', titre: 'Vieille', echeance: null }]);
    assert.deepEqual(c.projets, [{ ref: 'p:p1', nom: 'Cuisine' }]);
  });
  it('un espace vide ou illisible donne un contexte vide', () => {
    for (const e of [null, undefined, {}, { relances: 'x', taches: 3 }]) assert.deepEqual(contexteDepuisEspace(e, []), { relances: [], taches: [], projets: [] });
  });
  it('le ton vient de l’espace, « neutre » sans lui', () => {
    assert.equal(tonDe(espace), 'direct');
    assert.equal(tonDe({}), 'neutre');
    assert.equal(tonDe(null), 'neutre');
  });
  it('reconnaît un contact par nom ou par adresse', () => {
    assert.equal(memeContact('Paul', { contact: 'Paul Martin', adresse: 'paul@martin.fr' }), true);
    assert.equal(memeContact('paul@martin.fr', { contact: 'P', adresse: 'Paul <paul@martin.fr>' }), true);
    assert.equal(memeContact('Sophie', { contact: 'Paul Martin', adresse: 'paul@martin.fr' }), false);
    assert.equal(memeContact('', { contact: 'Paul' }), false);
  });
});

describe('mails à préparer à l’avance', () => {
  const maintenant = new Date('2026-11-01T09:00:00Z');
  const m = (id: string, x = {}) => ({ id, sens: 'recu', nonLu: true, date: '2026-11-01', heure: '08:00', ...x });
  it('reçus, non lus, des 3 derniers jours, sans analyse, les plus récents d’abord', () => {
    const mails = [
      m('vieux', { date: '2026-10-20' }),
      m('lu', { nonLu: false }),
      m('envoye', { sens: 'envoye' }),
      m('deja'),
      m('hier', { date: '2026-10-31', heure: '18:00' }),
      m('recent', { heure: '08:30' }),
      m('limite', { date: '2026-10-29' }),
      m('abandonne'),
    ];
    assert.equal(AUTO_JOURS, 3);
    assert.deepEqual(mailsAPreparer(mails, new Set(['deja']), maintenant, 10, new Set(['abandonne'])).map((x) => x.id), ['recent', 'hier', 'limite']);
  });
  it('au plus le nombre demandé', () => {
    const mails = Array.from({ length: 30 }, (_, i) => m(`m${i}`, { heure: `0${i % 10}:00` }));
    assert.equal(mailsAPreparer(mails, new Set(), maintenant, 10).length, 10);
    assert.equal(mailsAPreparer(mails, new Set(), maintenant, 0).length, 0);
    assert.deepEqual(mailsAPreparer(undefined, new Set(), maintenant), []);
  });
});

describe('analyse d’un paquet de mails avec mémoire', () => {
  const analyse = (ref: string, x = {}): AnalyseIA => ({ id: ref, resume: `Résumé ${ref}`, urgence: 'normale', action: 'repondre', ...x });
  const A = refMail('c1', 'a');
  const B = refMail('c1', 'b');
  const C = refMail('c1', 'c');
  function dependances(o: { gardees?: AnalyseIA[]; illisibles?: string[]; ia?: (donnees: string) => string } = {}) {
    const appels = { lire: [] as string[], demander: [] as string[], garder: [] as string[] };
    const d: Dependances = {
      gardees: async (refs) => new Map((o.gardees ?? []).filter((a) => refs.includes(a.id)).map((a) => [a.id, a])),
      lire: async (ref) => {
        appels.lire.push(ref);
        return o.illisibles?.includes(ref) ? null : { id: ref, texte: `texte ${ref}` };
      },
      demander: async (donnees) => {
        appels.demander.push(donnees);
        return { texte: o.ia ? o.ia(donnees) : JSON.stringify({ analyses: (JSON.parse(donnees).mails as { id: string }[]).map((m) => analyse(m.id)) }), modeles: ['petit', 'fort'] };
      },
      garder: async (ref) => {
        appels.garder.push(ref);
      },
    };
    return { d, appels };
  }
  const contexte = { aujourdhui: '2026-11-01', crm: { relances: [], taches: [], projets: [] } };

  it('tout déjà gardé : ni lecture, ni demande à l’IA', async () => {
    const { d, appels } = dependances({ gardees: [analyse(A), analyse(B)] });
    const r = await analyserLot([A, B], contexte, d);
    assert.deepEqual(r.analyses.map((a) => a.id), [A, B]);
    assert.deepEqual([r.enCache, r.fraiches], [2, 0]);
    assert.deepEqual(appels, { lire: [], demander: [], garder: [] });
  });
  it('lit et envoie à l’IA seulement les mails qui manquent, dans l’ordre demandé', async () => {
    const { d, appels } = dependances({ gardees: [analyse(B, { resume: 'en mémoire' })] });
    const r = await analyserLot([A, B, C], contexte, d);
    assert.deepEqual(appels.lire, [A, C]);
    assert.equal(appels.demander.length, 1);
    const envoye = JSON.parse(appels.demander[0]);
    assert.deepEqual(envoye.mails.map((m: { id: string }) => m.id), [A, C]);
    assert.equal(envoye.aujourdhui, '2026-11-01');
    assert.deepEqual(envoye.crm, contexte.crm);
    assert.deepEqual(appels.garder, [A, C]);
    assert.deepEqual(r.analyses.map((a) => [a.id, a.resume]), [[A, `Résumé ${A}`], [B, 'en mémoire'], [C, `Résumé ${C}`]]);
    assert.deepEqual([r.enCache, r.fraiches, r.modeles], [1, 2, ['petit', 'fort']]);
  });
  it('un mail illisible n’est pas envoyé à l’IA et est signalé', async () => {
    const { d, appels } = dependances({ illisibles: [B] });
    const r = await analyserLot([A, B], contexte, d);
    assert.deepEqual(r.illisibles, [B]);
    assert.deepEqual(JSON.parse(appels.demander[0]).mails.map((m: { id: string }) => m.id), [A]);
    assert.deepEqual(r.analyses.map((a) => a.id), [A]);
  });
  it('tous illisibles : aucune demande à l’IA', async () => {
    const { d, appels } = dependances({ illisibles: [A] });
    const r = await analyserLot([A], contexte, d);
    assert.deepEqual(appels.demander, []);
    assert.deepEqual([r.analyses, r.illisibles], [[], [A]]);
  });
  it('ignore ce que l’IA invente ou répète, et un mail oublié n’est pas gardé', async () => {
    const { d, appels } = dependances({ ia: () => JSON.stringify({ analyses: [analyse(A), analyse(A, { resume: 'doublon' }), analyse('ext:c9:inconnu')] }) });
    const r = await analyserLot([A, B], contexte, d);
    assert.deepEqual(appels.garder, [A]);
    assert.deepEqual(r.analyses.map((a) => [a.id, a.resume]), [[A, `Résumé ${A}`]]);
    assert.equal(r.fraiches, 1);
  });
  it('une réponse illisible de l’IA est une erreur, rien n’est gardé', async () => {
    const { d, appels } = dependances({ ia: () => 'pas du json' });
    await assert.rejects(() => analyserLot([A], contexte, d), /reponse_illisible/);
    assert.deepEqual(appels.garder, []);
    const sans = dependances({ ia: () => '{"autre":1}' });
    await assert.rejects(() => analyserLot([A], contexte, sans.d), /reponse_illisible/);
  });
  it('les mêmes refs répétées ne comptent qu’une fois, et sans contexte la clé crm est absente', async () => {
    const { d, appels } = dependances();
    const r = await analyserLot([A, A], { aujourdhui: '2026-11-01' }, d);
    assert.equal(r.analyses.length, 1);
    assert.equal('crm' in JSON.parse(appels.demander[0]), false);
  });
  it('une lecture qui échoue compte comme un mail illisible', async () => {
    const { d } = dependances();
    d.lire = async () => {
      throw new Error('compte à reconnecter');
    };
    const r = await analyserLot([A], contexte, d);
    assert.deepEqual(r.illisibles, [A]);
  });
});

describe('modèle fort par défaut', () => {
  it('le choix de l’admin, sinon le serveur, sinon le défaut', () => {
    assert.equal(modeleFortChoisi('gpt-5', 'gpt-4.1-mini'), 'gpt-5');
    assert.equal(modeleFortChoisi('', 'gpt-4.1-mini'), 'gpt-4.1-mini');
    assert.equal(modeleFortChoisi(undefined, undefined), MODELE_FORT_DEFAUT);
    assert.equal(modeleFortChoisi('  ', ' '), MODELE_FORT_DEFAUT);
  });
  it('« aucun » désactive le modèle fort, chez l’admin comme sur le serveur', () => {
    assert.equal(modeleFortChoisi('aucun', 'gpt-5'), '');
    assert.equal(modeleFortChoisi('Aucun', undefined), '');
    assert.equal(modeleFortChoisi(undefined, 'aucun'), '');
  });
});

describe('validation des demandes', () => {
  it('l’analyse de mails demande 1 à 10 références, et un contexte borné', () => {
    const ok = (body: unknown) => analyseMailsSchema.safeParse({ body }).success;
    assert.equal(ok({ mails: ['ext:c1:a'] }), true);
    assert.equal(ok({ mails: [] }), false);
    assert.equal(ok({ mails: Array.from({ length: 11 }, (_, i) => `ext:c1:${i}`) }), false);
    assert.equal(ok({ mails: ['ext:c1:a'], crm: { relances: [{ ref: 'r:1', contact: 'Paul', sujet: 'x', depuis: '2026-10-20' }], taches: [{ ref: 't:1', titre: 'x', echeance: null }], projets: [] } }), true);
    assert.equal(ok({ mails: ['ext:c1:a'], crm: { relances: [], taches: [] } }), true, 'une liste absente vaut une liste vide');
    assert.equal(ok({ mails: ['ext:c1:a'], consignes: 'x'.repeat(1001) }), false);
  });
  it('le contexte trop long est coupé, jamais refusé (ids de tâches importées de To Do, titres démesurés)', () => {
    const long = (n: number) => 'x'.repeat(n);
    const r = analyseMailsSchema.safeParse({
      body: {
        mails: ['ext:c1:a'],
        crm: {
          relances: [{ ref: `r:ext:c1:${long(150)}`, contact: long(500), sujet: long(900), depuis: '2026-10-20T10:00:00Z' }],
          taches: Array.from({ length: 18 }, (_, i) => ({ ref: `t:ext:c1:todo:${long(160)}${i}`, titre: long(900), echeance: '2026-11-03T00:00:00Z' })),
          projets: [{ ref: `p:${long(120)}`, nom: long(400) }],
        },
      },
    });
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
    if (!r.success) return;
    const crm = r.data.body.crm!;
    assert.equal(crm.relances[0].contact.length, 200);
    assert.equal(crm.relances[0].sujet.length, 300);
    assert.equal(crm.relances[0].depuis, '2026-10-20');
    assert.equal(crm.relances[0].ref, `r:ext:c1:${long(150)}`, 'la ref d’une relance reste entière : l’app la relit');
    assert.equal(crm.projets[0].ref, `p:${long(120)}`);
    assert.equal(crm.projets[0].nom.length, 200);
    assert.equal(crm.taches.length, 18);
    assert.equal(crm.taches[0].titre.length, 300);
    assert.equal(crm.taches[0].echeance, '2026-11-03');
    assert.deepEqual(crm.taches.slice(0, 3).map((t) => t.ref), ['t:1', 't:2', 't:3'], 'la ref d’une tâche ne sert pas : elle est raccourcie');
  });
  it('une liste trop longue est raccourcie et un élément inutilisable est ignoré', () => {
    const r = analyseMailsSchema.safeParse({
      body: {
        mails: ['ext:c1:a'],
        crm: {
          relances: [{ ref: 'r:1', contact: 'Paul', sujet: 'Devis', depuis: '2026-10-20' }, { ref: 'x'.repeat(501), contact: 'Léa', sujet: 'x', depuis: '2026-10-21' }, { contact: 'sans ref' }, null],
          taches: Array.from({ length: 60 }, (_, i) => ({ ref: `t:${i}`, titre: `T${i}`, echeance: null })),
          projets: [{ ref: 'p:1', nom: 'Maison' }],
        },
      },
    });
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.deepEqual(r.data.body.crm!.relances.map((x) => x.ref), ['r:1']);
    assert.equal(r.data.body.crm!.taches.length, 40);
  });
  it('« analyseAuto » est un réglage de compte à lui seul', () => {
    const ok = (body: unknown) => patchIntegrationSchema.safeParse({ params: { id: 'c1' }, body }).success;
    assert.equal(ok({ analyseAuto: true }), true);
    assert.equal(ok({ analyseAuto: false }), true);
    assert.equal(ok({ analyseAuto: 'oui' }), false);
    assert.equal(ok({}), false);
  });
});
