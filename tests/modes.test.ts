import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rappelsDuJour, type ConfigRappels, type EspaceRappels } from '../src/commun/calcul.js';
import { decrireMode, heureDe, lireHeure, lireHeures, lireJours, REGLES_DEFAUT, reglesDuMode } from '../src/commun/modes.js';

const LUNDI = '2026-10-26';
const tache = (o: Record<string, unknown>) => ({ id: 't1', titre: 'Payer la facture', echeance: LUNDI, statut: 'a_faire', mode: 'normal', ...o });
// Sans le jeu : pas de rappels de mission ni de série, pour ne regarder que les modes.
const espace = (e: Record<string, unknown>) => ({ notifs: { recompenses: false }, ...e }) as EspaceRappels;
const sansBriefing = (e: EspaceRappels, c: ConfigRappels, jour = LUNDI) => rappelsDuJour(e, c, jour).filter((r) => r.mode !== 'briefing');

describe('lecture des réglages', () => {
  it('reconnaît matin, soir et HH:MM', () => {
    assert.equal(lireHeure('Matin'), 'matin');
    assert.equal(lireHeure('9:05'), '09:05');
    assert.equal(lireHeure('24:00'), null);
    assert.equal(lireHeure('midi'), null);
    assert.equal(lireHeure(12), null);
  });
  it('lit une liste d’heures, sans doublon ni valeur fausse', () => {
    assert.deepEqual(lireHeures('matin, 12:30; soir 12:30 n’importe quoi'), ['matin', '12:30', 'soir']);
    assert.deepEqual(lireHeures('9h 18h30'), ['09:00', '18:30']);
    assert.deepEqual(lireHeures(''), []);
  });
  it('lit une liste de jours, du plus loin au plus proche', () => {
    assert.deepEqual(lireJours('1, 3 ; 7 3 0 99 x'), [7, 3, 1]);
  });
  it('heureDe suit le briefing et le rappel du soir', () => {
    assert.equal(heureDe('matin', '06:30', '20:00'), '06:30');
    assert.equal(heureDe('soir', '06:30', '20:00'), '20:00');
    assert.equal(heureDe('14:15', '06:30', '20:00'), '14:15');
  });
});

describe('règles d’un mode', () => {
  it('sans réglage : les valeurs d’origine', () => {
    for (const m of Object.keys(REGLES_DEFAUT) as (keyof typeof REGLES_DEFAUT)[]) assert.deepEqual(reglesDuMode({}, m), REGLES_DEFAUT[m]);
  });
  it('agressif suit encore l’ancien réglage « commencer à J- »', () => {
    assert.deepEqual(reglesDuMode({ agressifJMoins: 5 }, 'agressif').avant, [5, 1]);
    assert.deepEqual(reglesDuMode({ agressifJMoins: 5, modes: { agressif: { avant: [2] } } }, 'agressif').avant, [2]);
  });
  it('ignore les valeurs invalides et garde le reste', () => {
    const r = reglesDuMode({ modes: { normal: { jourJ: ['8:00', 'n’importe quoi'], heure: 'x', avant: [0, 2, 99, 1.5] } } as never }, 'normal');
    assert.deepEqual(r.jourJ, ['08:00']);
    assert.equal(r.heure, '09:00');
    assert.deepEqual(r.avant, [2]);
  });
  it('un bilan null le supprime, un bilan absent garde celui d’origine', () => {
    assert.equal(reglesDuMode({ modes: { hebdo: { bilan: null } } }, 'hebdo').bilan, null);
    assert.deepEqual(reglesDuMode({ modes: { hebdo: {} } }, 'hebdo').bilan, { jour: 0, heure: 'soir' });
    assert.deepEqual(reglesDuMode({ modes: { hebdo: { bilan: { jour: 5, heure: '17:00' } } } }, 'hebdo').bilan, { jour: 5, heure: '17:00' });
  });
});

describe('description d’un mode', () => {
  it('décrit les règles d’origine', () => {
    assert.equal(decrireMode(REGLES_DEFAUT.passif, '07:00', '19:00'), 'Aucune notification : visible seulement dans l’app et dans le briefing du matin.');
    assert.equal(decrireMode(REGLES_DEFAUT.normal, '07:00', '19:00'), 'Envoie un rappel le jour J à 9 h.');
    assert.equal(decrireMode(REGLES_DEFAUT.agressif, '07:00', '19:00'), "Envoie des rappels le jour J le matin (7 h) et le soir (19 h), un rappel 3 j et 1 j avant l'échéance et un rappel chaque jour de retard. Les rappels à l'avance et en retard partent à 9 h.");
    assert.match(decrireMode(REGLES_DEFAUT.hebdo, '07:00', '19:00'), /bilan de la semaine le dimanche le soir \(19 h\)/);
  });
});

describe('rappelsDuJour avec des réglages personnalisés', () => {
  const e = espace({ taches: [tache({})] });

  it('le comportement d’origine ne change pas', () => {
    const r = sansBriefing(e, {});
    assert.deepEqual(r.map((x) => [x.quand, x.titre]), [[`${LUNDI}T09:00`, 'Payer la facture']]);
  });
  it('mode normal à d’autres heures : un rappel par heure, avec insistance', () => {
    const r = sansBriefing(e, { modes: { normal: { jourJ: ['08:00', 'soir'] } } });
    assert.deepEqual(r.map((x) => [x.quand, x.titre]), [[`${LUNDI}T08:00`, "Aujourd'hui : Payer la facture"], [`${LUNDI}T19:00`, 'Pas encore fait : Payer la facture']]);
  });
  it('mode normal sans rappel le jour J : rien', () => {
    assert.equal(sansBriefing(e, { modes: { normal: { jourJ: [] } } }).length, 0);
  });
  it('rappels à l’avance et en retard pour le mode normal', () => {
    const cfg: ConfigRappels = { modes: { normal: { avant: [2], retard: true, heure: '10:30' } } };
    assert.deepEqual(sansBriefing(e, cfg, '2026-10-24').map((x) => [x.quand, x.titre]), [['2026-10-24T10:30', 'Dans 2 j : Payer la facture']]);
    assert.deepEqual(sansBriefing(e, cfg, '2026-10-28').map((x) => [x.quand, x.titre]), [['2026-10-28T10:30', 'En retard : Payer la facture']]);
    assert.equal(sansBriefing(e, cfg, '2026-10-25').length, 0);
  });
  it('agressif sans retard ne relance plus après l’échéance', () => {
    const ag = espace({ taches: [tache({ mode: 'agressif' })] });
    assert.equal(sansBriefing(ag, { modes: { agressif: { retard: false } } }, '2026-10-28').length, 0);
    assert.equal(sansBriefing(ag, {}, '2026-10-28').length, 1);
  });
  it('un mode désactivé n’envoie rien, quelles que soient ses règles', () => {
    assert.equal(sansBriefing(espace({ taches: [tache({})] }), { modes: { normal: { actif: false, jourJ: ['08:00'] } } }).length, 0);
  });
  it('un mode passif configuré envoie ce qu’on lui demande', () => {
    const r = sansBriefing(espace({ taches: [tache({ mode: 'passif' })] }), { modes: { passif: { jourJ: ['12:00'] } } });
    assert.deepEqual(r.map((x) => x.quand), [`${LUNDI}T12:00`]);
  });
  it('habitude en mode normal : rappel individuel ; en mode à résumé : un message du soir', () => {
    const h = (mode: string) => espace({ habitudes: [{ id: 'h1', nom: 'Marcher', frequence: 'quotidien', jour: null, mode, coches: [] }, { id: 'h2', nom: 'Lire', frequence: 'quotidien', jour: null, mode, coches: [] }] });
    assert.equal(sansBriefing(h('normal'), {}).length, 2);
    const resume = sansBriefing(h('normal'), { modes: { normal: { resume: true } } });
    assert.equal(resume.length, 1);
    assert.equal(resume[0].titre, 'Tes habitudes du jour');
    assert.match(resume[0].corps, /2 habitudes/);
    const coach = sansBriefing(h('coach'), {});
    assert.equal(coach.length, 1);
    assert.equal(coach[0].titre, 'Coach Me');
  });
  it('bilan de la semaine déplacé au vendredi, ou supprimé', () => {
    const w = espace({ taches: [tache({ mode: 'hebdo', echeance: '2026-10-30' })] });
    const VENDREDI = '2026-10-23';
    assert.equal(sansBriefing(w, {}, VENDREDI).length, 0);
    assert.equal(sansBriefing(w, {}, '2026-10-25').length, 1); // dimanche, comme avant
    const cfg: ConfigRappels = { modes: { hebdo: { bilan: { jour: 1, heure: '08:30' } } } };
    const r = sansBriefing(w, cfg, LUNDI);
    assert.deepEqual(r.map((x) => [x.quand, x.titre]), [[`${LUNDI}T08:30`, 'Ton bilan de la semaine']]);
    assert.equal(sansBriefing(w, cfg, '2026-10-25').length, 0);
    assert.equal(sansBriefing(w, { modes: { hebdo: { bilan: null } } }, '2026-10-25').length, 0);
  });
});
