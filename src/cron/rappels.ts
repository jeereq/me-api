import cron from 'node-cron';

import { NotificationService } from '../services/NotificationService.js';

/** Toutes les 5 minutes : crée les rappels arrivés à échéance et envoie les emails. */
export function initRappelsCron() {
  let enCours = false;
  cron.schedule('*/5 * * * *', async () => {
    if (enCours) return;
    enCours = true;
    try {
      await NotificationService.generer();
    } catch (e) {
      console.error('Rappels', e);
    } finally {
      enCours = false;
    }
  });
}
