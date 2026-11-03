import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { aDroit, etatAbonnement, FONCTIONS_PRO } from '../src/services/abonnements/offres.js';
import { adresseService, Asmsc, cleValide, codeValide, configSms, creerCode, empreinteCode, ErreurSms, preparerTexte, placeSms, raisonPanne, rappelsParSms, rappelSecondaire, statutLivraison, texteCode, texteRappels, type ConfigSms } from '../src/services/sms/asmsc.js';

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

describe('adresse du service', () => {
  const attendue = 'https://papi.dream-digital.info';
  it('accepte toutes les façons de la coller', () => {
    for (const brut of ['https://papi.dream-digital.info', 'https://papi.dream-digital.info/', 'papi.dream-digital.info', ' papi.dream-digital.info ', '"https://papi.dream-digital.info"', 'https://papi.dream-digital.info/api', 'https://papi.dream-digital.info/api/', 'https://papi.dream-digital.info/api/SendSms']) assert.equal(adresseService(brut), attendue, brut);
  });
  it('retire les paramètres d’un lien complet, mot de passe compris', () => {
    assert.equal(adresseService('https://papi.dream-digital.info/api/SendSms?api_id=X&api_password=secret&sms_type=T'), attendue);
  });
  it('garde le http et le port s’ils sont donnés', () => {
    assert.equal(adresseService('http://sms.exemple.com:8080/'), 'http://sms.exemple.com:8080');
  });
  it('reste vide sans valeur', () => {
    assert.equal(adresseService('SMS_API_URL=https://sms.exemple.com'), 'https://sms.exemple.com');
    assert.equal(adresseService(undefined), '');
    assert.equal(adresseService('  '), '');
  });
});

describe('raison d’une panne', () => {
  const panne = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
  it('dit ce qui bloque, avec le code d’origine', () => {
    assert.match(raisonPanne(panne('ENOTFOUND')), /ne trouve pas l’adresse.*ENOTFOUND/);
    assert.match(raisonPanne(panne('ENOTFOUND'), 'sms.exemple.com'), /adresse sms\.exemple\.com \(ENOTFOUND\)/);
    assert.match(raisonPanne(panne('ECONNREFUSED')), /refuse la connexion.*ECONNREFUSED/);
    assert.match(raisonPanne(panne('UND_ERR_CONNECT_TIMEOUT')), /refuse la connexion/);
    assert.match(raisonPanne(panne('UNABLE_TO_VERIFY_LEAF_SIGNATURE')), /certificat.*UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
    assert.match(raisonPanne(panne('CERT_HAS_EXPIRED')), /certificat/);
    assert.match(raisonPanne(panne('ERR_TLS_CERT_ALTNAME_INVALID')), /certificat/);
    assert.match(raisonPanne(panne('ERR_INVALID_URL')), /invalide/);
    assert.match(raisonPanne(panne('EPROTO')), /injoignable \(EPROTO\)/);
  });
  it('reconnaît un délai dépassé', () => {
    assert.match(raisonPanne(Object.assign(new Error('x'), { name: 'TimeoutError' })), /trop de temps/);
  });
  it('reste générique sans code', () => {
    assert.equal(raisonPanne(new Error('https://hote secret')), 'Le service SMS est injoignable.');
  });
});

describe('réponse 404 du service', () => {
  const cfg404: ConfigSms = { url: 'https://sms.exemple.com', id: 'API1', motDePasse: 'secret', expediteur: 'ME', marque: 'Me' };
  const repondre = (ok: (methode: string, route: string) => unknown) => {
    const appels: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const route = url.split('/api/')[1];
      const methode = init?.method ?? 'GET';
      appels.push(`${methode} ${route.split('?')[0]}`);
      const corps = ok(methode, route.split('?')[0]);
      return corps ? new Response(JSON.stringify(corps)) : new Response('introuvable', { status: 404 });
    }) as typeof fetch;
    return appels;
  };
  const m = { telephone: '243812345678', texte: 'x', uid: 'u' };
  it('essaie l’orthographe de la documentation', async () => {
    const appels = repondre((_, r) => (r === 'SendSMS' ? { status: 'S', message_id: 7 } : null));
    assert.deepEqual(await Asmsc.envoyer(cfg404, m), { messageId: '7' });
    assert.deepEqual(appels, ['POST SendSms', 'POST SendSMS']);
  });
  it('finit par GET, la forme des liens du panneau', async () => {
    const appels = repondre((methode) => (methode === 'GET' ? { status: 'S', message_id: 8 } : null));
    assert.deepEqual(await Asmsc.envoyer(cfg404, m), { messageId: '8' });
    assert.deepEqual(appels, ['POST SendSms', 'POST SendSMS', 'GET SendSms']);
  });
  it('nomme la route en échec, sans le mot de passe', async () => {
    repondre(() => null);
    await assert.rejects(Asmsc.envoyer(cfg404, m), (e: Error) => /404 sur sms\.exemple\.com\/api\/SendSms\./.test(e.message) && !e.message.includes('secret'));
  });
  it('rapporte la précision donnée par le service', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ remarks: 'Compte inconnu' }), { status: 404 })) as typeof fetch;
    await assert.rejects(Asmsc.solde(cfg404), /CheckBalance : Compte inconnu\./);
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
  it('envoie aussi les discrets, le briefing et la série, après ce qui est à faire', () => {
    const l = [r('passif', 'a'), r('briefing', 'b'), r('coach', '2026-11-03|serie'), r('agressif', 'c')];
    assert.deepEqual(rappelsParSms(l).map((x) => x.cle), ['c', 'a', 'b', '2026-11-03|serie']);
    assert.equal(rappelSecondaire(l[0]), true);
    assert.equal(rappelSecondaire(l[3]), false);
  });
  it('garde des places chaque jour pour ce qui est à faire', () => {
    assert.equal(placeSms(2, 5, true), true);
    assert.equal(placeSms(3, 5, true), false);
    assert.equal(placeSms(4, 5, false), true);
    assert.equal(placeSms(5, 5, false), false);
    assert.equal(placeSms(0, 1, true), true);
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
      api_id: 'API1', api_password: 'secret@123', sms_type: 'T', encoding: 'T', sender_id: 'ME', phonenumber: '243812345678', textmessage: 'Rappel', uid: 'u1', callback_url: 'https://me/retour',
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

describe('code de vérification du numéro', () => {
  it('fait 6 chiffres', () => {
    for (let i = 0; i < 200; i++) assert.match(creerCode(), /^\d{6}$/);
  });
  it('n’est valable que pour ce compte et ce numéro', () => {
    const e = empreinteCode('123456', 'u1', '243812345678', 's');
    assert.equal(e.includes('123456'), false);
    assert.equal(codeValide('123456', e, 'u1', '243812345678', 's'), true);
    assert.equal(codeValide('000000', e, 'u1', '243812345678', 's'), false);
    assert.equal(codeValide('123456', e, 'u2', '243812345678', 's'), false);
    assert.equal(codeValide('123456', e, 'u1', '243899999999', 's'), false);
    assert.equal(codeValide('123456', 'autre', 'u1', '243812345678', 's'), false);
  });
  it('tient en un SMS', () => {
    const r = preparerTexte(texteCode('Me', '123456'));
    assert.equal(r.encodage, 'T');
    assert.equal(r.texte, 'Me : ton code est 123456. Il expire dans 10 minutes.');
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
