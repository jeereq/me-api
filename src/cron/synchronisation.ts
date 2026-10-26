import cron from 'node-cron';

import { IntegrationService } from '../services/IntegrationService.js';
import { avecVerrou } from '../utils/verrou.js';

/** Synchronise tous les comptes connectés toutes les 15 minutes. */
export function initSynchronisationCron() {
  let enCours = false;
  cron.schedule('*/15 * * * *', async () => {
    if (enCours) return;
    enCours = true;
    try {
      // Bail de 14 min (< période) : une seule instance synchronise à la fois.
      await avecVerrou('synchronisation', 840, () => IntegrationService.synchroniserTout());
    } catch (e) {
      console.error('Synchro planifiée', e);
    } finally {
      enCours = false;
    }
  });
}
