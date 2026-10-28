import { agendasALire, appliquerLibelles, extrait, rangerMails, type AgendaDispo, type MailImporte } from './choix.js';
import { ErreurSaisie, lendemain as lendemainMS, verifierNouveau, verifierRendezvous, verifierTache } from './ecriture.js';
import { bearer, ErreurExterne, form, jour, json, local, passe, urlRetour } from './http.js';
import { htmlEnTexte, nettoyerTexte } from './lecture.js';
import { requeteOutlook } from './recherche.js';
import { rangerDossiers } from './choix.js';
import { FIL_MAX, vide, type ChargementMails, type Connecteur, type DossierMail, type Elements, type GenreDossier, type LibelleDispo } from './types.js';

const GRAPH = 'https://graph.microsoft.com/v1.0/me';
/** La racine des appels pour une boîte : la sienne (`/me`), ou une boîte partagée (`/users/{adresse}`). */
const racine = (boite?: string) => (boite ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(boite)}` : GRAPH);
// Lecture ET écriture : lire et écrire des mails, tenir l'agenda et les tâches To Do depuis Me.
// `*.Shared` : lire, étiqueter et répondre depuis les boîtes partagées auxquelles l'utilisateur a accès.
// `MailboxSettings.ReadWrite` : les couleurs des catégories, et lire ou couper les règles de la boîte.
const SCOPES = 'offline_access openid email User.Read Calendars.ReadWrite Mail.ReadWrite Mail.Send Tasks.ReadWrite Mail.ReadWrite.Shared Mail.Send.Shared MailboxSettings.ReadWrite';

/** Les couleurs des catégories Outlook (preset0 à preset24), au plus près de ce qu'affiche Outlook. */
const PRESETS = ['#E74856', '#FF8C00', '#AB8B6B', '#FFD800', '#16C60C', '#00B7C3', '#8C9C3F', '#0078D4', '#8764B8', '#C239B3', '#A0AEB2', '#5A6A70', '#9B9B9B', '#606060', '#2B2B2B', '#A4262C', '#CA5010', '#8E562E', '#C19C00', '#107C10', '#038387', '#5C6E1E', '#004E8C', '#5C2E91', '#881798'];
const couleurPreset = (c?: string) => (c && /^preset\d+$/.test(c) ? PRESETS[Number(c.slice(6))] : undefined);
const id = () => process.env.MICROSOFT_CLIENT_ID || '';
const secret = () => process.env.MICROSOFT_CLIENT_SECRET || '';
// « common » accepte les comptes perso (outlook.com) et pro (Microsoft 365).
const tenant = () => process.env.MICROSOFT_TENANT_ID || 'common';
const tokenUrl = () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`;

type Token = { access_token: string; refresh_token?: string; expires_in: number };
type Event = { id: string; subject?: string; isAllDay?: boolean; isCancelled?: boolean; webLink?: string; location?: { displayName?: string }; start: { dateTime: string }; end?: { dateTime: string } };
type Mail = { id: string; subject?: string; webLink?: string; conversationId?: string; sentDateTime?: string; receivedDateTime?: string; from?: { emailAddress?: { name?: string; address?: string } }; toRecipients?: { emailAddress?: { name?: string; address?: string } }[]; flag?: { dueDateTime?: { dateTime: string } }; isRead?: boolean; categories?: string[]; bodyPreview?: string; hasAttachments?: boolean };

// Graph renvoie des dates sans fuseau quand on lui en impose un : on les lit telles quelles.
const brut = (dt: string) => ({ date: dt.slice(0, 10), heure: dt.slice(11, 16) });

/** Un appel JSON avec corps : même en-tête d'autorisation, plus le type de contenu. */
const corpsJson = (accessToken: string, method: string, corps: unknown) => ({ method, headers: { ...bearer(accessToken).headers, 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });

/** Un rendez-vous au format de Graph : les heures sont écrites dans le fuseau de l'utilisateur. */
function corpsEvenement(e: { titre: string; date: string; debut?: string; fin?: string; lieu?: string; journee?: boolean; fuseau: string }) {
  const v = verifierRendezvous(e);
  const quand = v.journee
    ? { isAllDay: true, start: { dateTime: `${v.date}T00:00:00`, timeZone: e.fuseau }, end: { dateTime: `${lendemainMS(v.date)}T00:00:00`, timeZone: e.fuseau } }
    : { isAllDay: false, start: { dateTime: `${v.date}T${v.debut}:00`, timeZone: e.fuseau }, end: { dateTime: `${v.date}T${v.fin}:00`, timeZone: e.fuseau } };
  return { subject: v.titre, ...(v.lieu ? { location: { displayName: v.lieu } } : {}), ...quand };
}

type Adresse = { emailAddress?: { name?: string; address?: string } };
type MailComplet = { id: string; subject?: string; webLink?: string; isRead?: boolean; hasAttachments?: boolean; receivedDateTime?: string; from?: Adresse; toRecipients?: Adresse[]; ccRecipients?: Adresse[]; body?: { contentType?: string; content?: string }; categories?: string[]; conversationId?: string; isDraft?: boolean };
const ecrireAdresse = (a: Adresse) => (a.emailAddress?.name && a.emailAddress.address ? `${a.emailAddress.name} <${a.emailAddress.address}>` : a.emailAddress?.address || a.emailAddress?.name || '');
const versGraph = (l: string[]) => l.map((address) => ({ emailAddress: { address } }));
const corpsTexte = (m: MailComplet) => (m.body?.contentType?.toLowerCase() === 'html' ? htmlEnTexte(m.body?.content || '') : nettoyerTexte(m.body?.content || ''));

const CHAMPS_LISTE = 'subject,from,toRecipients,receivedDateTime,sentDateTime,webLink,isRead,conversationId,categories,bodyPreview,hasAttachments';

/** Un message de Graph tel que l'app le liste ; un message envoyé montre à qui il est parti. */
function versMailImporte(m: Mail, fuseau: string, boite?: string, envoye = false, dossier?: string): MailImporte {
  const quand = envoye ? m.sentDateTime : m.receivedDateTime;
  const d = quand ? brut(quand) : { date: jour(0, fuseau), heure: undefined };
  const qui = envoye ? m.toRecipients?.[0]?.emailAddress : m.from?.emailAddress;
  return {
    id: m.id,
    fil: m.conversationId,
    sujet: m.subject || '(sans objet)',
    contact: qui?.name || qui?.address || '',
    adresse: qui?.address,
    date: d.date,
    heure: d.heure,
    sens: envoye ? 'envoye' : 'recu',
    nonLu: !envoye && m.isRead === false,
    lien: m.webLink,
    source: 'outlook',
    extrait: extrait(m.bodyPreview),
    ...(m.categories?.length ? { libelles: m.categories } : {}),
    ...(m.hasAttachments ? { pj: true } : {}),
    ...(boite ? { boite } : {}),
    ...(dossier ? { dossier } : {}),
  };
}

/** La réception d'une boîte (la sienne ou une partagée) sur la période choisie, un message par fil. */
async function mailsDeLaBoite(auth: ReturnType<typeof bearer>, fuseau: string, c: ChargementMails, boite?: string): Promise<MailImporte[]> {
  // Deux fois plus de messages que de fils voulus : plusieurs messages d'un même fil se replient en une ligne.
  const mq = new URLSearchParams({ $filter: `receivedDateTime ge ${new Date(Date.now() - c.jours * 86400000).toISOString()}`, $orderby: 'receivedDateTime desc', $top: String(Math.min(200, c.max * 2)), $select: CHAMPS_LISTE });
  const { value = [] } = await json<{ value?: Mail[] }>('Outlook', `${racine(boite)}/mailFolders/inbox/messages?${mq}`, auth);
  return rangerMails(
    value.map((m) => versMailImporte(m, fuseau, boite)),
    c.max,
  );
}

/** Les dossiers dont Outlook connaît le rôle, par leur nom réservé. */
const CONNUS: [string, GenreDossier][] = [
  ['inbox', 'reception'],
  ['sentitems', 'envoyes'],
  ['drafts', 'brouillons'],
  ['archive', 'archive'],
  ['deleteditems', 'supprimes'],
  ['junkemail', 'indesirables'],
];
type Dossier = { id: string; displayName?: string; parentFolderId?: string; childFolderCount?: number; unreadItemCount?: number; totalItemCount?: number; isHidden?: boolean };

/** Une condition ou une action de règle Outlook, dite en français. */
const liste = (l?: string[]) => (l ?? []).map((x) => `« ${x} »`).join(' ou ');
const adresses = (l?: Adresse[]) => (l ?? []).map((a) => a.emailAddress?.name || a.emailAddress?.address).filter(Boolean).join(', ');
type Predicats = { fromAddresses?: Adresse[]; sentToAddresses?: Adresse[]; subjectContains?: string[]; bodyContains?: string[]; bodyOrSubjectContains?: string[]; senderContains?: string[]; headerContains?: string[]; sentToMe?: boolean; sentOnlyToMe?: boolean; sentCcMe?: boolean; hasAttachments?: boolean; importance?: string; isAutomaticReply?: boolean; categories?: string[] };
type Actions = { moveToFolder?: string; copyToFolder?: string; delete?: boolean; permanentDelete?: boolean; markAsRead?: boolean; markImportance?: string; assignCategories?: string[]; forwardTo?: Adresse[]; redirectTo?: Adresse[]; stopProcessingRules?: boolean };
const IMPORTANCE: Record<string, string> = { low: 'faible', normal: 'normale', high: 'haute' };

export function decrireConditions(p: Predicats = {}): string[] {
  return [
    p.fromAddresses?.length ? `De ${adresses(p.fromAddresses)}` : '',
    p.senderContains?.length ? `L'expéditeur contient ${liste(p.senderContains)}` : '',
    p.sentToAddresses?.length ? `Envoyé à ${adresses(p.sentToAddresses)}` : '',
    p.subjectContains?.length ? `L'objet contient ${liste(p.subjectContains)}` : '',
    p.bodyContains?.length ? `Le message contient ${liste(p.bodyContains)}` : '',
    p.bodyOrSubjectContains?.length ? `L'objet ou le message contient ${liste(p.bodyOrSubjectContains)}` : '',
    p.headerContains?.length ? `L'en-tête contient ${liste(p.headerContains)}` : '',
    p.sentOnlyToMe ? 'Envoyé à moi seul' : p.sentToMe ? 'Envoyé à moi' : '',
    p.sentCcMe ? 'Moi en copie' : '',
    p.hasAttachments ? 'Avec pièce jointe' : '',
    p.importance ? `Importance ${IMPORTANCE[p.importance] ?? p.importance}` : '',
    p.isAutomaticReply ? 'Réponse automatique' : '',
    p.categories?.length ? `Catégorie ${liste(p.categories)}` : '',
  ].filter(Boolean);
}

export function decrireActions(a: Actions = {}, nomDossier: (id: string) => string = (id) => id): string[] {
  return [
    a.moveToFolder ? `Déplacer dans ${nomDossier(a.moveToFolder)}` : '',
    a.copyToFolder ? `Copier dans ${nomDossier(a.copyToFolder)}` : '',
    a.assignCategories?.length ? `Catégorie ${liste(a.assignCategories)}` : '',
    a.markAsRead ? 'Marquer comme lu' : '',
    a.markImportance ? `Importance ${IMPORTANCE[a.markImportance] ?? a.markImportance}` : '',
    a.forwardTo?.length ? `Transférer à ${adresses(a.forwardTo)}` : '',
    a.redirectTo?.length ? `Rediriger vers ${adresses(a.redirectTo)}` : '',
    a.permanentDelete ? 'Supprimer définitivement' : a.delete ? 'Supprimer' : '',
    a.stopProcessingRules ? 'Ne pas appliquer les règles suivantes' : '',
  ].filter(Boolean);
}

/** Une tâche au format To Do ; cocher ou rouvrir passe par `status`. */
const corpsTache = (v: { titre: string; echeance?: string | null; fait?: boolean }) => ({
  title: v.titre,
  status: v.fait ? 'completed' : 'notStarted',
  ...(v.echeance ? { dueDateTime: { dateTime: `${v.echeance}T00:00:00`, timeZone: 'UTC' } } : {}),
});

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
  boitesPartagees: true,
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

  async importer({ jetons, fuseau, delaiRelance, prefs, agendas: choisis, boitesPartagees, chargement }) {
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
      const q = new URLSearchParams({ $filter: "flag/flagStatus eq 'flagged'", $top: '20', $select: 'subject,from,flag,webLink,conversationId' });
      const { value = [] } = await json<{ value?: Mail[] }>('Outlook', `${GRAPH}/messages?${q}`, auth);
      for (const m of value) {
        const de = m.from?.emailAddress;
        const mail = m.conversationId ? { fil: m.conversationId, sujet: m.subject || '(sans objet)', contact: de?.name || de?.address, adresse: de?.address } : undefined;
        out.taches.push({ id: m.id, titre: `${m.subject || '(sans objet)'} · ${de?.name || ''}`.replace(/ · $/, ''), echeance: m.flag?.dueDateTime ? brut(m.flag.dueDateTime.dateTime).date : null, source: 'outlook', lien: m.webLink, mail });
      }
      // Microsoft To Do
      const { value: listes = [] } = await json<{ value?: { id: string; displayName: string }[] }>('Microsoft To Do', `${GRAPH}/todo/lists`, auth);
      for (const l of listes.filter((x) => passe(p.filtre, x.displayName)).slice(0, 5)) {
        const tq = new URLSearchParams({ $filter: "status ne 'completed'", $top: '30' });
        const { value: taches = [] } = await json<{ value?: { id: string; title: string; dueDateTime?: { dateTime: string } }[] }>('Microsoft To Do', `${GRAPH}/todo/lists/${l.id}/tasks?${tq}`, auth);
        for (const t of taches) out.taches.push({ id: `todo:${l.id}:${t.id}`, titre: t.title, echeance: t.dueDateTime ? brut(t.dueDateTime.dateTime).date : null, source: 'outlook', liste: l.id });
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
        const contact = dest?.name || dest?.address || 'Destinataire';
        const sujet = m.subject || '(sans objet)';
        out.relances.push({ id: m.conversationId, contact, sujet, date: jour(0, fuseau), source: 'outlook', lien: m.webLink, mail: { fil: m.conversationId, sujet, contact, adresse: dest?.address } });
      }
    }

    // Boîte mail : la réception des 7 derniers jours, un message par fil ; puis chaque boîte partagée demandée.
    if (p.imports.includes('mails')) {
      out.mails = await mailsDeLaBoite(auth, fuseau, chargement);
      out.boites = [];
      for (const boite of boitesPartagees) {
        try {
          out.mails.push(...(await mailsDeLaBoite(auth, fuseau, chargement, boite)));
          out.boites.push({ adresse: boite });
        } catch (e) {
          // Une boîte refusée ne bloque pas le reste : l'app dit laquelle et pourquoi.
          out.boites.push({ adresse: boite, erreur: e instanceof ErreurExterne && e.auth ? 'Accès refusé : reconnecte le compte Microsoft, et vérifie que ton administrateur t’a donné accès à cette boîte.' : e instanceof Error ? e.message : 'Boîte illisible pour l’instant.' });
        }
      }
      // Les catégories du compte, avec leur couleur ; sans ce droit, celles vues sur les mails suffisent.
      const { value: cats = [] } = await json<{ value?: { displayName: string; color?: string }[] }>('Outlook', `${GRAPH}/outlook/masterCategories`, auth).catch(() => ({ value: [] }));
      const vues = new Set(out.mails.flatMap((m) => m.libelles ?? []));
      const libelles: LibelleDispo[] = cats.map((c) => ({ nom: c.displayName, ...(couleurPreset(c.color) ? { couleur: couleurPreset(c.color) } : {}) }));
      for (const v of vues) if (!libelles.some((l) => l.nom.toLowerCase() === v.toLowerCase())) libelles.push({ nom: v });
      out.libelles = libelles.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    }

    return out;
  },

  /* ---------- Écriture ---------- */

  async repondre({ accessToken }, r) {
    if (!r.texte.trim()) throw new ErreurSaisie('Écris ta réponse avant de l’envoyer.');
    // Graph répond dans le fil tout seul : il reprend l'objet, les destinataires et les en-têtes du message.
    await json('Outlook', `${racine(r.boite)}/messages/${encodeURIComponent(r.mailId)}/reply`, corpsJson(accessToken, 'POST', { comment: r.texte.trim() }));
    return {};
  },

  async lireMail({ accessToken }, mailId, fuseau, ou) {
    const base = racine(ou?.boite);
    const url = `${base}/messages/${encodeURIComponent(mailId)}`;
    const texte = bearer(accessToken, { Prefer: 'outlook.body-content-type="text"' });
    const champs = 'subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,isRead,webLink,categories,conversationId,isDraft';
    // Graph sait rendre le corps en texte ; s'il renvoie quand même du HTML, on le convertit.
    const m = await json<MailComplet>('Outlook', `${url}?$select=${champs}`, texte);
    const pieces = m.hasAttachments ? ((await json<{ value?: { name?: string }[] }>('Outlook', `${url}/attachments?$select=name`, bearer(accessToken)).catch(() => ({ value: [] }))).value ?? []) : [];
    if (m.isRead === false && !ou?.garderNonLu) await json('Outlook', url, corpsJson(accessToken, 'PATCH', { isRead: true })).catch(() => {});
    // Les messages plus anciens de la conversation (sans tri côté Graph, qui refuse filtre et tri sur ces champs ensemble).
    const conv = m.conversationId
      ? ((await json<{ value?: MailComplet[] }>('Outlook', `${base}/messages?${new URLSearchParams({ $filter: `conversationId eq '${m.conversationId.replace(/'/g, "''")}'`, $top: '25', $select: champs })}`, texte).catch(() => ({ value: [] }))).value ?? [])
      : [];
    // Les autres messages non lus de la conversation aussi : la liste de Me montre la conversation entière comme non lue.
    if (!ou?.garderNonLu) await Promise.all(conv.filter((x) => x.id !== m.id && x.isRead === false && !x.isDraft).map((x) => json('Outlook', `${base}/messages/${encodeURIComponent(x.id)}`, corpsJson(accessToken, 'PATCH', { isRead: true })).catch(() => {})));
    const avant = conv
      .filter((x) => x.id !== m.id && !x.isDraft && (x.receivedDateTime ?? '') <= (m.receivedDateTime ?? ''))
      .sort((a, b) => (a.receivedDateTime ?? '').localeCompare(b.receivedDateTime ?? ''))
      .slice(-FIL_MAX);
    // receivedDateTime est en UTC (« …Z ») : on le ramène au fuseau de l'utilisateur.
    const quand = (x: MailComplet) => (x.receivedDateTime ? local(x.receivedDateTime, fuseau) : undefined);
    const d = quand(m);
    return {
      id: m.id,
      sujet: m.subject || '(sans objet)',
      de: m.from?.emailAddress?.name || m.from?.emailAddress?.address || '',
      adresse: m.from?.emailAddress?.address,
      a: (m.toRecipients ?? []).map(ecrireAdresse).filter(Boolean),
      cc: (m.ccRecipients ?? []).map(ecrireAdresse).filter(Boolean),
      date: d?.date,
      heure: d?.heure,
      texte: corpsTexte(m),
      piecesJointes: pieces.map((p) => p.name).filter((n): n is string => !!n),
      lien: m.webLink,
      libelles: m.categories ?? [],
      fil: avant.map((x) => ({ id: x.id, de: x.from?.emailAddress?.name || x.from?.emailAddress?.address || '', adresse: x.from?.emailAddress?.address, date: quand(x)?.date, heure: quand(x)?.heure, texte: corpsTexte(x), piecesJointes: [] })),
    };
  },

  async etiqueter({ accessToken }, e) {
    // Les catégories Outlook sont des noms libres : on part de celles du message et on renvoie la liste entière.
    const url = `${racine(e.boite)}/messages/${encodeURIComponent(e.mailId)}`;
    const m = await json<{ categories?: string[] }>('Outlook', `${url}?$select=categories`, bearer(accessToken));
    const categories = appliquerLibelles(m.categories ?? [], e.ajouter, e.retirer);
    await json('Outlook', url, corpsJson(accessToken, 'PATCH', { categories }));
    return { libelles: categories };
  },

  async dossiers({ accessToken }, boite) {
    const base = racine(boite);
    const auth = bearer(accessToken);
    const champs = '$select=id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount,isHidden&$top=100';
    // Les rôles d'abord (réception, envoyés…), puis l'arbre : trois niveaux, 150 dossiers au plus.
    const roles = new Map<string, GenreDossier>();
    await Promise.all(CONNUS.map(async ([nom, genre]) => {
      const d = await json<{ id: string }>('Outlook', `${base}/mailFolders/${nom}?$select=id`, auth).catch(() => null);
      if (d) roles.set(d.id, genre);
    }));
    const tous: Dossier[] = [];
    let niveau = (await json<{ value?: Dossier[] }>('Outlook', `${base}/mailFolders?${champs}`, auth)).value ?? [];
    for (let profondeur = 0; profondeur < 3 && niveau.length && tous.length < 150; profondeur++) {
      tous.push(...niveau.filter((d) => !d.isHidden));
      const parents = niveau.filter((d) => !d.isHidden && d.childFolderCount);
      const enfants = await Promise.all(parents.slice(0, 30).map((d) => json<{ value?: Dossier[] }>('Outlook', `${base}/mailFolders/${encodeURIComponent(d.id)}/childFolders?${champs}`, auth).then((r) => r.value ?? []).catch(() => [])));
      niveau = enfants.flat();
    }
    const ids = new Set(tous.map((d) => d.id));
    return rangerDossiers(
      tous.slice(0, 150).map((d): DossierMail => ({ id: d.id, nom: d.displayName || 'Dossier', ...(d.parentFolderId && ids.has(d.parentFolderId) ? { parent: d.parentFolderId } : {}), genre: roles.get(d.id) ?? 'autre', nonLus: d.unreadItemCount ?? 0, total: d.totalItemCount })),
    );
  },

  async mailsDuDossier({ accessToken }, l) {
    const base = racine(l.boite);
    const auth = bearer(accessToken);
    // Le dossier des envoyés montre à qui le mail est parti, comme dans Outlook.
    const envoyes = await json<{ id: string }>('Outlook', `${base}/mailFolders/sentitems?$select=id`, auth).then((d) => d.id === l.dossier || l.dossier === 'sentitems').catch(() => l.dossier === 'sentitems');
    const saut = Math.max(0, Number(l.suivant) || 0);
    const q = new URLSearchParams({ $orderby: `${envoyes ? 'sentDateTime' : 'receivedDateTime'} desc`, $top: String(l.max), $skip: String(saut), $select: CHAMPS_LISTE });
    const { value = [] } = await json<{ value?: Mail[] }>('Outlook', `${base}/mailFolders/${encodeURIComponent(l.dossier)}/messages?${q}`, auth);
    return { mails: value.map((m) => versMailImporte(m, l.fuseau, l.boite, envoyes, l.dossier)), ...(value.length === l.max ? { suivant: String(saut + l.max) } : {}) };
  },

  async chercherMails({ accessToken }, r) {
    const base = racine(r.boite);
    const { params, garder } = requeteOutlook(r, CHAMPS_LISTE);
    const chemin = r.dossier ? `${base}/mailFolders/${encodeURIComponent(r.dossier)}/messages` : `${base}/messages`;
    const { value = [] } = await json<{ value?: Mail[] }>('Outlook', `${chemin}?${params}`, bearer(accessToken));
    const gardes = value.filter((m) => garder(m.receivedDateTime)).slice(0, r.max);
    const saut = Math.max(0, Number(r.suivant) || 0);
    return { mails: gardes.map((m) => versMailImporte(m, r.fuseau, r.boite, false, r.dossier)), ...(!params.has('$search') && value.length === r.max ? { suivant: String(saut + r.max) } : {}) };
  },

  async mailDuFil({ accessToken }, f) {
    // Graph refuse de trier sur un champ absent du filtre : les messages du fil sont triés ici, le plus récent d'abord.
    const q = new URLSearchParams({ $filter: `conversationId eq '${f.fil.replace(/'/g, "''")}'`, $top: '50', $select: CHAMPS_LISTE });
    const { value = [] } = await json<{ value?: Mail[] }>('Outlook', `${GRAPH}/messages?${q}`, bearer(accessToken));
    const quand = (m: Mail) => m.sentDateTime || m.receivedDateTime || '';
    const m = [...value].sort((a, b) => quand(b).localeCompare(quand(a)))[0];
    if (!m) return null;
    const envoye = !!f.moi && m.from?.emailAddress?.address?.toLowerCase() === f.moi.toLowerCase();
    return versMailImporte(m, f.fuseau, undefined, envoye);
  },

  async deplacer({ accessToken }, d) {
    await json('Outlook', `${racine(d.boite)}/messages/${encodeURIComponent(d.mailId)}/move`, corpsJson(accessToken, 'POST', { destinationId: d.dossier }));
  },

  async regles({ accessToken }) {
    const auth = bearer(accessToken);
    type R = { id: string; displayName?: string; sequence?: number; isEnabled?: boolean; hasError?: boolean; conditions?: Predicats; actions?: Actions };
    const [{ value = [] }, noms] = await Promise.all([
      json<{ value?: R[] }>('Outlook', `${GRAPH}/mailFolders/inbox/messageRules`, auth),
      // Les règles nomment les dossiers par identifiant : on les traduit en noms.
      this.dossiers!({ accessToken }).then((l) => new Map(l.map((d) => [d.id, d.nom]))).catch(() => new Map<string, string>()),
    ]);
    return value
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .map((r) => ({ id: r.id, nom: r.displayName || 'Règle', active: r.isEnabled !== false, ordre: r.sequence ?? 0, conditions: decrireConditions(r.conditions), actions: decrireActions(r.actions, (id) => `« ${noms.get(id) ?? 'un dossier'} »`), ...(r.hasError ? { enErreur: true } : {}) }));
  },

  async activerRegle({ accessToken }, id, active) {
    await json('Outlook', `${GRAPH}/mailFolders/inbox/messageRules/${encodeURIComponent(id)}`, corpsJson(accessToken, 'PATCH', { isEnabled: active }));
  },

  async envoyer({ accessToken }, n) {
    const v = verifierNouveau(n);
    await json('Outlook', `${GRAPH}/sendMail`, corpsJson(accessToken, 'POST', { message: { subject: v.sujet, body: { contentType: 'Text', content: v.texte }, toRecipients: versGraph(v.a), ccRecipients: versGraph(v.cc) }, saveToSentItems: true }));
    return {};
  },

  async creerEvenement({ accessToken }, e) {
    const env = await json<{ id: string; webLink?: string }>('Outlook', `${GRAPH}/calendars/${encodeURIComponent(e.agendaId)}/events`, corpsJson(accessToken, 'POST', corpsEvenement(e)));
    return { id: env.id, lien: env.webLink };
  },

  async modifierEvenement({ accessToken }, e) {
    const env = await json<{ webLink?: string }>('Outlook', `${GRAPH}/events/${encodeURIComponent(e.id)}`, corpsJson(accessToken, 'PATCH', corpsEvenement(e)));
    return { lien: env.webLink };
  },

  async supprimerEvenement({ accessToken }, e) {
    await json('Outlook', `${GRAPH}/events/${encodeURIComponent(e.id)}`, { method: 'DELETE', ...bearer(accessToken) });
  },

  async listesTaches({ accessToken }) {
    const { value = [] } = await json<{ value?: { id: string; displayName?: string; wellknownListName?: string }[] }>('Microsoft To Do', `${GRAPH}/todo/lists`, bearer(accessToken));
    return value.map((l) => ({ id: l.id, nom: l.displayName || 'Tâches', principale: l.wellknownListName === 'defaultList' }));
  },

  async creerTache({ accessToken }, t) {
    const v = verifierTache(t);
    const env = await json<{ id: string }>('Microsoft To Do', `${GRAPH}/todo/lists/${encodeURIComponent(t.listeId)}/tasks`, corpsJson(accessToken, 'POST', corpsTache(v)));
    return { id: env.id };
  },

  async majTache({ accessToken }, t) {
    const v = verifierTache(t);
    await json('Microsoft To Do', `${GRAPH}/todo/lists/${encodeURIComponent(t.listeId)}/tasks/${encodeURIComponent(t.id)}`, corpsJson(accessToken, 'PATCH', corpsTache(v)));
  },
};
