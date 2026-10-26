import cron from 'node-cron';

import { NotificationService } from '../services/NotificationService.js';
import { avecVerrou } from '../utils/verrou.js';

/** Toutes les 5 minutes : crée les rappels arrivés à échéance et envoie les emails. */
export function initRappelsCron() {
  let enCours = false;
  cron.schedule('*/5 * * * *', async () => {
    if (enCours) return;
    enCours = true;
    try {
      // Bail de 4 min (< période) : une seule instance fait le passage ; si elle tombe, la suivante reprend au passage d'après.
      await avecVerrou('rappels', 240, () => NotificationService.generer());
    } catch (e) {
      console.error('Rappels', e);
    } finally {
      enCours = false;
    }
  });
}
