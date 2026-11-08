import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { aDesFinances, periodeCourte, periodeDite, rapportDepenses, rapportsDuSoir, somme } from '../src/commun/rapport.js';
import { avisRapport, emailRapport, smsRapport } from '../src/services/rapport-email.js';
import { preparerTexte, tientEnUnSms } from '../src/services/sms/asmsc.js';

const dep = (id: string, date: string, montant: number, cat: string, note = '') => ({ id, date, montant, categories: [cat], budget: null, note });
const noms = [{ id: 'c1', nom: 'Repas', emoji: '🍽' }, { id: 'c2', nom: 'Transport' }, { id: 'c3', nom: 'Logement' }];
const f = {
  devise: 'CDF',
  budgets: [
    { id: 'b1', nom: 'Repas', emoji: '🍽', montant: 10000, periode: 'jour' as const, categories: ['c1'] },
    { id: 'b2', nom: 'Tout', emoji: '💰', montant: 600000, periode: 'mois' as const, global: true },
  ],
  depenses: [
    ...Array.from({ length: 20 }, (_, i) => dep(`h${i}`, `2026-10-${String(10 + i).padStart(2, '0')}`, 12000, 'c1')),
    dep('a', '2026-11-08', 15000, 'c1', 'Restaurant'),
    dep('b', '2026-11-08', 8000, 'c2', 'Taxi'),
    dep('c', '2026-11-08', 5000, 'c1'),
    dep('d', '2026-11-03', 200000, 'c3', 'Loyer'),
    // Une moitié de virement entre deux comptes ne compte pas.
    { id: 'v', date: '2026-11-08', montant: 99999, budget: null, lien: 'x' },
  ],
  revenus: [{ id: 'r', date: '2026-11-01', montant: 900000 }],
};

describe('rapport des dépenses', () => {
  it('nomme chaque période', () => {
    assert.equal(periodeDite('jour', '2026-11-08'), 'du 8 novembre');
    assert.equal(periodeDite('semaine', '2026-11-08'), 'de la semaine du 2 au 8 novembre');
    assert.equal(periodeDite('semaine', '2026-12-01'), 'de la semaine du 30 novembre au 6 décembre');
    assert.equal(periodeDite('mois', '2026-08-08'), "d'août 2026");
    assert.equal(periodeDite('trimestre', '2026-02-08'), 'du 1er trimestre 2026');
    assert.equal(periodeDite('trimestre', '2026-11-08'), 'du 4e trimestre 2026');
    assert.equal(periodeDite('annee', '2026-11-08'), 'de 2026');
    assert.equal(periodeCourte('trimestre', '2026-10-01'), 'T4 2026');
    assert.equal(somme(372000, 'FC'), '372 000 FC');
    assert.equal(somme(12.5, '$'), '12,50 $');
    assert.equal(somme(15285.71, 'FC'), '15 286 FC');
  });

  it('le jour : total, catégories, budget dépassé, reste du mois, habitude', () => {
    const r = rapportDepenses(f, 'jour', '2026-11-08', '2026-11-08', noms);
    assert.equal(r.titre, 'Tes dépenses du 8 novembre');
    assert.equal(r.depenses, 28000);
    assert.equal(r.nombre, 3);
    assert.deepEqual(r.categories[0], { nom: '🍽 Repas', montant: 20000, part: 71 });
    assert.equal(r.plusGrosse?.note, 'Restaurant');
    assert.ok(r.budgets.some((b) => b.nom === '🍽 Repas' && b.depasse && b.reste === -10000));
    assert.deepEqual(r.resteMois, { reste: 372000, jours: 22, parJour: 16909 });
    assert.ok(r.habitude! > 15000 && r.habitude! < 15500);
    assert.deepEqual(r.conseils.map((c) => c.ton), ['alerte', 'conseil', 'alerte']);
    assert.match(r.conseils[0].texte, /au-dessus du budget\. Vise moins de 10 000 FC demain/);
    assert.equal(r.conseils[1].court, 'Reste du mois : 372 000 FC, soit 16 909 FC/jour.');
  });

  it('le mois et l’année : revenus, épargne, ce qui pèse le plus', () => {
    const m = rapportDepenses(f, 'mois', '2026-11-08', '2026-11-08', noms);
    assert.equal(m.revenus, 900000);
    assert.equal(m.resteMois, null);
    assert.ok(m.conseils.some((c) => c.ton === 'bravo' && /resté de côté/.test(c.texte)));
    assert.ok(m.conseils.some((c) => /Logement fait 88 %/.test(c.texte)));
    const a = rapportDepenses(f, 'annee', '2026-11-08', '2026-11-08', noms);
    assert.equal(a.titre, 'Tes dépenses de 2026');
    assert.equal(a.depenses, 468000);
  });

  it('un jour sans dépense invite à noter un oubli', () => {
    const r = rapportDepenses(f, 'jour', '2026-11-09', '2026-11-09', noms);
    assert.equal(r.nombre, 0);
    assert.ok(r.conseils.some((c) => /Un achat oublié/.test(c.texte)));
  });

  it('quand l’envoyer : chaque soir, et le dernier jour des périodes choisies', () => {
    assert.deepEqual(rapportsDuSoir(f, '2026-11-08').map((x) => [x.periode, x.heure]), [['jour', '21:00']]);
    const g = { ...f, alertes: { rapport: { heure: '20:00', periodes: { semaine: true, mois: true, trimestre: true, annee: true } } } };
    assert.deepEqual(rapportsDuSoir(g, '2026-11-08').map((x) => x.cle), ['rapport|jour|2026-11-08', 'rapport|semaine|2026-11-02']);
    assert.deepEqual(rapportsDuSoir(g, '2026-12-31').map((x) => x.periode), ['jour', 'mois', 'trimestre', 'annee']);
    assert.deepEqual(rapportsDuSoir({ ...g, alertes: { rapport: { soir: false } } }, '2026-11-08'), []);
    assert.equal(aDesFinances({}), false);
    assert.equal(aDesFinances(f), true);
  });

  it('SMS, notification et email clairs', () => {
    const r = rapportDepenses(f, 'jour', '2026-11-08', '2026-11-08', noms);
    const s = smsRapport(r, 'https://me.neevo.app/finances');
    assert.ok(s.startsWith('Dépenses du 8/11 : 28 000 FC (3 dépenses). Repas dépassé de 10 000 FC.'), s);
    assert.ok(tientEnUnSms(s));
    assert.equal(preparerTexte(s).encodage, 'T');
    assert.match(avisRapport(r).corps, /^28 000 FC dépensés en 3 dépenses/);
    const e = emailRapport([r, rapportDepenses(f, 'semaine', '2026-11-08', '2026-11-08', noms)], 'Jeereq', 'https://me.neevo.app/finances');
    assert.equal(e.sujet, 'Tes dépenses du 8 novembre et de la semaine du 2 au 8 novembre');
    assert.match(e.html, /Conseils/);
    assert.doesNotMatch(e.html, /<script/);
  });
});
