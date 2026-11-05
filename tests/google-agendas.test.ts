import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { google } from '../src/services/integrations/google.js';

const reponse = (corps: unknown, status = 200) => new Response(JSON.stringify(corps), { status });
const avant = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = avant;
});

describe('liste des agendas Google', () => {
  it('garde l’agenda principal quand le droit de voir la liste manque', async () => {
    globalThis.fetch = (async () => reponse({ error: { code: 403, message: 'Request had insufficient authentication scopes.' } }, 403)) as typeof fetch;
    const l = await google.agendas!({ accessToken: 't' });
    assert.deepEqual(l.map((x) => x.id), ['primary']);
  });
  it('donne tous les agendas sinon', async () => {
    globalThis.fetch = (async () => reponse({ items: [{ id: 'a', summary: 'Moi', primary: true }, { id: 'b', summary: 'Famille' }] })) as typeof fetch;
    assert.deepEqual((await google.agendas!({ accessToken: 't' })).map((x) => x.id), ['a', 'b']);
  });
  it('une panne du service reste une erreur', async () => {
    globalThis.fetch = (async () => reponse({ error: { message: 'x' } }, 500)) as typeof fetch;
    await assert.rejects(() => google.agendas!({ accessToken: 't' }));
  });
});
