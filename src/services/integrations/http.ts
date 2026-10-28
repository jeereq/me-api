import { delai, estDelai } from '../../utils/delai.js';
import { HttpError } from '../../utils/http.js';
import { diagnostiquer } from './erreurs.js';

/** Erreur d'un service externe ; `auth` signale un accès révoqué (il faut reconnecter le compte). */
export class ErreurExterne extends Error {
  constructor(
    message: string,
    public auth = false,
  ) {
    super(message);
  }
}

export async function json<T>(service: string, url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    // Le délai court aussi pendant la lecture de la réponse (`res.json()` plus bas).
    res = await fetch(url, { signal: delai(), ...init });
  } catch (e) {
    throw new ErreurExterne(estDelai(e) ? `${service} met trop de temps à répondre.` : `${service} est injoignable.`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: unknown; ok?: boolean };
  if (!res.ok) {
    console.error(service, res.status, url.split('?')[0], JSON.stringify(data).slice(0, 300));
    const d = diagnostiquer(service, res.status, data);
    throw new ErreurExterne(d.message, d.auth);
  }
  return data;
}

export const form = (o: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

export const bearer = (t: string, extra: Record<string, string> = {}) => ({ headers: { Authorization: `Bearer ${t}`, ...extra } });

export const urlRetour = (f: string) => `${(process.env.PUBLIC_URL || '').replace(/\/+$/, '')}/api/integrations/${f}/callback`;

export const exiger = (ok: boolean, nom: string) => {
  if (!ok) throw new HttpError(503, `${nom} n'est pas configuré sur le serveur (voir le README de me-api).`);
};

/** Date et heure locales d'un instant, dans le fuseau de l'utilisateur. */
export function local(instant: string | Date, fuseau: string) {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, heure: `${parts.hour}:${parts.minute}` };
}

export const jour = (decalageJours = 0, fuseau = 'UTC') => local(new Date(Date.now() + decalageJours * 86400000), fuseau).date;

/** Garde un élément si aucun filtre n'est réglé, ou si son nom contient l'un des filtres. */
export const passe = (filtre: string[], ...noms: (string | undefined)[]) =>
  !filtre.length || noms.some((n) => n && filtre.some((f) => n.toLowerCase().includes(f.toLowerCase())));

/** Nom lisible depuis un en-tête « Nom <email> ». */
export const nomContact = (h = '') => h.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || h.replace(/[<>]/g, '');
