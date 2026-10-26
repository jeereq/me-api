import { EmailService } from '../EmailService.js';

/**
 * Adresse web de l'app, où mènent les liens des emails : APP_URL, sinon la première adresse https d'APP_REDIRECT_URLS.
 * Sans elle, les liens ne peuvent pas être construits : la confirmation et la réinitialisation par email sont alors désactivées.
 */
export function adresseApp() {
  if (process.env.APP_URL) return process.env.APP_URL.trim().replace(/\/+$/, '');
  const https = (process.env.APP_REDIRECT_URLS || '').split(',').map((x) => x.trim()).find((x) => x.startsWith('https://'));
  try {
    return https ? new URL(https).origin : null;
  } catch {
    return null;
  }
}

/** Les emails de compte partent-ils ? Il faut SendGrid et l'adresse de l'app. */
export const emailsActifs = () => EmailService.configure() && !!adresseApp();

const echapper = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function gabarit(titre: string, intro: string, bouton: string, lien: string, fin: string) {
  const html =
    `<div style="background:#04080C;padding:28px 16px;font-family:-apple-system,Segoe UI,Roboto,sans-serif">` +
    `<div style="max-width:520px;margin:0 auto">` +
    `<div style="font-size:30px;font-weight:800;color:#DCF3FF">Me<span style="color:#38D9FF">.</span></div>` +
    `<div style="color:#38D9FF;font-family:monospace;font-size:11px;letter-spacing:2px;margin:4px 0 20px">${echapper(titre.toUpperCase())}</div>` +
    `<p style="color:#DCF3FF;font-size:15px;line-height:1.5">${echapper(intro)}</p>` +
    `<p style="margin:24px 0"><a href="${echapper(lien)}" style="background:#38D9FF;color:#04080C;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block">${echapper(bouton)}</a></p>` +
    `<p style="color:#86A7B8;font-size:12px;line-height:1.5">Le bouton ne marche pas ? Copie ce lien dans ton navigateur :<br><span style="color:#DCF3FF;word-break:break-all">${echapper(lien)}</span></p>` +
    `<p style="color:#86A7B8;font-size:12px;line-height:1.5;margin-top:18px">${echapper(fin)}</p>` +
    `</div></div>`;
  const texte = `${intro}\n\n${bouton} : ${lien}\n\n${fin}`;
  return { html, texte };
}

export const EmailsCompte = {
  verification(email: string, jeton: string) {
    const lien = `${adresseApp()}/verifier?jeton=${encodeURIComponent(jeton)}`;
    const m = gabarit('Confirme ton email', 'Bienvenue sur Me ! Confirme ton adresse email pour activer ton compte.', 'Confirmer mon email', lien, "Ce lien est valable 24 heures. Si tu n'as pas créé de compte sur me, ignore cet email.");
    return EmailService.envoyer(email, 'Confirme ton email pour Me', m.texte, m.html);
  },

  reinitialisation(email: string, jeton: string) {
    const lien = `${adresseApp()}/reinitialiser?jeton=${encodeURIComponent(jeton)}`;
    const m = gabarit(
      'Mot de passe oublié',
      'Tu as demandé à changer le mot de passe de ton compte me. Choisis-en un nouveau avec le bouton ci-dessous.',
      'Choisir un nouveau mot de passe',
      lien,
      "Ce lien est valable 1 heure et ne sert qu'une fois. Si tu n'as rien demandé, ignore cet email : ton mot de passe ne change pas.",
    );
    return EmailService.envoyer(email, 'Réinitialise ton mot de passe Me', m.texte, m.html);
  },
};

export const EmailsEquipe = {
  /** Le lien d'invitation, renvoyé à celui qui invite quand les emails ne partent pas d'ici. */
  lienInvitation: (jeton: string) => `${adresseApp() ?? ''}/equipe?invitation=${encodeURIComponent(jeton)}`,

  invitation(email: string, jeton: string, equipe: string, parNom: string) {
    const m = gabarit(
      'Invitation',
      `${parNom} t'invite à rejoindre l'équipe « ${equipe} » sur Me. En acceptant, tu partageras ses budgets, ses projets, ses tâches et ses habitudes.`,
      "Rejoindre l'équipe",
      EmailsEquipe.lienInvitation(jeton),
      "Ce lien est valable 7 jours et ne sert qu'une fois. Il faut l'ouvrir avec le compte Me qui porte cette adresse email. Si tu ne connais pas cette équipe, ignore cet email.",
    );
    return EmailService.envoyer(email, `${parNom} t'invite dans « ${equipe} » sur Me`, m.texte, m.html);
  },
};
