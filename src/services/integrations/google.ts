import { agendasALire, appliquerLibelles, extrait, rangerMails, type AgendaDispo, type MailImporte } from './choix.js';
import { base64Url, lendemain, messageNouveau, messageRfc822, verifierRendezvous, verifierTache } from './ecriture.js';
import { bearer, form, jour, json, local, nomContact, passe, urlRetour } from './http.js';
import { decoderEntites, texteDeGmail, type PartieGmail } from './lecture.js';
import { requeteGmail } from './recherche.js';
import { rangerDossiers } from './choix.js';
import { FIL_MAX, vide, type Connecteur, type DossierMail, type Elements, type GenreDossier, type LibelleDispo } from './types.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
// Lecture ET écriture : lire et écrire des mails, tenir l'agenda et les tâches depuis Me.
// `gmail.modify` sert seulement à marquer comme lu un mail ouvert dans Me (un compte connecté avant s'en passe).
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/tasks',
];
const id = () => process.env.GOOGLE_CLIENT_ID || '';
const secret = () => process.env.GOOGLE_CLIENT_SECRET || '';

type Token = { access_token: string; refresh_token?: string; expires_in: number };
type Event = { id: string; summary?: string; location?: string; htmlLink?: string; status?: string; start: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } };
type Cal = { id: string; summary?: string; summaryOverride?: string; selected?: boolean; primary?: boolean; backgroundColor?: string };
type Header = { name: string; value: string };
type Message = { id: string; threadId: string; labelIds?: string[]; internalDate?: string; snippet?: string; payload?: PartieGmail & { headers?: Header[] } };
type Libelle = { id: string; name: string; type?: 'system' | 'user'; color?: { backgroundColor?: string } };

/** Les libellés créés par l'utilisateur (pas INBOX, UNREAD…), par identifiant : ce sont eux que Me montre comme étiquettes. */
const libellesDuCompte = async (accessToken: string) => {
  const { labels = [] } = await json<{ labels?: Libelle[] }>('Gmail', `${GMAIL}/labels`, bearer(accessToken));
  return new Map(labels.filter((l) => l.type === 'user').map((l) => [l.id, l]));
};
const nomsLibelles = (ids: string[] | undefined, parId: Map<string, Libelle>) => (ids ?? []).map((x) => parId.get(x)?.name).filter((n): n is string => !!n);

/** Les en-têtes de messages, 20 appels à la fois : Gmail limite le débit par utilisateur. */
async function lireMeta(auth: ReturnType<typeof bearer>, ids: string[]): Promise<Message[]> {
  const out: Message[] = [];
  for (let i = 0; i < ids.length; i += 20)
    out.push(...(await Promise.all(ids.slice(i, i + 20).map((m) => json<Message>('Gmail', `${GMAIL}/messages/${m}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-ID&metadataHeaders=References`, auth)))));
  return out;
}

/** Un message Gmail tel que l'app le liste ; un message envoyé montre à qui il est parti. */
function versMailImporte(m: Message, fuseau: string, parId: Map<string, Libelle>, envoye = false, dossier?: string): MailImporte {
  const d = m.internalDate ? local(new Date(Number(m.internalDate)), fuseau) : { date: jour(0, fuseau), heure: undefined };
  const qui = envoye ? listeAdresses(entete(m, 'To'))[0] ?? '' : entete(m, 'From');
  const libelles = nomsLibelles(m.labelIds, parId);
  return {
    id: m.id,
    fil: m.threadId,
    sujet: entete(m, 'Subject') || '(sans objet)',
    contact: nomContact(qui),
    adresse: qui,
    messageId: entete(m, 'Message-ID') || undefined,
    references: entete(m, 'References') || undefined,
    date: d.date,
    heure: d.heure,
    sens: envoye ? 'envoye' : 'recu',
    nonLu: m.labelIds?.includes('UNREAD'),
    lien: lienMail(m.threadId),
    source: 'gmail',
    extrait: extrait(decoderEntites(m.snippet ?? '')),
    ...(libelles.length ? { libelles } : {}),
    ...(dossier ? { dossier } : {}),
  };
}

/** Les libellés système que Me montre comme dossiers, dans l'ordre de Gmail. */
const SYSTEME: [string, string, GenreDossier][] = [
  ['INBOX', 'Boîte de réception', 'reception'],
  ['STARRED', 'Suivis', 'suivis'],
  ['IMPORTANT', 'Importants', 'importants'],
  ['SENT', 'Envoyés', 'envoyes'],
  ['DRAFT', 'Brouillons', 'brouillons'],
  ['SPAM', 'Spam', 'indesirables'],
  ['TRASH', 'Corbeille', 'supprimes'],
];

/** La liste des agendas du compte, nommée comme dans Google Agenda. */
const listeAgendas = async (accessToken: string): Promise<AgendaDispo[]> => {
  const { items = [] } = await json<{ items?: Cal[] }>('Google Agenda', `${CAL}/users/me/calendarList?minAccessRole=reader`, bearer(accessToken));
  return items.map((c) => ({ id: c.id, nom: c.summaryOverride || c.summary || c.id, principal: c.primary, visible: c.selected !== false, couleur: c.backgroundColor }));
};

const entete = (m: Message, nom: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === nom.toLowerCase())?.value || '';
const lienMail = (threadId: string) => `https://mail.google.com/mail/u/0/#all/${threadId}`;
/** Les adresses d'un en-tête « To » ou « Cc » : « Marie <marie@x.fr>, paul@y.fr ». */
const listeAdresses = (h: string) => h.split(',').map((x) => x.trim()).filter(Boolean);

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
  sources: ['google_agenda', 'google_taches', 'gmail'],
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

  async importer({ jetons, fuseau, delaiRelance, prefs, agendas: choisis, chargement }) {
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
    const lire = (ids: string[]) => lireMeta(auth, ids);

    // Tâches : mails suivis (étoile) des 30 derniers jours.
    if (gmail.actif && gmail.imports.includes('taches')) {
      const { messages = [] } = await json<{ messages?: { id: string }[] }>('Gmail', `${GMAIL}/messages?${new URLSearchParams({ q: `is:starred newer_than:30d${filtreGmail}`, maxResults: '20' })}`, auth);
      for (const m of await lire(messages.map((x) => x.id))) {
        const sujet = entete(m, 'Subject') || '(sans objet)';
        const de = entete(m, 'From');
        out.taches.push({ id: m.id, titre: `${sujet} · ${nomContact(de)}`, echeance: null, source: 'gmail', lien: lienMail(m.threadId), mail: { fil: m.threadId, sujet, contact: nomContact(de), adresse: de || undefined } });
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
        const a = entete(dernier, 'To').split(',')[0];
        const sujet = entete(fil.messages![0], 'Subject') || '(sans objet)';
        out.relances.push({
          id: t.id,
          contact: nomContact(a),
          sujet,
          date: jour(0, fuseau),
          source: 'gmail',
          lien: lienMail(t.id),
          mail: { fil: t.id, sujet, contact: nomContact(a), adresse: a.trim() || undefined },
        });
      }
    }

    // Google Tasks : les tâches ouvertes des listes du compte, pour les cocher depuis Me.
    const gtaches = prefs('google_taches');
    if (gtaches.actif && gtaches.imports.includes('taches')) {
      const { items: listes = [] } = await json<{ items?: { id: string; title?: string }[] }>('Google Tasks', `${TASKS}/users/@me/lists?maxResults=50`, auth);
      for (const l of listes.filter((x) => passe(gtaches.filtre, x.title)).slice(0, 5)) {
        const q = new URLSearchParams({ showCompleted: 'false', showHidden: 'false', maxResults: '50' });
        const { items: tc = [] } = await json<{ items?: { id: string; title?: string; due?: string; status?: string }[] }>('Google Tasks', `${TASKS}/lists/${encodeURIComponent(l.id)}/tasks?${q}`, auth);
        for (const t of tc) {
          if (!t.title?.trim()) continue;
          out.taches.push({ id: `gtask:${l.id}:${t.id}`, titre: t.title, echeance: t.due ? t.due.slice(0, 10) : null, source: 'google_taches', liste: l.id });
        }
      }
    }

    // Boîte mail : les fils récents, pour lire et répondre depuis Me (objet, contact, date, extrait et libellés).
    if (gmail.actif && gmail.imports.includes('mails')) {
      const parId = await libellesDuCompte(jetons.accessToken).catch(() => new Map<string, Libelle>());
      out.libelles = [...parId.values()].map((l): LibelleDispo => ({ nom: l.name, ...(l.color?.backgroundColor ? { couleur: l.color.backgroundColor } : {}) })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
      // Deux fois plus de messages que de fils voulus : plusieurs messages d'un même fil se replient en une ligne.
      const q = new URLSearchParams({ q: `in:inbox newer_than:${chargement.jours}d${filtreGmail}`, maxResults: String(Math.min(150, chargement.max * 2)) });
      const { messages = [] } = await json<{ messages?: { id: string }[] }>('Gmail', `${GMAIL}/messages?${q}`, auth);
      out.mails = rangerMails(
        (await lire(messages.map((x) => x.id))).map((m) => versMailImporte(m, fuseau, parId)),
        chargement.max,
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

  async lireMail({ accessToken }, mailId, fuseau, ou) {
    const auth = bearer(accessToken);
    // Avec le fil, un seul appel rend le mail et les messages plus anciens de l'échange.
    const fil = ou?.fil ? await json<{ messages?: Message[] }>('Gmail', `${GMAIL}/threads/${encodeURIComponent(ou.fil)}?format=full`, auth).catch(() => null) : null;
    const tous = fil?.messages ?? [];
    const m = tous.find((x) => x.id === mailId) ?? (await json<Message>('Gmail', `${GMAIL}/messages/${encodeURIComponent(mailId)}?format=full`, auth));
    const { texte, piecesJointes } = texteDeGmail(m.payload);
    // Ouvert dans Me = lu. Un compte connecté sans ce droit reste « non lu » chez Gmail, sans bloquer la lecture.
    // Tout le fil, comme Gmail : la liste de Me signale un fil non lu tant qu'un de ses messages l'est, même ancien.
    const nonLu = [m, ...tous].some((x) => x.labelIds?.includes('UNREAD'));
    if (nonLu && !ou?.garderNonLu) {
      const url = ou?.fil ? `${GMAIL}/threads/${encodeURIComponent(ou.fil)}/modify` : `${GMAIL}/messages/${encodeURIComponent(mailId)}/modify`;
      await json('Gmail', url, corpsJson(accessToken, 'POST', { removeLabelIds: ['UNREAD'] })).catch((e) => console.error('Gmail : marquer comme lu', (e as Error).message));
    }
    const quand = (x: Message) => (x.internalDate ? local(new Date(Number(x.internalDate)), fuseau) : undefined);
    const d = quand(m);
    const de = entete(m, 'From');
    const parId = m.labelIds?.some((x) => x.startsWith('Label_')) ? await libellesDuCompte(accessToken).catch(() => new Map<string, Libelle>()) : new Map<string, Libelle>();
    const avant = tous.filter((x) => x.id !== m.id && Number(x.internalDate ?? 0) <= Number(m.internalDate ?? 0) && !x.labelIds?.includes('DRAFT')).slice(-FIL_MAX);
    return {
      id: m.id,
      sujet: entete(m, 'Subject') || '(sans objet)',
      de: nomContact(de),
      adresse: de,
      a: listeAdresses(entete(m, 'To')),
      cc: listeAdresses(entete(m, 'Cc')),
      date: d?.date,
      heure: d?.heure,
      texte,
      piecesJointes,
      lien: lienMail(m.threadId),
      libelles: nomsLibelles(m.labelIds, parId),
      fil: avant.map((x) => {
        const c = texteDeGmail(x.payload);
        const q = quand(x);
        const exp = entete(x, 'From');
        return { id: x.id, de: nomContact(exp), adresse: exp, date: q?.date, heure: q?.heure, texte: c.texte, piecesJointes: c.piecesJointes };
      }),
    };
  },

  async etiqueter({ accessToken }, e) {
    const parId = await libellesDuCompte(accessToken);
    const parNom = new Map([...parId.values()].map((l) => [l.name.toLowerCase(), l.id]));
    // Une étiquette nouvelle devient un libellé Gmail, visible aussi dans Gmail.
    for (const nom of e.ajouter.filter((n) => !parNom.has(n.toLowerCase()))) {
      const cree = await json<Libelle>('Gmail', `${GMAIL}/labels`, corpsJson(accessToken, 'POST', { name: nom, labelListVisibility: 'labelShow', messageListVisibility: 'show' }));
      parId.set(cree.id, { ...cree, type: 'user' });
      parNom.set(cree.name.toLowerCase(), cree.id);
    }
    const ids = (l: string[]) => l.map((n) => parNom.get(n.toLowerCase())).filter((x): x is string => !!x);
    const corps = { addLabelIds: ids(e.ajouter), removeLabelIds: ids(e.retirer) };
    // Tout le fil, comme dans Gmail où les libellés se voient par conversation.
    if (e.fil) {
      const t = await json<{ messages?: Message[] }>('Gmail', `${GMAIL}/threads/${encodeURIComponent(e.fil)}/modify`, corpsJson(accessToken, 'POST', corps));
      return { libelles: [...new Set((t.messages ?? []).flatMap((x) => nomsLibelles(x.labelIds, parId)))] };
    }
    const m = await json<Message>('Gmail', `${GMAIL}/messages/${encodeURIComponent(e.mailId)}/modify`, corpsJson(accessToken, 'POST', corps));
    return { libelles: m.labelIds ? nomsLibelles(m.labelIds, parId) : appliquerLibelles([], e.ajouter, []) };
  },

  async dossiers({ accessToken }) {
    // Gmail n'a pas de dossiers : ses libellés en tiennent lieu (« Clients/Kin » est un sous-dossier de « Clients »).
    const auth = bearer(accessToken);
    const parId = await libellesDuCompte(accessToken);
    const parNom = new Map([...parId.values()].map((l) => [l.name, l.id]));
    const ids = [...SYSTEME.map(([id]) => id), ...[...parId.keys()].slice(0, 60)];
    const comptes = new Map<string, { messagesUnread?: number; messagesTotal?: number; threadsUnread?: number }>();
    for (let i = 0; i < ids.length; i += 20)
      await Promise.all(ids.slice(i, i + 20).map(async (id) => comptes.set(id, await json<{ messagesUnread?: number; messagesTotal?: number; threadsUnread?: number }>('Gmail', `${GMAIL}/labels/${encodeURIComponent(id)}`, auth).catch(() => ({})))));
    const systeme = SYSTEME.map(([id, nom, genre]): DossierMail => ({ id, nom, genre, nonLus: genre === 'envoyes' || genre === 'brouillons' ? 0 : comptes.get(id)?.threadsUnread ?? comptes.get(id)?.messagesUnread ?? 0, total: comptes.get(id)?.messagesTotal }));
    const perso = [...parId.values()].slice(0, 60).map((l): DossierMail => {
      const coupe = l.name.lastIndexOf('/');
      const parent = coupe > 0 ? parNom.get(l.name.slice(0, coupe)) : undefined;
      return { id: l.id, nom: coupe > 0 ? l.name.slice(coupe + 1) : l.name, ...(parent ? { parent } : {}), genre: 'autre', nonLus: comptes.get(l.id)?.threadsUnread ?? 0, total: comptes.get(l.id)?.messagesTotal };
    });
    return [...systeme, ...rangerDossiers(perso)];
  },

  async mailsDuDossier({ accessToken }, l) {
    const auth = bearer(accessToken);
    const q = new URLSearchParams({ labelIds: l.dossier, maxResults: String(l.max), ...(l.suivant ? { pageToken: l.suivant } : {}) });
    const { messages = [], nextPageToken } = await json<{ messages?: { id: string }[]; nextPageToken?: string }>('Gmail', `${GMAIL}/messages?${q}`, auth);
    const parId = await libellesDuCompte(accessToken).catch(() => new Map<string, Libelle>());
    const envoye = l.dossier === 'SENT' || l.dossier === 'DRAFT';
    return { mails: (await lireMeta(auth, messages.map((m) => m.id))).map((m) => versMailImporte(m, l.fuseau, parId, envoye, l.dossier)), ...(nextPageToken ? { suivant: nextPageToken } : {}) };
  },

  async chercherMails({ accessToken }, r) {
    const auth = bearer(accessToken);
    const q = new URLSearchParams({ maxResults: String(r.max), ...(requeteGmail(r) ? { q: requeteGmail(r) } : {}), ...(r.dossier ? { labelIds: r.dossier } : {}), ...(r.suivant ? { pageToken: r.suivant } : {}) });
    const { messages = [], nextPageToken } = await json<{ messages?: { id: string }[]; nextPageToken?: string }>('Gmail', `${GMAIL}/messages?${q}`, auth);
    const parId = await libellesDuCompte(accessToken).catch(() => new Map<string, Libelle>());
    const envoye = r.dossier === 'SENT' || r.dossier === 'DRAFT';
    return { mails: (await lireMeta(auth, messages.map((m) => m.id))).map((m) => versMailImporte(m, r.fuseau, parId, envoye, r.dossier)), ...(nextPageToken ? { suivant: nextPageToken } : {}) };
  },

  async mailDuFil({ accessToken }, f) {
    const auth = bearer(accessToken);
    const t = await json<{ messages?: { id: string }[] }>('Gmail', `${GMAIL}/threads/${encodeURIComponent(f.fil)}?format=minimal`, auth);
    const dernier = t.messages?.at(-1);
    if (!dernier) return null;
    const [m] = await lireMeta(auth, [dernier.id]);
    const parId = await libellesDuCompte(accessToken).catch(() => new Map<string, Libelle>());
    return versMailImporte(m, f.fuseau, parId, !!m.labelIds?.includes('SENT'));
  },

  async deplacer({ accessToken }, d) {
    // Ranger dans un libellé : on le pose, et on retire celui d'où vient le mail (sortir de la réception = archiver).
    const corps = { addLabelIds: [d.dossier], removeLabelIds: d.depuis && d.depuis !== d.dossier ? [d.depuis] : [] };
    const url = d.fil ? `${GMAIL}/threads/${encodeURIComponent(d.fil)}/modify` : `${GMAIL}/messages/${encodeURIComponent(d.mailId)}/modify`;
    await json('Gmail', url, corpsJson(accessToken, 'POST', corps));
  },

  async envoyer({ accessToken }, n) {
    const env = await json<{ id: string; threadId: string }>('Gmail', `${GMAIL}/messages/send`, corpsJson(accessToken, 'POST', { raw: base64Url(messageNouveau(n)) }));
    return { lien: lienMail(env.threadId || env.id) };
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
