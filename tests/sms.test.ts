import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { aDroit, etatAbonnement, FONCTIONS_PRO } from '../src/services/abonnements/offres.js';
import { Asmsc, cleValide, configSms, ErreurSms, preparerTexte, rappelsParSms, statutLivraison, texteRappels, type ConfigSms } from '../src/services/sms/asmsc.js';

const fetchOrigine = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOrigine;
});

const cfg: ConfigSms = { url: 'https://sms.exemple.com', id: 'API1', motDePasse: 'secret@123', expediteur: 'ME', marque: 'Me' };

/** Remplace fetch : garde les appels et répond ce qu'on lui donne. */
function simuler(reponse: unknown, status = 200) {
  const appels: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    appels.push({ url, init });
    return new Response(JSON.stringify(reponse), { status });
  }) as typeof fetch;
  return { appels, corps: () => JSON.parse(String(appels[0].init.body)) as Record<string, unknown> };
}

describe('configuration', () => {
  const env = { SMS_API_URL: 'https://sms.exemple.com/', SMS_API_ID: 'API1', SMS_API_PASSWORD: 'p', SMS_SENDER_ID: 'ME' };
  it('lit les variables et retire le / final', () => {
    assert.deepEqual(configSms(env), { url: 'https://sms.exemple.com', id: 'API1', motDePasse: 'p', expediteur: 'ME', marque: 'Me' });
  });
  it('reste éteint tant qu’il manque quelque chose', () => {
    for (const k of Object.keys(env)) assert.equal(configSms({ ...env, [k]: '' }), null, k);
  });
});

describe('texte d’un SMS', () => {
  it('reste en texte simple malgré la ponctuation et les accents français', () => {
    const r = preparerTexte('Demain : rendre 12 € à l’être « cher » · fête… çà');
    assert.equal(r.encodage, 'T');
    assert.equal(r.texte, 'Demain : rendre 12 € à l\'etre "cher" - fete... cà');
  });
  it('passe en Unicode pour un emoji ou un autre alphabet', () => {
    assert.equal(preparerTexte('Rappel 🔔').encodage, 'U');
    assert.equal(preparerTexte('تذكير').encodage, 'U');
  });
  it('tient en un seul SMS : 160 en texte, 70 en Unicode', () => {
    const t = preparerTexte('a'.repeat(300));
    assert.equal(t.texte.length, 160);
    assert.ok(t.texte.endsWith('...'));
    assert.equal(preparerTexte('🔔'.repeat(100)).encodage, 'U');
    assert.ok([...preparerTexte('b🔔'.repeat(100)).texte].length <= 70);
  });
  it('compte double les caractères étendus', () => {
    const r = preparerTexte('€'.repeat(100));
    assert.equal(r.texte, `${'€'.repeat(78)}...`);
  });
  it('un rappel seul donne son titre et son texte, plusieurs leur nombre et leurs titres', () => {
    assert.equal(texteRappels([{ titre: 'A', corps: 'détail' }]), 'A. détail');
    assert.equal(texteRappels([{ titre: 'A', corps: 'x' }, { titre: 'B', corps: 'y' }]), '2 rappels : A ; B');
  });
});

describe('rappels envoyés par SMS', () => {
  const r = (mode: string, cle: string, canaux?: { push: boolean; email: boolean }) => ({ mode, cle, canaux });
  it('garde ce qui est à faire, quel que soit son mode', () => {
    const l = [r('agressif', '2026-11-03|relance|r1|jour'), r('normal', '2026-11-03|tache|t1|jour'), r('coach', '2026-11-03|tache|t2|soir')];
    assert.deepEqual(rappelsParSms(l), l);
  });
  it('écarte les discrets, le briefing et les encouragements de la série', () => {
    assert.deepEqual(rappelsParSms([r('passif', 'a'), r('briefing', 'b'), r('coach', '2026-11-03|serie')]), []);
  });
  it('écarte une alerte dont le push et l’email sont coupés', () => {
    assert.deepEqual(rappelsParSms([r('hebdo', 'a', { push: false, email: false })]), []);
    assert.equal(rappelsParSms([r('hebdo', 'a', { push: false, email: true })]).length, 1);
  });
});

describe('envoi', () => {
  it('poste les paramètres de la documentation, en transactionnel', async () => {
    const s = simuler({ message_id: 4125, status: 'S', remarks: 'ok', uid: 'u1' });
    const r = await Asmsc.envoyer(cfg, { telephone: '243812345678', texte: 'Rappel', uid: 'u1', retour: 'https://me/retour' });
    assert.equal(s.appels[0].url, 'https://sms.exemple.com/api/SendSms');
    assert.equal(s.appels[0].init.method, 'POST');
    assert.deepEqual(s.corps(), {
      api_id: 'API1', api_password: 'secret@123', sms_type: 'T', encoding: 'T', sender_id: 'ME', phonenumber: '243812345678', textmessage: 'Rappel', ValidityPeriodInSeconds: 21600, uid: 'u1', callback_url: 'https://me/retour',
    });
    assert.deepEqual(r, { messageId: '4125' });
  });
  it('ne met jamais le mot de passe dans l’adresse', async () => {
    const s = simuler({ status: 'S' });
    await Asmsc.envoyer(cfg, { telephone: '243812345678', texte: 'x', uid: 'u' });
    assert.ok(!s.appels[0].url.includes('secret'));
    assert.ok(!('callback_url' in s.corps()));
  });
  it('un statut F devient une erreur avec la remarque du service', async () => {
    simuler({ status: 'F', remarks: 'Sender ID invalide' });
    await assert.rejects(Asmsc.envoyer(cfg, { telephone: '1', texte: 'x', uid: 'u' }), new ErreurSms('Sender ID invalide'));
  });
  it('une panne ne révèle ni l’adresse ni le mot de passe', async () => {
    globalThis.fetch = (async () => {
      throw new Error('https://sms.exemple.com secret@123');
    }) as typeof fetch;
    await assert.rejects(Asmsc.envoyer(cfg, { telephone: '1', texte: 'x', uid: 'u' }), (e: Error) => e instanceof ErreurSms && !e.message.includes('secret') && !e.message.includes('exemple'));
  });
  it('une réponse illisible ou une erreur HTTP est une erreur', async () => {
    simuler({ status: 'S' }, 500);
    await assert.rejects(Asmsc.envoyer(cfg, { telephone: '1', texte: 'x', uid: 'u' }), ErreurSms);
  });
});

describe('vérification du numéro', () => {
  it('demande un code avec l’orthographe de la documentation', async () => {
    const s = simuler({ verfication_id: 4, status: 'S' });
    assert.equal(await Asmsc.demanderVerification(cfg, '243812345678'), '4');
    assert.equal(s.appels[0].url, 'https://sms.exemple.com/api/Verify');
    assert.deepEqual(s.corps(), { api_id: 'API1', api_password: 'secret@123', brand: 'Me', phonenumber: '243812345678', sender_id: 'ME' });
  });
  it('lit aussi l’orthographe correcte, et refuse un envoi sans identifiant', async () => {
    simuler({ verification_id: 9, status: 'S' });
    assert.equal(await Asmsc.demanderVerification(cfg, '1'), '9');
    simuler({ status: 'S' });
    await assert.rejects(Asmsc.demanderVerification(cfg, '1'), ErreurSms);
  });
  it('V valide le code, F le refuse', async () => {
    const s = simuler({ verfication_id: 2, status: 'V' });
    assert.equal(await Asmsc.controlerCode(cfg, '2', '4022'), true);
    assert.equal(s.appels[0].url, 'https://sms.exemple.com/api/VerifyStatus');
    assert.deepEqual(s.corps(), { verfication_id: '2', verfication_code: '4022' });
    simuler({ status: 'F' });
    assert.equal(await Asmsc.controlerCode(cfg, '2', '0000'), false);
  });
});

describe('solde et livraison', () => {
  it('lit le solde, champ mal orthographié compris', async () => {
    simuler({ BalanceAmount: 12.5, CurrenceCode: 'USD' });
    assert.deepEqual(await Asmsc.solde(cfg), { montant: 12.5, devise: 'USD' });
    simuler({});
    await assert.rejects(Asmsc.solde(cfg), ErreurSms);
  });
  it('traduit l’état de livraison', () => {
    assert.equal(statutLivraison('Delivered'), 'delivre');
    for (const s of ['Undeliverable', 'Expired', 'Rejected', 'Failed', 'DND']) assert.equal(statutLivraison(s), 'echec', s);
    for (const s of ['Pending', 'Accepted', 'Acknowledged', 'Unknown', undefined]) assert.equal(statutLivraison(s), 'soumis', String(s));
  });
  it('refuse l’adresse de retour sans la bonne clé', () => {
    assert.equal(cleValide('abc', 'abc'), true);
    assert.equal(cleValide('abd', 'abc'), false);
    assert.equal(cleValide('ab', 'abc'), false);
    assert.equal(cleValide(undefined, 'abc'), false);
    assert.equal(cleValide('abc', undefined), false);
  });
});

describe('droits', () => {
  it('le SMS fait partie de Pro, pas de Finances ni de Gratuit', () => {
    assert.ok('sms' in FONCTIONS_PRO);
    const fin = new Date('2030-01-01');
    const maintenant = new Date('2026-11-03');
    assert.equal(aDroit(etatAbonnement({ abonnementFormule: 'pro', abonnementFinLe: fin }, maintenant, true, null), 'sms'), true);
    assert.equal(aDroit(etatAbonnement({ abonnementFormule: 'finances', abonnementFinLe: fin }, maintenant, true, null), 'sms'), false);
    assert.equal(aDroit(etatAbonnement({}, maintenant, true, null), 'sms'), false);
  });
});
