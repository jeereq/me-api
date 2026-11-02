import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { imageRefusee } from '../src/services/AssistantService.js';
import { consignesFacture, imagePourIA, lireLecture, messagesFacture, SCHEMA_FACTURE } from '../src/services/justificatifs/lecture-ia.js';
import { analyseJustificatifSchema } from '../src/validators/schemas.js';

const ctx = { aujourdhui: '2026-11-02', devise: 'USD', categories: [{ id: 'c1', nom: 'Alimentation' }, { id: 'c2', nom: 'Transport' }] };

describe('lecture des factures : image envoyée', () => {
  it('demande à Cloudinary la photo ou la 1re page du PDF en JPEG', () => {
    assert.equal(imagePourIA('mon-cloud', 'me/justificatifs/u1/recu'), 'https://res.cloudinary.com/mon-cloud/image/upload/c_limit,w_1600,h_1600,pg_1,f_jpg,q_auto/me/justificatifs/u1/recu.jpg');
  });
  it('échappe les morceaux du chemin sans toucher aux barres', () => {
    assert.match(imagePourIA('c', 'dossier/reçu 1'), /\/dossier\/re%C3%A7u%201\.jpg$/);
  });
  it("envoie l'image en data URL avec les consignes en message système", () => {
    const m = messagesFacture(ctx, 'QUJD');
    assert.equal(m[0].role, 'system');
    const parts = m[1].content as { type: string; image_url?: { url: string } }[];
    assert.equal(parts[1].image_url?.url, 'data:image/jpeg;base64,QUJD');
  });
  it('donne au modèle les catégories, la date du jour et la devise principale', () => {
    const t = consignesFacture(ctx);
    assert.match(t, /"id":"c1","nom":"Alimentation"/);
    assert.match(t, /2026-11-02/);
    assert.match(t, /"USD"/);
  });
  it('impose tous les champs dans la forme stricte', () => {
    assert.deepEqual([...SCHEMA_FACTURE.schema.required].sort(), Object.keys(SCHEMA_FACTURE.schema.properties).sort());
  });
});

describe('lecture des factures : réponse relue', () => {
  it('garde une lecture propre', () => {
    const r = lireLecture(JSON.stringify({ facture: true, montant: 42.5, devise: 'usd', date: '2026-10-30', heure: '9:05', marchand: 'Carrefour', description: 'Courses', categorie: 'c1', confiance: 'haute' }), ctx);
    assert.deepEqual(r, { facture: true, montant: 42.5, devise: 'USD', date: '2026-10-30', heure: '09:05', marchand: 'Carrefour', description: 'Courses', categorie: 'c1', confiance: 'haute' });
  });
  it('écarte une catégorie inventée, une date impossible ou future, un montant négatif', () => {
    const r = lireLecture(JSON.stringify({ facture: true, montant: -3, devise: 'dollars', date: '2026-02-31', heure: '25:00', marchand: '', categorie: 'Courses', confiance: 'haute' }), ctx);
    assert.equal(r.montant, null);
    assert.equal(r.devise, null);
    assert.equal(r.date, null);
    assert.equal(r.heure, null);
    assert.equal(r.marchand, null);
    assert.equal(r.categorie, null);
    assert.equal(r.confiance, 'basse');
    assert.equal(lireLecture(JSON.stringify({ facture: true, montant: 3, date: '2026-12-01' }), ctx).date, null);
  });
  it('traduit les symboles de devise courants', () => {
    assert.equal(lireLecture(JSON.stringify({ montant: 1, devise: '€' }), ctx).devise, 'EUR');
    assert.equal(lireLecture(JSON.stringify({ montant: 1, devise: 'FC' }), ctx).devise, 'CDF');
  });
  it('lit un montant écrit en texte avec une virgule', () => {
    assert.equal(lireLecture(JSON.stringify({ montant: '12 500,75' }), ctx).montant, 12500.75);
  });
  it("vide tout quand l'image n'est pas une facture", () => {
    const r = lireLecture(JSON.stringify({ facture: false, montant: 10, marchand: 'Chat', confiance: 'haute' }), ctx);
    assert.equal(r.facture, false);
    assert.equal(r.montant, null);
    assert.equal(r.marchand, null);
    assert.equal(r.confiance, 'basse');
  });
  it('ne plante pas sur un JSON abîmé ou entouré de texte', () => {
    assert.equal(lireLecture('pas du json', ctx).montant, null);
    assert.equal(lireLecture('Voici : {"montant": 7}', ctx).montant, 7);
  });
});

describe('lecture des factures : demande et erreurs', () => {
  it('valide la demande de l’app et remplit les valeurs par défaut', () => {
    const ok = analyseJustificatifSchema.safeParse({ body: { id: 'me/j/u/x', aujourdhui: '2026-11-02' } });
    assert.equal(ok.success, true);
    if (ok.success) assert.deepEqual(ok.data.body.categories, []);
    assert.equal(analyseJustificatifSchema.safeParse({ body: { id: 'x', aujourdhui: '02/11/2026' } }).success, false);
  });
  it("reconnaît un modèle qui ne lit pas les images, sans confondre avec un refus de la forme JSON", () => {
    assert.equal(imageRefusee(400, 'Invalid content type. image_url is only supported by certain models.'), true);
    assert.equal(imageRefusee(400, "Invalid parameter: 'response_format' of type 'json_schema' is not supported"), false);
    assert.equal(imageRefusee(500, 'image'), false);
  });
});
