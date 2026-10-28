import jwt from 'jsonwebtoken';

import { delai } from '../../utils/delai.js';
import { HttpError } from '../../utils/http.js';
import { bearer, form, json } from '../integrations/http.js';
import { retourAutorise } from '../IntegrationService.js';
import { adresseApp } from './emails.js';

/**
 * « Continuer avec Google » : connexion OpenID Connect, limitée à l'identité (openid, email, profile).
 * Distinct de la connexion Agenda/Gmail des sources : se connecter ne donne accès à aucune donnée Google.
 */
const id = () => process.env.GOOGLE_CLIENT_ID || '';
const secret = () => process.env.GOOGLE_CLIENT_SECRET || '';
const redirection = () => `${(process.env.PUBLIC_URL || '').replace(/\/+$/, '')}/api/auth/google/callback`;

export type ProfilGoogle = { sub: string; email: string; emailVerifie: boolean; nom: string };

/** Où revenir après Google : une adresse de l'app acceptée, sinon l'app web, sinon l'app installée. */
export function retourConnexion(retour: string) {
  if (retour && retourAutorise(retour) === retour) return retour;
  return adresseApp() ? `${adresseApp()}/` : 'me://';
}

export const ConnexionGoogle = {
  configure: () => !!(id() && secret() && process.env.PUBLIC_URL),

  url(retour: string) {
    if (!this.configure()) throw new HttpError(503, "La connexion avec Google n'est pas configurée sur le serveur.");
    const state = jwt.sign({ typ: 'google-login', retour: retourConnexion(retour) }, process.env.JWT_SECRET as string, { expiresIn: '10m' });
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: id(), redirect_uri: redirection(), response_type: 'code', scope: 'openid email profile', prompt: 'select_account', state })}`;
  },

  /** Relit le `state` signé ; renvoie null s'il est expiré ou falsifié. */
  lireState(state: string) {
    try {
      const p = jwt.verify(state, process.env.JWT_SECRET as string) as { typ: string; retour: string };
      return p.typ === 'google-login' ? p.retour : null;
    } catch {
      return null;
    }
  },

  async profil(code: string): Promise<ProfilGoogle> {
    const t = await json<{ access_token: string }>('Google', 'https://oauth2.googleapis.com/token', form({ client_id: id(), client_secret: secret(), grant_type: 'authorization_code', code, redirect_uri: redirection() }));
    const p = await json<{ sub: string; email?: string; email_verified?: boolean; name?: string }>('Google', 'https://openidconnect.googleapis.com/v1/userinfo', bearer(t.access_token));
    if (!p.sub || !p.email) throw new HttpError(400, "Google n'a pas transmis d'adresse email.");
    // Le jeton d'accès ne sert qu'à lire le profil et n'est pas gardé. Pas de révocation : chez Google, elle retirerait
    // aussi l'accès Agenda/Gmail accordé au même client OAuth par l'écran Sources.
    return { sub: p.sub, email: p.email.trim().toLowerCase(), emailVerifie: p.email_verified === true, nom: (p.name || '').slice(0, 80) };
  },

  /** Révoque l'accès d'un compte Google connecté (Agenda/Gmail) à la suppression du compte me. */
  async revoquer(jeton: string) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(jeton)}`, { method: 'POST', signal: delai() }).catch(() => {});
  },
};
