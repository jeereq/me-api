import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { etatPayout, manquePayout, oublierJetonPayout, Payout, payoutConfigure, raisonPayout } = await import('../src/services/cotisations/payout.js');

const ENV = { FLEXPAIE_PAYOUT_URL: 'https://payout.test:8443/', FLEXPAIE_PAYOUT_USERNAME: 'me', FLEXPAIE_PAYOUT_PASSWORD: 'secret', FLEXPAIE_PAYOUT_MARCHAND: 'ME' };

describe('FlexPaie Payout', () => {
  const avant = { ...process.env };
  const vraiFetch = globalThis.fetch;
  let appels: { url: string; init: RequestInit }[];
  let reponses: ((url: string) => { status?: number; body: unknown })[];

  beforeEach(() => {
    Object.assign(process.env, ENV);
    oublierJetonPayout();
    appels = [];
    reponses = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      appels.push({ url, init });
      const r: { status?: number; body: unknown } = (reponses.shift() ?? (() => ({ body: {} })))(url);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = vraiFetch;
    for (const k of Object.keys(ENV)) delete process.env[k];
    Object.assign(process.env, avant);
  });

  it('dit ce qui manque, sans valeur', () => {
    assert.equal(payoutConfigure(ENV), true);
    assert.deepEqual(manquePayout({ FLEXPAIE_MARCHAND: 'X' }), ['FLEXPAIE_PAYOUT_URL', 'FLEXPAIE_PAYOUT_USERNAME', 'FLEXPAIE_PAYOUT_PASSWORD']);
  });

  it('lit les statuts de FlexPaie', () => {
    assert.match(raisonPayout('0XX2').texte, /Solde FlexPaie insuffisant/);
    assert.match(raisonPayout('0XX1').texte, /30 secondes/);
    assert.equal(raisonPayout('0XX4').jeton, true);
    assert.equal(etatPayout({ code: '0', status: '0' }), 'paye');
    assert.equal(etatPayout({ code: '0', status: '1' }), 'echoue');
    assert.equal(etatPayout({ code: '1' }), 'en_attente');
  });

  it('s’authentifie, verse avec le jeton, et le garde', async () => {
    reponses.push(() => ({ body: { code: '0', token: 'Bearer abc', expire_in: 3600 } }));
    reponses.push(() => ({ body: { code: '0', status: '0XX0', message: 'Success', orderNumber: 'ORD1' } }));
    reponses.push(() => ({ body: { code: '0', reference: 'TO1', orderNumber: 'ORD1', providerReference: 'OP9', status: '0' } }));
    const r = await Payout.verser({ telephone: '243812345678', reference: 'TO1', montant: 1050, devise: 'USD', retour: 'https://api.test/retour' });
    assert.equal(r.commande, 'ORD1');
    assert.equal(appels[0].url, 'https://payout.test:8443/api/v1/auth/authenticate');
    assert.equal(appels[1].url, 'https://payout.test:8443/api/rest/v1/pay');
    const corps = JSON.parse(String(appels[1].init.body));
    assert.deepEqual({ ...corps, description: undefined }, { merchant: 'ME', type: '1', reference: 'TO1', amount: '10.50', currency: 'USD', customer: '243812345678', callback_url: 'https://api.test/retour', description: undefined });
    assert.equal((appels[1].init.headers as Record<string, string>).Authorization, 'Bearer abc');
    const v = await Payout.verifier('ORD1');
    assert.deepEqual(v, { etat: 'paye', message: '', operateur: 'OP9', reference: 'TO1' });
    // Le jeton n'est demandé qu'une fois.
    assert.equal(appels.filter((a) => a.url.endsWith('/authenticate')).length, 1);
  });

  it('renouvelle un jeton refusé, et explique un refus', async () => {
    reponses.push(() => ({ body: { code: '0', token: 'vieux', expire_in: 3600 } }));
    reponses.push(() => ({ status: 401, body: { message: 'Unauthorized' } }));
    reponses.push(() => ({ body: { code: '0', token: 'neuf', expire_in: 3600 } }));
    reponses.push(() => ({ body: { code: '1', status: '0XX2', message: 'Balance' } }));
    await assert.rejects(Payout.verser({ telephone: '243812345678', reference: 'TO2', montant: 100, devise: 'CDF', retour: 'https://api.test/retour' }), /Solde FlexPaie insuffisant/);
    assert.equal((appels[3].init.headers as Record<string, string>).Authorization, 'Bearer neuf');
  });

  it('lit le solde par devise', async () => {
    reponses.push(() => ({ body: { code: '0', token: 't', expire_in: 3600 } }));
    reponses.push(() => ({ body: { code: '0', balances: [{ currency: 'USD', amount: '10' }, { currency: 'CDF', amount: '5000' }] } }));
    assert.deepEqual(await Payout.solde(), [
      { devise: 'USD', montant: 1000 },
      { devise: 'CDF', montant: 500000 },
    ]);
    assert.equal(appels[1].url, 'https://payout.test:8443/api/rest/v1/balance/ME');
  });
});
