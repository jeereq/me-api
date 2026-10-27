import { agendasALire, rangerMails, type AgendaDispo, type MailImporte } from './choix.js';
import { bearer, form, jour, json, local, passe, urlRetour } from './http.js';
import { vide, type Connecteur, type Elements } from './types.js';

const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const SCOPES = 'offline_access openid email User.Read Calendars.Read Mail.Read Tasks.Read';
const id = () => process.env.MICROSOFT_CLIENT_ID || '';
const secret = () => process.env.MICROSOFT_CLIENT_SECRET || '';
// « common » accepte les comptes perso (outlook.com) et pro (Microsoft 365).
const tenant = () => process.env.MICROSOFT_TENANT_ID || 'common';
const tokenUrl = () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`;

type Token = { access_token: string; refresh_token?: string; expires_in: number };
type Event = { id: string; subject?: string; isAllDay?: boolean; isCancelled?: boolean; webLink?: string; location?: { displayName?: string }; start: { dateTime: string }; end?: { dateTime: string } };
type Mail = { id: string; subject?: string; webLink?: string; conversationId?: string; sentDateTime?: string; receivedDateTime?: string; from?: { emailAddress?: { name?: string; address?: string } }; toRecipients?: { emailAddress?: { name?: string; address?: string } }[]; flag?: { dueDateTime?: { dateTime: string } } };

// Graph renvoie des dates sans fuseau quand on lui en impose un : on les lit telles quelles.
const brut = (dt: string) => ({ date: dt.slice(0, 10), heure: dt.slice(11, 16) });

/** Les agendas du compte, nommés comme dans Outlook. */
const listeAgendas = async (accessToken: string): Promise<AgendaDispo[]> => {
  const { value = [] } = await json<{ value?: { id: string; name?: string; isDefaultCalendar?: boolean; hexColor?: string }[] }>('Outlook', `${GRAPH}/calendars?$select=id,name,isDefaultCalendar,hexColor&$top=50`, bearer(accessToken));
  return value.map((c) => ({ id: c.id, nom: c.name || 'Agenda', principal: c.isDefaultCalendar, visible: c.isDefaultCalendar !== false, couleur: c.hexColor && c.hexColor !== 'auto' ? c.hexColor : undefined }));
};

export const microsoft: Connecteur = {
  fournisseur: 'MICROSOFT',
  nom: 'Microsoft',
  sources: ['outlook'],
  ctx: 'pro',
  configure: () => !!(id() && secret() && process.env.PUBLIC_URL),

  urlAutorisation: (state) =>
    `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize?${new URLSearchParams({
      client_id: id(),
      redirect_uri: urlRetour('microsoft'),
      response_type: 'code',
      response_mode: 'query',
      scope: SCOPES,
      prompt: 'select_account',
      state,
    })}`,

  async echanger(code) {
    const t = await json<Token>('Microsoft', tokenUrl(), form({ client_id: id(), client_secret: secret(), grant_type: 'authorization_code', code, redirect_uri: urlRetour('microsoft'), scope: SCOPES }));
    const moi = await json<{ mail?: string; userPrincipalName?: string }>('Microsoft', `${GRAPH}?$select=mail,userPrincipalName`, bearer(t.access_token));
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(Date.now() + t.expires_in * 1000), compte: moi.mail || moi.userPrincipalName || 'Compte Microsoft' };
  },

  async rafraichir(refreshToken) {
    const t = await json<Token>('Microsoft', tokenUrl(), form({ client_id: id(), client_secret: secret(), grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPES }));
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? refreshToken, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
  },

  agendas: ({ accessToken }) => listeAgendas(accessToken),

  async importer({ jetons, fuseau, delaiRelance, prefs, agendas: choisis }) {
    const out: Elements = vide();
    const p = prefs('outlook');
    if (!p.actif) return out;
    const auth = bearer(jetons.accessToken, { Prefer: `outlook.timezone="${fuseau}"` });

    if (p.imports.includes('agenda')) {
      const cals = agendasALire(await listeAgendas(jetons.accessToken), choisis, p.filtre);
      const q = new URLSearchParams({ startDateTime: `${jour(0, fuseau)}T00:00:00`, endDateTime: `${jour(14, fuseau)}T23:59:59`, $top: '100', $orderby: 'start/dateTime', $select: 'subject,start,end,location,isAllDay,isCancelled,webLink' });
      for (const cal of cals) {
        const url = `${GRAPH}/calendars/${cal.id}/calendarView?${q}`;
        const { value = [] } = await json<{ value?: Event[] }>('Outlook', url, auth);
        for (const e of value) {
          if (e.isCancelled) continue;
          const d = brut(e.start.dateTime);
          out.agenda.push({ id: e.id, date: d.date, debut: e.isAllDay ? 'Journée' : d.heure, fin: e.isAllDay || !e.end ? undefined : brut(e.end.dateTime).heure, titre: e.subject || '(sans titre)', lieu: e.location?.displayName || undefined, source: 'outlook', agenda: cal.nom, lien: e.webLink });
        }
      }
    }

    if (p.imports.includes('taches')) {
      // Mails avec un drapeau de suivi
      const q = new URLSearchParams({ $filter: "flag/flagStatus eq 'flagged'", $top: '20', $select: 'subject,from,flag,webLink' });
      const { value = [] } = await json<{ value?: Mail[] }>('Outlook', `${GRAPH}/messages?${q}`, auth);
      for (const m of value) {
        out.taches.push({ id: m.id, titre: `${m.subject || '(sans objet)'} · ${m.from?.emailAddress?.name || ''}`.replace(/ · $/, ''), echeance: m.flag?.dueDateTime ? brut(m.flag.dueDateTime.dateTime).date : null, source: 'outlook', lien: m.webLink });
      }
      // Microsoft To Do
      const { value: listes = [] } = await json<{ value?: { id: string; displayName: string }[] }>('Microsoft To Do', `${GRAPH}/todo/lists`, auth);
      for (const l of listes.filter((x) => passe(p.filtre, x.displayName)).slice(0, 5)) {
        const tq = new URLSearchParams({ $filter: "status ne 'completed'", $top: '30' });
        const { value: taches = [] } = await json<{ value?: { id: string; title: string; dueDateTime?: { dateTime: string } }[] }>('Microsoft To Do', `${GRAPH}/todo/lists/${l.id}/tasks?${tq}`, auth);
        for (const t of taches) out.taches.push({ id: `todo:${t.id}`, titre: t.title, echeance: t.dueDateTime ? brut(t.dueDateTime.dateTime).date : null, source: 'outlook' });
      }
    }

    if (p.imports.includes('relances')) {
      const depuis = new Date(Date.now() - 30 * 86400000).toISOString();
      const avant = new Date(Date.now() - delaiRelance * 86400000).toISOString();
      const sq = new URLSearchParams({ $filter: `sentDateTime ge ${depuis} and sentDateTime le ${avant}`, $top: '25', $select: 'subject,toRecipients,conversationId,sentDateTime,webLink' });
      const iq = new URLSearchParams({ $filter: `receivedDateTime ge ${depuis}`, $orderby: 'receivedDateTime desc', $top: '200', $select: 'conversationId,receivedDateTime' });
      const [{ value: envoyes = [] }, { value: recus = [] }] = await Promise.all([
        json<{ value?: Mail[] }>('Outlook', `${GRAPH}/mailFolders/sentitems/messages?${sq}`, auth),
        json<{ value?: Mail[] }>('Outlook', `${GRAPH}/mailFolders/inbox/messages?${iq}`, auth),
      ]);
      // Dernière réponse reçue par conversation
      const reponse = new Map<string, string>();
      for (const r of recus) if (r.conversationId && r.receivedDateTime && r.receivedDateTime > (reponse.get(r.conversationId) || '')) reponse.set(r.conversationId, r.receivedDateTime);
      const vus = new Set<string>();
      for (const m of envoyes) {
        if (!m.conversationId || vus.has(m.conversationId)) continue;
        vus.add(m.conversationId);
        if ((reponse.get(m.conversationId) || '') > (m.sentDateTime || '')) continue;
        const dest = m.toRecipients?.[0]?.emailAddress;
        out.relances.push({ id: m.conversationId, contact: dest?.name || dest?.address || 'Destinataire', sujet: m.subject || '(sans objet)', date: jour(0, fuseau), source: 'outlook', lien: m.webLink });
      }
    }

    // Boîte mail : la réception des 7 derniers jours, un message par fil.
    if (p.imports.includes('mails')) {
      const mq = new URLSearchParams({ $filter: `receivedDateTime ge ${new Date(Date.now() - 7 * 86400000).toISOString()}`, $orderby: 'receivedDateTime desc', $top: '25', $select: 'subject,from,receivedDateTime,webLink,isRead,conversationId' });
      const { value = [] } = await json<{ value?: (Mail & { isRead?: boolean })[] }>('Outlook', `${GRAPH}/mailFolders/inbox/messages?${mq}`, auth);
      out.mails = rangerMails(
        value.map((m): MailImporte => {
          const d = m.receivedDateTime ? brut(m.receivedDateTime) : { date: jour(0, fuseau), heure: undefined };
          return { id: m.id, fil: m.conversationId, sujet: m.subject || '(sans objet)', contact: m.from?.emailAddress?.name || m.from?.emailAddress?.address || '', date: d.date, heure: d.heure, sens: 'recu', nonLu: m.isRead === false, lien: m.webLink, source: 'outlook' };
        }),
      );
    }

    return out;
  },
};
