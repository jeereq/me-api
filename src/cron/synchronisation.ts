import cron from 'node-cron';

import { IntegrationService } from '../services/IntegrationService.js';

/** Synchronise tous les comptes connectés toutes les 15 minutes. */
export function initSynchronisationCron() {
  let enCours = false;
  cron.schedule('*/15 * * * *', async () => {
    if (enCours) return;
    enCours = true;
    try {
      await IntegrationService.synchroniserTout();
    } catch (e) {
      console.error('Synchro planifiée', e);
    } finally {
      enCours = false;
    }
  });
}
