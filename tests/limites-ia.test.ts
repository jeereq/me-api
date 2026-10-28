import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express, { type Request, type Response } from 'express';

import { assistantLimiter, estAnalyseMails } from '../src/middlewares/rateLimits.js';

describe("assistant : limites de demandes à l'IA", () => {
  let base = '';
  let fermer = () => {};
  before(async () => {
    const app = express();
    app.use(express.json());
    app.post('/', assistantLimiter, (_req: Request, res: Response) => {
      res.json({ ok: true });
    });
    const serveur = app.listen(0);
    await new Promise((r) => serveur.once('listening', r));
    base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}/`;
    fermer = () => serveur.close();
  });
  after(() => fermer());
  const demander = (type: string) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type }) }).then((r) => r.status);

  it("reconnaît l'analyse des mails par paquets", () => {
    assert.equal(estAnalyseMails({ body: { type: 'mails' } } as never), true);
    assert.equal(estAnalyseMails({ body: { type: 'lot' } } as never), false);
    assert.equal(estAnalyseMails({ body: undefined } as never), false);
  });

  it('analyser 200 non lus (21 paquets) ne bloque pas le reste du copilote', async () => {
    for (let i = 0; i < 21; i++) assert.equal(await demander('mails'), 200, `paquet ${i + 1}`);
    assert.equal(await demander('copilote'), 200);
  });

  it("l'analyse des mails a son propre plafond, et le reste garde le sien", async () => {
    // 21 paquets déjà comptés : 39 de plus atteignent les 60, le suivant est refusé.
    for (let i = 0; i < 39; i++) assert.equal(await demander('mails'), 200);
    assert.equal(await demander('mails'), 429);
    // Une demande « copilote » déjà comptée : 29 de plus atteignent les 30.
    for (let i = 0; i < 29; i++) assert.equal(await demander('question'), 200);
    assert.equal(await demander('plan'), 429);
  });
});
