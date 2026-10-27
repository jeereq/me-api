import { agendasALire, rangerMails, type AgendaDispo, type MailImporte } from './choix.js';
import { base64Url, lendemain, messageRfc822, verifierRendezvous, verifierTache } from './ecriture.js';
import { bearer, form, jour, json, local, nomContact, passe, urlRetour } from './http.js';
import { vide, type Connecteur, type Elements } from './types.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
// Lecture ET écriture : répondre à un mail, tenir l'agenda et les tâches depuis Me.
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/tasks',
];
const id = () => process.env.GOOGLE_CLIENT_ID || '';
const secret = () => process.env.GOOGLE_CLIENT_SECRET || '';

type Token = { access_token: string; refresh_token?: string; expires_in: number };
type Event = { id: string; summary?: string; location?: string; htmlLink?: string; status?: string; start: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } };
type Cal = { id: string; summary?: string; summaryOverride?: string; selected?: boolean; primary?: boolean; backgroundColor?: string };
type Header = { name: string; value: string };
type Message = { id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: Header[] } };

/** La liste des agendas du compte, nommée comme dans Google Agenda. */
const listeAgendas = async (accessToken: string): Promise<AgendaDispo[]> => {
  const { items = [] } = await json<{ items?: Cal[] }>('Google Agenda', `${CAL}/users/me/calendarList?minAccessRole=reader`, bearer(accessToken));
  return items.map((c) => ({ id: c.id, nom: c.summaryOverride || c.summary || c.id, principal: c.primary, visible: c.selected !== false, couleur: c.backgroundColor }));
};

const entete = (m: Message, nom: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === nom.toLowerCase())?.value || '';
const lienMail = (threadId: string) => `https://mail.google.com/mail/u/0/#all/${threadId}`;

/** Un appel JSON avec corps : même en-tête d'autorisation, plus le type de contenu. */
const corpsJson = (accessToken: string, method: string, corps: unknown) => ({ method, headers: { ...bearer(accessToken).headers, 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });

/** Un rendez-vous au format de Google Agenda ; une journée entière se note par des dates, fin exclue. */
function corpsEvenement(e: { titre: string; date: string; debut?: string; fin?: string; lieu?: string; journee?: boolean; fuseau: string }) {
  const v = verifierRendezvous(e);
  const quand = v.journee
    ? { start: { date: v.date }, end: { date: lendemain(v.date) } }
    : { start: { dateTime: `${v.date}T${v.debut}:00`, timeZone: e.fuseau }, end: { dateTime: `${v.date}T${v.fin}:00`, timeZone: e.fuseau } };
  return { summary: v.titre, ...(v.lieu ? { location: v.lieu } : {}), ...quand };
}

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

  agendas: ({ accessToken }) => listeAgendas(accessToken),

  async importer({ jetons, fuseau, delaiRelance, prefs, agendas: choisis }) {
    const out: Elements = vide();
    const auth = bearer(jetons.accessToken);
    const agenda = prefs('google_agenda');
    const gmail = prefs('gmail');

    // Agenda : 14 jours, tous les agendas affichés dans Google Agenda (ou ceux du filtre).
    if (agenda.actif && agenda.imports.includes('agenda')) {
      const cals = agendasALire(await listeAgendas(jetons.accessToken), choisis, agenda.filtre);
      const timeMin = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
      const timeMax = new Date(Date.now() + 14 * 86400000).toISOString();
      for (const cal of cals) {
        const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '100', timeZone: fuseau });
        const { items: evs = [] } = await json<{ items?: Event[] }>('Google Agenda', `${CAL}/calendars/${encodeURIComponent(cal.id)}/events?${q}`, auth);
        for (const e of evs) {
          if (e.status === 'cancelled') continue;
          const base = { id: `${cal.id}:${e.id}`, titre: e.summary || '(sans titre)', lieu: e.location, source: 'google_agenda' as const, lien: e.htmlLink, agenda: cal.nom };
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
      Promise.all(ids.map((m) => json<Message>('Gmail', `${GMAIL}/messages/${m}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-ID&metadataHeaders=References`, auth)));

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

    // Boîte mail : les fils récents, pour lire et répondre depuis Me (seulement objet, contact et date).
    if (gmail.actif && gmail.imports.includes('mails')) {
      const { messages = [] } = await json<{ messages?: { id: string }[] }>('Gmail', `${GMAIL}/messages?${new URLSearchParams({ q: `in:inbox newer_than:7d${filtreGmail}`, maxResults: '25' })}`, auth);
      const lus = await lire(messages.map((x) => x.id));
      out.mails = rangerMails(
        lus.map((m): MailImporte => {
          const d = m.internalDate ? local(new Date(Number(m.internalDate)), fuseau) : { date: jour(0, fuseau), heure: undefined };
          const de = entete(m, 'From');
          return { id: m.id, fil: m.threadId, sujet: entete(m, 'Subject') || '(sans objet)', contact: nomContact(de), adresse: de, messageId: entete(m, 'Message-ID') || undefined, references: entete(m, 'References') || undefined, date: d.date, heure: d.heure, sens: 'recu', nonLu: m.labelIds?.includes('UNREAD'), lien: lienMail(m.threadId), source: 'gmail' };
        }),
      );
    }

    return out;
  },

  /* ---------- Écriture ---------- */

  async repondre({ accessToken }, r) {
    const brut = base64Url(messageRfc822({ a: r.a, sujet: r.sujet, texte: r.texte, messageId: r.messageId, references: r.references }));
    const env = await json<{ id: string; threadId: string }>('Gmail', `${GMAIL}/messages/send`, {
      method: 'POST',
      ...bearer(accessToken),
      headers: { ...bearer(accessToken).headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: brut, threadId: r.fil }),
    });
    return { lien: lienMail(env.threadId || r.fil || env.id) };
  },

  async creerEvenement({ accessToken }, e) {
    const env = await json<{ id: string; htmlLink?: string }>('Google Agenda', `${CAL}/calendars/${encodeURIComponent(e.agendaId)}/events`, corpsJson(accessToken, 'POST', corpsEvenement(e)));
    return { id: env.id, lien: env.htmlLink };
  },

  async modifierEvenement({ accessToken }, e) {
    const env = await json<{ htmlLink?: string }>('Google Agenda', `${CAL}/calendars/${encodeURIComponent(e.agendaId)}/events/${encodeURIComponent(e.id)}`, corpsJson(accessToken, 'PATCH', corpsEvenement(e)));
    return { lien: env.htmlLink };
  },

  async supprimerEvenement({ accessToken }, e) {
    await json('Google Agenda', `${CAL}/calendars/${encodeURIComponent(e.agendaId)}/events/${encodeURIComponent(e.id)}`, { method: 'DELETE', ...bearer(accessToken) });
  },

  async listesTaches({ accessToken }) {
    const { items = [] } = await json<{ items?: { id: string; title?: string }[] }>('Google Tasks', `${TASKS}/users/@me/lists?maxResults=50`, bearer(accessToken));
    return items.map((l, i) => ({ id: l.id, nom: l.title || 'Mes tâches', principale: i === 0 }));
  },

  async creerTache({ accessToken }, t) {
    const v = verifierTache(t);
    const env = await json<{ id: string }>('Google Tasks', `${TASKS}/lists/${encodeURIComponent(t.listeId)}/tasks`, corpsJson(accessToken, 'POST', { title: v.titre, ...(v.echeance ? { due: `${v.echeance}T00:00:00.000Z` } : {}), status: v.fait ? 'completed' : 'needsAction' }));
    return { id: env.id };
  },

  async majTache({ accessToken }, t) {
    const v = verifierTache(t);
    // Google refuse « completed » posé à la main : c'est le statut qui fait foi, et il efface la date quand on rouvre.
    await json('Google Tasks', `${TASKS}/lists/${encodeURIComponent(t.listeId)}/tasks/${encodeURIComponent(t.id)}`, corpsJson(accessToken, 'PATCH', { title: v.titre, status: v.fait ? 'completed' : 'needsAction', ...(v.fait ? {} : { completed: null }), ...(v.echeance ? { due: `${v.echeance}T00:00:00.000Z` } : {}) }));
  },
};
