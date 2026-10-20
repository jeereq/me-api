import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';
import { EmailService } from './EmailService.js';
import { local } from './integrations/http.js';
import { rappelsDuJour, type ConfigRappels, type EspaceRappels, type Rappel } from './rappels/calcul.js';

// Un rappel manqué (serveur endormi, redémarrage) part encore s'il date de moins de 45 minutes.
const RATTRAPAGE_MIN = 45;
const COULEURS: Record<string, string> = { agressif: '#FF6474', normal: '#62AEFF', coach: '#3EF0B0', hebdo: '#FFCB5C', briefing: '#38D9FF', passif: '#7F98A6' };

type Prefs = { app?: boolean; email?: boolean };
const echapper = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function email(rappels: Rappel[], nom: string) {
  const sujet = rappels.length === 1 ? rappels[0].titre : `${rappels.length} rappels de me`;
  const texte = `${nom ? `Bonjour ${nom},\n\n` : ''}${rappels.map((r) => `• ${r.titre}\n  ${r.corps}`).join('\n\n')}\n\n— me, ton assistant personnel`;
  const lignes = rappels
    .map(
      (r) =>
        `<tr><td style="padding:14px 16px;border-left:3px solid ${COULEURS[r.mode] || '#38D9FF'};background:#0A141C;border-radius:8px">` +
        `<div style="font-weight:700;color:#DCF3FF;font-size:15px">${echapper(r.titre)}</div>` +
        `<div style="color:#86A7B8;font-size:13px;margin-top:4px">${echapper(r.corps)}</div></td></tr><tr><td style="height:10px"></td></tr>`,
    )
    .join('');
  const html =
    `<div style="background:#04080C;padding:28px 16px;font-family:-apple-system,Segoe UI,Roboto,sans-serif">` +
    `<div style="max-width:520px;margin:0 auto">` +
    `<div style="font-size:30px;font-weight:800;color:#DCF3FF">me<span style="color:#38D9FF">.</span></div>` +
    `<div style="color:#38D9FF;font-family:monospace;font-size:11px;letter-spacing:2px;margin:4px 0 20px">TES RAPPELS</div>` +
    (nom ? `<p style="color:#DCF3FF;font-size:15px">Bonjour ${echapper(nom)},</p>` : '') +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${lignes}</table>` +
    `<p style="color:#86A7B8;font-size:12px;margin-top:18px">Tu reçois cet email parce que les rappels par email sont activés dans me (Mon compte).</p>` +
    `</div></div>`;
  return { sujet, texte, html };
}

export const NotificationService = {
  /** Crée les rappels arrivés à échéance pour chaque compte, puis les envoie par email si activé. */
  async generer(maintenant = new Date()) {
    const cfg = ((await prisma.config.findUnique({ where: { id: 1 } }))?.data ?? {}) as ConfigRappels & { canaux?: { mail?: boolean } };
    const mailActif = cfg.canaux?.mail !== false && EmailService.configure();
    const users = await prisma.user.findMany({ select: { id: true, email: true, nom: true, fuseau: true, espace: { select: { data: true } } } });

    for (const u of users) {
      if (!u.espace) continue;
      const e = u.espace.data as EspaceRappels & { notifs?: Prefs };
      const prefs = e.notifs ?? {};
      if (prefs.app === false && !(mailActif && prefs.email !== false)) continue;
      const { date, heure } = local(maintenant, u.fuseau);
      const nowLocal = `${date}T${heure}`;
      const depuis = local(new Date(maintenant.getTime() - RATTRAPAGE_MIN * 60000), u.fuseau);
      const borne = `${depuis.date}T${depuis.heure}`;
      const jours = depuis.date === date ? [date] : [depuis.date, date];
      const dus = jours.flatMap((j) => rappelsDuJour(e, cfg, j)).filter((r) => r.quand > borne && r.quand <= nowLocal);

      if (!dus.length) continue;
      // Un rappel déjà créé lors d'un passage précédent n'est pas renvoyé.
      const deja = new Set((await prisma.notification.findMany({ where: { userId: u.id, cle: { in: dus.map((r) => r.cle) } }, select: { cle: true } })).map((n) => n.cle));
      const nouveaux = dus.filter((r) => !deja.has(r.cle));
      await prisma.notification.createMany({
        data: nouveaux.map((r) => ({ userId: u.id, cle: r.cle, titre: r.titre, corps: r.corps, mode: r.mode, quand: r.quand, lu: prefs.app === false })),
        skipDuplicates: true,
      });
      if (nouveaux.length && mailActif && prefs.email !== false) {
        const m = email(nouveaux, u.nom);
        if (await EmailService.envoyer(u.email, m.sujet, m.texte, m.html)) {
          await prisma.notification.updateMany({ where: { userId: u.id, cle: { in: nouveaux.map((r) => r.cle) } }, data: { parEmail: true } });
        }
      }
    }
    // On garde 60 jours d'historique.
    await prisma.notification.deleteMany({ where: { createdAt: { lt: new Date(maintenant.getTime() - 60 * 86400000) } } });
  },

  async liste(userId: string) {
    const [notifications, nonLues] = await Promise.all([
      prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, titre: true, corps: true, mode: true, quand: true, lu: true, parEmail: true, createdAt: true } }),
      prisma.notification.count({ where: { userId, lu: false } }),
    ]);
    return { notifications, nonLues, email: EmailService.configure() };
  },

  async marquerLues(userId: string, ids?: string[]) {
    await prisma.notification.updateMany({ where: { userId, lu: false, ...(ids?.length ? { id: { in: ids } } : {}) }, data: { lu: true } });
  },

  /** Envoie un rappel d'essai, dans l'app et par email, pour vérifier la configuration. */
  async tester(userId: string) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const r: Rappel = { quand: new Date().toISOString().slice(0, 16), titre: 'Essai de notification', corps: 'Si tu lis ceci, les rappels de me fonctionnent.', mode: 'briefing', cle: `test|${Date.now()}` };
    await prisma.notification.create({ data: { userId, cle: r.cle, titre: r.titre, corps: r.corps, mode: r.mode, quand: r.quand } });
    if (!EmailService.configure()) return { email: false, raison: "SendGrid n'est pas configuré sur le serveur." };
    const m = email([r], u.nom);
    const ok = await EmailService.envoyer(u.email, m.sujet, m.texte, m.html);
    if (!ok) throw new HttpError(502, "SendGrid a refusé l'envoi : vérifie la clé et l'expéditeur.");
    return { email: true };
  },
};
