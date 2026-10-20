import { ErreurExterne, form, jour, json, urlRetour } from './http.js';
import { vide, type Connecteur, type Elements } from './types.js';

const id = () => process.env.SLACK_CLIENT_ID || '';
const secret = () => process.env.SLACK_CLIENT_SECRET || '';

type Reponse = { ok: boolean; error?: string };
type Match = { iid?: string; ts: string; text: string; permalink: string; username?: string; user?: string; channel?: { id: string; name?: string; is_im?: boolean } };

/** Slack répond 200 même en cas d'erreur : on lit le champ `ok`. */
async function slack<T extends Reponse>(methode: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const r = await json<T>('Slack', `https://slack.com/api/${methode}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new ErreurExterne(`Slack : ${r.error}`, ['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed'].includes(r.error || ''));
  return r;
}

export const slackConnecteur: Connecteur = {
  fournisseur: 'SLACK',
  nom: 'Slack',
  sources: ['slack'],
  ctx: 'pro',
  configure: () => !!(id() && secret() && process.env.PUBLIC_URL),

  urlAutorisation: (state) =>
    `https://slack.com/oauth/v2/authorize?${new URLSearchParams({ client_id: id(), user_scope: 'search:read,channels:history,groups:history,im:history,mpim:history', redirect_uri: urlRetour('slack'), state })}`,

  async echanger(code) {
    const r = await json<Reponse & { authed_user?: { id: string; access_token?: string }; team?: { name?: string } }>(
      'Slack',
      'https://slack.com/api/oauth.v2.access',
      form({ client_id: id(), client_secret: secret(), code, redirect_uri: urlRetour('slack') }),
    );
    if (!r.ok || !r.authed_user?.access_token) throw new ErreurExterne(`Slack : ${r.error || 'jeton absent'}`);
    // L'identifiant Slack de l'utilisateur sert à chercher ses mentions : on le garde avec le jeton.
    return { accessToken: `${r.authed_user.id}:${r.authed_user.access_token}`, compte: r.team?.name || 'Slack' };
  },

  async importer({ jetons, fuseau, delaiRelance, prefs }) {
    const out: Elements = vide();
    const p = prefs('slack');
    if (!p.actif) return out;
    const [moi, token] = jetons.accessToken.split(/:(.*)/s);
    const canaux = p.filtre.length ? ' ' + p.filtre.map((c) => `in:#${c.replace(/^#/, '')}`).join(' ') : '';
    const nom = (m: Match) => m.username || 'Quelqu’un';
    const ou = (m: Match) => (m.channel?.is_im ? 'en message direct' : `dans #${m.channel?.name || 'canal'}`);
    const court = (t: string) => (t.length > 80 ? `${t.slice(0, 77)}…` : t).replace(/<@[^>]+>/g, '').trim().replace(/\s+/g, ' ');

    // Tâches : les messages des 3 derniers jours qui me mentionnent ou m'écrivent en direct.
    if (p.imports.includes('taches')) {
      const r = await slack<Reponse & { messages?: { matches?: Match[] } }>('search.messages', token, { query: `<@${moi}> after:${jour(-4, fuseau)}${canaux}`, count: '20', sort: 'timestamp' });
      for (const m of r.messages?.matches || []) {
        if (m.user === moi) continue;
        out.taches.push({ id: `${m.channel?.id}:${m.ts}`, titre: `Répondre à ${nom(m)} ${ou(m)} : ${court(m.text)}`, echeance: null, source: 'slack', lien: m.permalink });
      }
    }

    // Relances : mes questions (avec « ? ») restées sans réponse dans leur fil depuis plus de N jours.
    if (p.imports.includes('relances')) {
      const r = await slack<Reponse & { messages?: { matches?: Match[] } }>('search.messages', token, {
        query: `from:<@${moi}> after:${jour(-30, fuseau)} before:${jour(-delaiRelance + 1, fuseau)}${canaux}`,
        count: '15',
        sort: 'timestamp',
      });
      for (const m of r.messages?.matches || []) {
        if (!m.text.includes('?') || !m.channel?.id) continue;
        const fil = await slack<Reponse & { messages?: { user?: string; ts: string }[] }>('conversations.replies', token, { channel: m.channel.id, ts: m.ts, limit: '50' }).catch(() => null);
        if (fil?.messages?.some((x) => x.user !== moi && Number(x.ts) > Number(m.ts))) continue;
        out.relances.push({ id: `${m.channel.id}:${m.ts}`, contact: m.channel.is_im ? 'Message direct' : `#${m.channel.name}`, sujet: court(m.text), date: jour(0, fuseau), source: 'slack', lien: m.permalink });
      }
    }
    return out;
  },
};
