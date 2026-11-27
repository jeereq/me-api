import cron from 'node-cron';

/**
 * Sur un hébergement gratuit (Render…), le serveur s'endort après un quart d'heure sans visite, et ses tâches planifiées
 * avec lui : plus de rappels à l'heure. Il s'appelle donc lui-même toutes les 10 minutes sur son adresse publique.
 * Actif seulement si l'hébergeur donne cette adresse (`RENDER_EXTERNAL_URL`) ou si `ADRESSE_PUBLIQUE` est réglée ; coupé par `KEEP_ALIVE=false`.
 */
export function initVivantCron() {
  const base = (process.env.ADRESSE_PUBLIQUE || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (!base || process.env.KEEP_ALIVE?.trim().toLowerCase() === 'false') return;
  cron.schedule('*/10 * * * *', () => {
    fetch(`${base}/api/health`, { signal: AbortSignal.timeout(20000) }).catch(() => {});
  });
  console.log(`Réveil toutes les 10 minutes : ${base}/api/health`);
}
