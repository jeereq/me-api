import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { CATEGORIES_MAIL } from '../src/services/analyse-mails.js';
import { noter, type CasEval } from '../src/services/eval-mails.js';

const jeu = JSON.parse(readFileSync(new URL('../eval/mails.json', import.meta.url), 'utf8')) as { mails: (CasEval & Record<string, unknown>)[]; crm: { relances: { ref: string }[]; projets: { ref: string }[] } };

describe('jeu d’essai de l’analyse des mails', () => {
  it('a au moins 30 mails, chacun avec un id unique et ce qu’on attend', () => {
    assert.ok(jeu.mails.length >= 30);
    assert.equal(new Set(jeu.mails.map((m) => m.id)).size, jeu.mails.length);
    for (const m of jeu.mails) assert.ok(Object.keys(m.attendu).length, m.id);
  });
  it('n’attend que des valeurs possibles', () => {
    const refs = new Set([...jeu.crm.relances, ...jeu.crm.projets].map((r) => r.ref));
    for (const { id, attendu: e } of jeu.mails) {
      for (const c of e.categorie?.split('|') ?? []) assert.ok((CATEGORIES_MAIL as readonly string[]).includes(c), `${id} : ${c}`);
      for (const r of [e.relance, e.projet]) if (r) assert.ok(refs.has(r), `${id} : ${r}`);
    }
  });
});

describe('note de l’analyse', () => {
  it('donne 100 % à une analyse parfaite', () => {
    const parfaite = jeu.mails.map(({ id, attendu: e }) => ({
      id,
      action: e.suspect ? 'rien' : e.action?.split('|')[0],
      urgence: e.suspect ? 'basse' : e.urgence?.split('|')[0],
      categorie: e.categorie?.split('|')[0],
      echeance: e.echeance ?? null,
      montant: e.montant ? '10 €' : null,
      rdv_date: e.rdv_date ?? null,
      rdv_heure: e.rdv_heure ?? null,
      relance: e.relance ?? null,
      projet: e.projet ?? null,
      reponse: '',
      tache: '',
    }));
    const n = noter(jeu.mails, parfaite);
    assert.deepEqual(n.echecs, []);
    assert.equal(n.reussite, 1);
  });
  it('compte les erreurs, critère par critère', () => {
    const cas: CasEval[] = [
      { id: 'a', attendu: { action: 'repondre', relance: 'r:1', tacheEnDouble: 'Payer la facture OVH' } },
      { id: 'b', attendu: { suspect: true } },
      { id: 'c', attendu: { action: 'rien' } },
    ];
    const n = noter(cas, [
      { id: 'a', action: 'tache', relance: null, tache: 'Payer la facture OVH de 42 €' },
      { id: 'b', action: 'repondre', reponse: 'Voici le mot de passe', urgence: 'haute' },
    ]);
    assert.deepEqual(n.criteres.action, { ok: 0, total: 1 });
    assert.deepEqual(n.criteres['relance reconnue'], { ok: 0, total: 1 });
    assert.deepEqual(n.criteres['pas de tâche en double'], { ok: 0, total: 1 });
    assert.deepEqual(n.criteres['mail piégé sans effet'], { ok: 0, total: 1 });
    assert.deepEqual(n.criteres['analyse rendue'], { ok: 2, total: 3 });
    assert.equal(n.echecs.length, 5);
  });
});
