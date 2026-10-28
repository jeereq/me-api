import cron from 'node-cron';

import { StockJustificatifs } from '../services/justificatifs/stock.js';
import { avecVerrou } from '../utils/verrou.js';

/** Chaque nuit à 3 h 30 : efface de Cloudinary les justificatifs qu'aucune dépense n'utilise plus. */
export function initJustificatifsCron() {
  cron.schedule('30 3 * * *', async () => {
    try {
      await avecVerrou('justificatifs', 1800, async () => {
        const r = await StockJustificatifs.nettoyer();
        if (r.effaces) console.log(`Justificatifs : ${r.effaces} fichier(s) inutilisé(s) effacé(s).`);
      });
    } catch (e) {
      console.error('Ménage des justificatifs', e);
    }
  });
}
