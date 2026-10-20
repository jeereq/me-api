import { bearer, form, jour, json, local, nomContact, passe, urlRetour } from './http.js';
import { vide, type Connecteur, type Elements } from './types.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/gmail.readonly'];
const id = () => process.env.GOOGLE_CLIENT_ID || '';
const secret = () => process.env.GOOGLE_CLIENT_SECRET || '';

type Token = { access_token: string; refresh_token?: string; expires_in: number };
type Event = { id: string; summary?: string; location?: string; htmlLink?: string; status?: string; start: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } };
type Header = { name: string; value: string };
type Message = { id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: Header[] } };

const entete = (m: Message, nom: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === nom.toLowerCase())?.value || '';
const lienMail = (threadId: string) => `https://mail.google.com/mail/u/0/#all/${threadId}`;

export const google: Connecteur = {
  fournisseur: 'GOOGLE',
  nom: 'Google',
  sources: ['google_agenda', 'gmail'],
  ctx: 'perso',
  configure: () => !!(id() && secret() && process.env.PUBLIC_URL),

  urlAutorisation: (state) =>
    `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: id(),
      redirect_uri: urlRetour('google'),
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      state,
    })}`,

  async echanger(code) {
    const t = await json<Token>('Google', 'https://oauth2.googleapis.com/token', form({ client_id: id(), client_secret: secret(), grant_type: 'authorization_code', code, redirect_uri: urlRetour('google') }));
    const moi = await json<{ email?: string }>('Google', 'https://openidconnect.googleapis.com/v1/userinfo', bearer(t.access_token));
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(Date.now() + t.expires_in * 1000), compte: moi.email || 'Compte Google' };
  },

  async rafraichir(refreshToken) {
    const t = await json<Token>('Google', 'https://oauth2.googleapis.com/token', form({ client_id: id(), client_secret: secret(), grant_type: 'refresh_token', refresh_token: refreshToken }));
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? refreshToken, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
  },

  async importer({ jetons, fuseau, delaiRelance, prefs }) {
    const out: Elements = vide();
    const auth = bearer(jetons.accessToken);
    const agenda = prefs('google_agenda');
    const gmail = prefs('gmail');

    // Agenda : 14 jours, tous les agendas affichés dans Google Agenda (ou ceux du filtre).
    if (agenda.actif && agenda.imports.includes('agenda')) {
      const { items = [] } = await json<{ items?: { id: string; summary?: string; summaryOverride?: string; selected?: boolean }[] }>('Google Agenda', `${CAL}/users/me/calendarList?minAccessRole=reader`, auth);
      const cals = items.filter((c) => (agenda.filtre.length ? passe(agenda.filtre, c.summary, c.summaryOverride) : c.selected !== false)).slice(0, 10);
      const timeMin = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
      const timeMax = new Date(Date.now() + 14 * 86400000).toISOString();
      for (const cal of cals) {
        const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '100', timeZone: fuseau });
        const { items: evs = [] } = await json<{ items?: Event[] }>('Google Agenda', `${CAL}/calendars/${encodeURIComponent(cal.id)}/events?${q}`, auth);
        for (const e of evs) {
          if (e.status === 'cancelled') continue;
          const base = { id: `${cal.id}:${e.id}`, titre: e.summary || '(sans titre)', lieu: e.location, source: 'google_agenda' as const, lien: e.htmlLink };
          if (e.start.date) out.agenda.push({ ...base, date: e.start.date, debut: 'Journée' });
          else if (e.start.dateTime) {
            const d = local(e.start.dateTime, fuseau);
            out.agenda.push({ ...base, date: d.date, debut: d.heure, fin: e.end?.dateTime ? local(e.end.dateTime, fuseau).heure : undefined });
          }
        }
      }
    }

    const filtreGmail = gmail.filtre.length ? ` {${gmail.filtre.map((f) => `label:${f.replace(/\s+/g, '-')}`).join(' ')}}` : '';
    const lire = async (ids: string[]) =>
      Promise.all(ids.map((m) => json<Message>('Gmail', `${GMAIL}/messages/${m}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To`, auth)));

    // Tâches : mails suivis (étoile) des 30 derniers jours.
    if (gmail.actif && gmail.imports.includes('taches')) {
      const { messages = [] } = await json<{ messages?: { id: string }[] }>('Gmail', `${GMAIL}/messages?${new URLSearchParams({ q: `is:starred newer_than:30d${filtreGmail}`, maxResults: '20' })}`, auth);
      for (const m of await lire(messages.map((x) => x.id))) {
        out.taches.push({ id: m.id, titre: `${entete(m, 'Subject') || '(sans objet)'} · ${nomContact(entete(m, 'From'))}`, echeance: null, source: 'gmail', lien: lienMail(m.threadId) });
      }
    }

    // Relances : fils dont le dernier message vient de moi, envoyé il y a plus de N jours, sans réponse.
    if (gmail.actif && gmail.imports.includes('relances')) {
      const q = `in:sent older_than:${delaiRelance}d newer_than:30d${filtreGmail}`;
      const { threads = [] } = await json<{ threads?: { id: string }[] }>('Gmail', `${GMAIL}/threads?${new URLSearchParams({ q, maxResults: '15' })}`, auth);
      for (const t of threads) {
        const fil = await json<{ messages?: Message[] }>('Gmail', `${GMAIL}/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=To`, auth);
        const dernier = fil.messages?.at(-1);
        if (!dernier?.labelIds?.includes('SENT')) continue;
        out.relances.push({
          id: t.id,
          contact: nomContact(entete(dernier, 'To').split(',')[0]),
          sujet: entete(fil.messages![0], 'Subject') || '(sans objet)',
          date: jour(0, fuseau),
          source: 'gmail',
          lien: lienMail(t.id),
        });
      }
    }
    return out;
  },
};
