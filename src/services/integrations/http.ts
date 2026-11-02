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

/**
 * Microsoft Graph n'accepte que 4 appels simultanés par boîte mail et par application (« MailboxConcurrency ») :
 * au-delà, il répond 429 ApplicationThrottled. On garde donc au plus `GRAPH_PAR_BOITE` appels en cours par boîte,
 * les suivants attendent leur tour, et un 429 (ou 503/504) est rejoué après l'attente demandée par Graph.
 */
export const GRAPH_PAR_BOITE = 3;
const GRAPH_ESSAIS = 4;
const ATTENTE_MAX_MS = 10_000;

/** La boîte visée par un appel Graph : `/users/{adresse}`, ou `/me` (propre au jeton, donc à la personne). */
export function boiteGraph(url: string, init: RequestInit = {}): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = /\/v1\.0\/users\/([^/?]+)/i.exec(u.pathname);
  if (m) return `users/${decodeURIComponent(m[1]).toLowerCase()}`;
  if (/\/v1\.0\/me(\/|$)/i.test(u.pathname)) {
    const auth = new Headers(init.headers).get('authorization') ?? '';
    return `me/${auth.slice(-24)}`;
  }
  return null;
}

const enCours = new Map<string, { actifs: number; file: (() => void)[] }>();

/** Fait passer `fn` quand la boîte a une place libre (au plus `max` appels simultanés par boîte). */
export async function parBoite<T>(boite: string | null, fn: () => Promise<T>, max = GRAPH_PAR_BOITE): Promise<T> {
  if (!boite) return fn();
  let e = enCours.get(boite);
  if (!e) enCours.set(boite, (e = { actifs: 0, file: [] }));
  if (e.actifs >= max) await new Promise<void>((ok) => e!.file.push(ok));
  else e.actifs++;
  try {
    return await fn();
  } finally {
    const suivant = e.file.shift();
    // La place passe directement au suivant ; sans attente, la boîte se libère.
    if (suivant) suivant();
    else if (--e.actifs === 0) enCours.delete(boite);
  }
}

/** Combien attendre avant de rejouer : l'en-tête Retry-After s'il existe, sinon 1 s, 2 s, 4 s… (avec un peu de hasard). */
export function attenteAvantReessai(res: Pick<Response, 'headers'>, essai: number): number {
  const ra = res.headers.get('retry-after');
  const s = ra != null && ra.trim() !== '' ? Number(ra) : NaN;
  const base = Number.isFinite(s) && s >= 0 ? s * 1000 : 1000 * 2 ** essai;
  return Math.min(ATTENTE_MAX_MS, base + Math.floor(Math.random() * 250));
}

const REJOUABLES = new Set([429, 503, 504]);
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function appeler(service: string, url: string, init: RequestInit, rejouer: boolean): Promise<Response> {
  for (let essai = 0; ; essai++) {
    let res: Response;
    try {
      // Le délai court aussi pendant la lecture de la réponse (`res.json()` plus bas).
      res = await fetch(url, { signal: delai(), ...init });
    } catch (e) {
      throw new ErreurExterne(estDelai(e) ? `${service} met trop de temps à répondre.` : `${service} est injoignable.`);
    }
    if (!rejouer || !REJOUABLES.has(res.status) || essai >= GRAPH_ESSAIS - 1) return res;
    await res.body?.cancel().catch(() => {});
    await pause(attenteAvantReessai(res, essai));
  }
}

export async function json<T>(service: string, url: string, init: RequestInit = {}): Promise<T> {
  // Seuls les appels Graph (chemin /v1.0/me ou /v1.0/users/…) sont limités par boîte et rejoués :
  // un 429 de Graph veut dire « pas traité, reviens plus tard ».
  const boite = boiteGraph(url, init);
  const lire = async () => {
    const res = await appeler(service, url, init, boite !== null);
    return { res, data: (await res.json().catch(() => ({}))) as T & { error?: unknown; ok?: boolean } };
  };
  const { res, data } = await parBoite(boite, lire);
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
