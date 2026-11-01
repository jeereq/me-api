import cron from 'node-cron';

import { AnalyseMailService } from '../services/AnalyseMailService.js';
import { avecVerrou } from '../utils/verrou.js';

/**
 * Toutes les 15 minutes (7 minutes après la synchronisation des comptes) : prépare l'analyse des nouveaux mails non lus
 * des comptes dont l'utilisateur l'a demandé. Chaque nuit à 4 h 10 : efface les analyses gardées depuis plus de 30 jours.
 */
export function initAnalysesCron() {
  let enCours = false;
  cron.schedule('7,22,37,52 * * * *', async () => {
    if (enCours) return;
    enCours = true;
    try {
      // Bail de 14 min (< période) : une seule instance prépare à la fois.
      await avecVerrou('analyses-mails', 840, async () => {
        const r = await AnalyseMailService.preparerNouveaux();
        if (r.mails) console.log(`Analyses à l'avance : ${r.mails} mail(s) sur ${r.comptes} compte(s).`);
      });
    } catch (e) {
      console.error('Analyses à l’avance', e);
    } finally {
      enCours = false;
    }
  });

  cron.schedule('10 4 * * *', async () => {
    try {
      await avecVerrou('analyses-mails-menage', 600, async () => {
        const r = await AnalyseMailService.purger();
        if (r.effacees) console.log(`Analyses de mails : ${r.effacees} analyse(s) de plus de ${r.jours} jours effacée(s).`);
      });
    } catch (e) {
      console.error('Ménage des analyses de mails', e);
    }
  });
}
