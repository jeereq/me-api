import cron from 'node-cron';

import { IntegrationService } from '../services/IntegrationService.js';
import { avecVerrou } from '../utils/verrou.js';

/** Synchronise tous les comptes connectés toutes les 15 minutes, et regarde toutes les 2 minutes si une boîte a changé (notification de nouveau mail). */
export function initSynchronisationCron() {
  let verification = false;
  cron.schedule('*/2 * * * *', async () => {
    if (verification) return;
    verification = true;
    try {
      // Bail de moins de 2 min : une seule instance regarde à la fois.
      await avecVerrou('nouveaux-mails', 110, () => IntegrationService.verifierTout());
    } catch (e) {
      console.error('Nouveaux mails', e);
    } finally {
      verification = false;
    }
  });
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
