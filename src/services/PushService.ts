import webpush from 'web-push';

import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';

/**
 * Notifications Web Push : elles s'affichent sur le téléphone ou l'ordinateur même quand me est fermée
 * (iPhone : app web ajoutée à l'écran d'accueil, iOS 16.4 ou plus).
 * Clés VAPID générées une fois avec `npx web-push generate-vapid-keys`.
 */
let pret: boolean | null = null;
function configure() {
  if (pret !== null) return pret;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return (pret = false);
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:${process.env.SENDGRID_FROM || 'admin@example.com'}`, pub, priv);
    pret = true;
  } catch (err) {
    console.error('Clés VAPID invalides :', (err as Error).message);
    pret = false;
  }
  return pret;
}

export type MessagePush = { titre: string; corps: string; mode?: string; url?: string; tag?: string };

export const PushService = {
  configure,

  clePublique() {
    return configure() ? process.env.VAPID_PUBLIC_KEY! : null;
  },

  async abonner(userId: string, a: { endpoint: string; keys: { p256dh: string; auth: string }; appareil?: string }) {
    if (!configure()) throw new HttpError(503, "Les notifications push ne sont pas configurées sur le serveur (clés VAPID).");
    // Un même navigateur qui change de compte passe au nouveau compte.
    await prisma.pushAbonnement.upsert({
      where: { endpoint: a.endpoint },
      create: { userId, endpoint: a.endpoint, p256dh: a.keys.p256dh, auth: a.keys.auth, appareil: a.appareil ?? '' },
      update: { userId, p256dh: a.keys.p256dh, auth: a.keys.auth, appareil: a.appareil ?? '' },
    });
  },

  async desabonner(userId: string, endpoint: string) {
    await prisma.pushAbonnement.deleteMany({ where: { userId, endpoint } });
  },

  nombre(userId: string) {
    return prisma.pushAbonnement.count({ where: { userId } });
  },

  /** Envoie à tous les appareils du compte ; un abonnement expiré (404/410) est supprimé. Renvoie le nombre d'envois réussis. */
  async envoyer(userId: string, m: MessagePush) {
    if (!configure()) return 0;
    const abos = await prisma.pushAbonnement.findMany({ where: { userId } });
    const payload = JSON.stringify({ titre: m.titre, corps: m.corps, mode: m.mode, url: m.url ?? '/notifications', tag: m.tag });
    let ok = 0;
    await Promise.all(
      abos.map(async (a) => {
        try {
          await webpush.sendNotification({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } }, payload, { TTL: 3600, urgency: 'high' });
          ok++;
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) await prisma.pushAbonnement.delete({ where: { id: a.id } }).catch(() => {});
          else console.error('Envoi push échoué :', code, (err as Error).message);
        }
      }),
    );
    return ok;
  },
};
