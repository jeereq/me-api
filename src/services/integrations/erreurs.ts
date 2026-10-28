/** Lit la réponse d'erreur d'un service externe et dit quoi faire (module pur, testé). */
export type Diagnostic = { message: string; auth: boolean };

type Corps = { error?: unknown; error_description?: unknown };

/** Toutes les raisons que Google renvoie, en minuscules (« accessNotConfigured », « SERVICE_DISABLED »…). */
function raisons(data: Corps): string {
  const e = data?.error;
  if (typeof e === 'string') return `${e} ${typeof data.error_description === 'string' ? data.error_description : ''}`.toLowerCase();
  if (e && typeof e === 'object') {
    const o = e as { status?: unknown; message?: unknown; errors?: { reason?: unknown }[]; details?: { reason?: unknown }[] };
    return [o.status, o.message, ...(o.errors || []).map((x) => x.reason), ...(o.details || []).map((x) => x.reason)]
      .filter((x): x is string => typeof x === 'string')
      .join(' ')
      .toLowerCase();
  }
  return '';
}

/**
 * Pourquoi Microsoft ou Google refuse une connexion, et quoi faire, en français. Les refus qui viennent de l'organisation
 * du compte (autre domaine, consentement d'un administrateur) arrivent surtout quand on ajoute un compte d'un autre domaine.
 * `brut` : le texte d'erreur tel que le service le renvoie (code AADSTS compris). Null si on ne le reconnaît pas.
 */
export function expliquerRefus(brut: string): string | null {
  const t = (brut || '').toLowerCase();
  if (/aadsts50020|aadsts50034|aadsts700016|aadsts700038/.test(t))
    return 'Ce compte appartient à un autre domaine que ceux acceptés par l’application Microsoft de Me. Dans le portail Azure, l’application doit accepter « les comptes de n’importe quel annuaire organisationnel et les comptes Microsoft personnels » (administrateur du serveur), et MICROSOFT_TENANT_ID doit valoir « common ».';
  if (/aadsts65001|aadsts90094|aadsts650056|aadsts900941|admin.?consent|need admin approval/.test(t))
    return 'L’administrateur de ce domaine doit d’abord autoriser l’application Me (consentement administrateur dans Microsoft Entra), puis tu pourras connecter le compte.';
  if (/aadsts53003|aadsts53000|aadsts53001|conditional access/.test(t))
    return 'Une règle de sécurité de ce domaine (accès conditionnel) bloque la connexion depuis Me. Demande à son administrateur de l’autoriser.';
  if (/aadsts50105|aadsts50177|aadsts700020/.test(t)) return 'Ce compte n’a pas le droit d’utiliser l’application Me dans son domaine : demande à son administrateur de te l’attribuer.';
  if (/aadsts50011|aadsts900971/.test(t)) return 'L’adresse de retour de Me n’est pas enregistrée dans l’application Microsoft (administrateur du serveur) : ajoute {PUBLIC_URL}/api/integrations/microsoft/callback.';
  if (/aadsts7000215|aadsts7000222|aadsts7000218|aadsts700025/.test(t)) return 'Le secret de l’application Microsoft est faux ou expiré (administrateur du serveur) : crée-en un nouveau dans le portail Azure.';
  if (/org_internal/.test(t)) return 'L’application Google de Me est réservée à un seul domaine : ce compte n’en fait pas partie (administrateur du serveur : écran de consentement → type « Externe »).';
  if (/admin_policy_enforced|access_blocked/.test(t)) return 'L’administrateur de ce domaine Google bloque l’accès de l’application Me à ce compte.';
  return null;
}

export function diagnostiquer(service: string, status: number, data: Corps): Diagnostic {
  const r = raisons(data);
  const refus = expliquerRefus(r);
  if (refus) return { message: refus, auth: false };
  if (/accessnotconfigured|service_disabled|has not been used|is disabled/.test(r))
    return { message: `${service} : l'API correspondante n'est pas activée dans Google Cloud (API et services → Bibliothèque).`, auth: false };
  if (/invalid_grant|token has been expired or revoked/.test(r))
    return { message: 'L’autorisation a expiré ou a été retirée : reconnecte ce compte.', auth: true };
  if (/insufficient|scope/.test(r))
    return { message: 'Autorisations insuffisantes : reconnecte ce compte et accepte l’accès à l’agenda et aux mails.', auth: true };
  if (status === 401) return { message: 'La session avec ce compte a expiré : reconnecte-le.', auth: true };
  if (/ratelimit|quota|userratelimit/.test(r)) return { message: `${service} limite les requêtes pour l'instant, réessaie dans quelques minutes.`, auth: false };
  if (status === 403) return { message: 'Accès refusé : reconnecte ce compte.', auth: true };
  return { message: `${service} a répondu ${status}.`, auth: false };
}
