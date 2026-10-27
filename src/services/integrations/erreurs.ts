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

export function diagnostiquer(service: string, status: number, data: Corps): Diagnostic {
  const r = raisons(data);
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
