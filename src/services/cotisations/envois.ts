import { prisma } from '../../utils/prisma.js';
import { adresseApp } from '../comptes/emails.js';
import { EmailService } from '../EmailService.js';
import { emailRappels } from '../rappels-email.js';
import { PushService } from '../PushService.js';
import { SmsService } from '../SmsService.js';

type Prefs = { app?: boolean; email?: boolean; sms?: boolean };
export type AvisGroupe = { cle: string; titre: string; corps: string };

const lienApp = () => `${adresseApp() ?? ''}/finances?onglet=cotisations`;

/** Ce que l'admin a activé dans la configuration du système, et que le serveur sait envoyer. */
export async function canauxSysteme() {
  const cfg = ((await prisma.config.findUnique({ where: { id: 1 } }))?.data ?? {}) as { canaux?: { mail?: boolean; sms?: boolean } };
  return { mail: cfg.canaux?.mail !== false && EmailService.configure(), sms: cfg.canaux?.sms !== false && SmsService.configure() };
}

export const Envois = {
  /**
   * Prévient un membre une seule fois : la clé empêche tout second envoi du même avis.
   * Chacun garde la main sur le mail et le SMS dans les réglages de son compte.
   */
  async avertir(userId: string, telephone: string | null, avis: AvisGroupe, seulementApp = false) {
    const cree = await prisma.notification.createMany({
      data: [{ userId, cle: avis.cle, titre: avis.titre, corps: avis.corps, mode: 'normal', quand: new Date().toISOString().slice(0, 16) }],
      skipDuplicates: true,
    });
    if (!cree.count) return { nouveau: false, mail: false, sms: false };
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { nom: true, email: true, emailVerifie: true, espace: { select: { data: true } } } });
    if (!u) return { nouveau: true, mail: false, sms: false };
    const prefs = ((u.espace?.data as { notifs?: Prefs } | null)?.notifs ?? {}) as Prefs;
    if (prefs.app !== false) await PushService.envoyer(userId, { titre: avis.titre, corps: avis.corps, mode: 'normal', url: '/finances?onglet=cotisations', tag: avis.cle }).catch((e) => console.error('Push tontine', e));
    if (seulementApp) return { nouveau: true, mail: false, sms: false };
    const canaux = await canauxSysteme();
    let mail = false;
    if (canaux.mail && prefs.email !== false && u.emailVerifie) {
      const m = emailRappels([{ titre: avis.titre, corps: avis.corps, mode: 'normal' }], u.nom, 'Tu reçois cet email parce que tu participes à une tontine sur Me. Tu peux couper les emails dans les réglages de ton compte.', lienApp());
      mail = await EmailService.envoyer(u.email, avis.titre, m.texte, m.html);
      if (mail) await prisma.notification.updateMany({ where: { userId, cle: avis.cle }, data: { parEmail: true } });
    }
    const sms = canaux.sms && prefs.sms !== false && !!telephone ? await SmsService.envoyer(userId, telephone, `${avis.titre}. ${avis.corps} ${lienApp()}`) : false;
    return { nouveau: true, mail, sms };
  },

  /** Une demande de collecte envoyée par Me à une personne sans compte, selon les canaux du système. */
  async collecte(organisateurId: string, c: { email?: string | null; telephone: string; titre: string; texte: string }) {
    const canaux = await canauxSysteme();
    let mail = false;
    if (canaux.mail && c.email) {
      const html = `<p style="font-family:sans-serif;font-size:15px;white-space:pre-line">${c.texte.replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[x] as string)}</p>`;
      mail = await EmailService.envoyer(c.email, c.titre, c.texte, html);
    }
    const sms = canaux.sms ? await SmsService.envoyerCotisation(organisateurId, c.telephone, c.texte) : false;
    return { mail, sms };
  },
};
