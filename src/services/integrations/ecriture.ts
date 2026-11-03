/**
 * Ce que Me écrit dans les comptes connectés : réponses aux mails, rendez-vous, tâches.
 * Module pur (aucun appel réseau) : il compose, vérifie et met en forme ; les connecteurs se chargent d'envoyer.
 * Dates en texte « AAAA-MM-JJ », heures en « HH:MM ».
 */

export class ErreurSaisie extends Error {}

/* ---------- Réponse à un mail ---------- */

export type Reponse = {
  /** Adresse du destinataire (l'expéditeur du message auquel on répond), ou plusieurs. */
  a: string | string[];
  /** Les personnes en copie. */
  cc?: string[];
  sujet: string;
  texte: string;
  /** `Message-ID` du message d'origine : c'est lui qui raccroche la réponse au bon fil. */
  messageId?: string;
  /** `References` du message d'origine, à prolonger. */
  references?: string;
  /** Adresse du compte qui répond ; absente, le service met la sienne. */
  de?: string;
};

/** « Re: » une seule fois en tête, quelle que soit la casse d'origine et sans empiler les « Re: Re: ». */
export function sujetReponse(sujet: string): string {
  const net = (sujet || '').replace(/^(\s*(re|ref|rép|rep)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
  return `Re: ${net || '(sans objet)'}`;
}

/** Encodage MIME d'un en-tête qui contient autre chose que de l'ASCII (accents, émojis). */
export function enteteEncode(valeur: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\u0000-\u007F]/.test(valeur)) return valeur;
  return `=?UTF-8?B?${Buffer.from(valeur, 'utf8').toString('base64')}?=`;
}

/** Une adresse seule : « Marie Dupont <marie@exemple.fr> » devient « marie@exemple.fr ». */
export const adresseSeule = (v: string) => (v.match(/<([^>]+)>/)?.[1] ?? v).trim();

/** Une personne d'un mail. */
export type Personne = { nom?: string; adresse: string };

/** Un en-tête d'adresses : « Paul <p@x.fr>, "Doe, Jean" <j@x.fr>, a@x.fr ». Une virgule entre guillemets ne sépare rien. */
export function lireAdresses(entete: string): Personne[] {
  const morceaux: string[] = [];
  let courant = '';
  let guillemet = false;
  let chevron = false;
  for (const c of entete) {
    if (c === '"') guillemet = !guillemet;
    if (c === '<' && !guillemet) chevron = true;
    if (c === '>' && !guillemet) chevron = false;
    if ((c === ',' || c === ';') && !guillemet && !chevron) {
      morceaux.push(courant);
      courant = '';
    } else courant += c;
  }
  morceaux.push(courant);
  return morceaux.flatMap((m) => {
    const adresse = adresseSeule(m);
    if (!adresse.includes('@')) return [];
    const nom = m.includes('<') ? m.slice(0, m.indexOf('<')).replace(/"/g, '').trim() : '';
    return [{ ...(nom ? { nom } : {}), adresse }];
  });
}

const memeAdresse = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Qui reçoit une réponse à tous : l'expéditeur (ou son « Répondre à »), les autres destinataires, et les personnes en copie, sans soi-même ni doublon.
 * Si le mail vient de soi, la réponse repart vers ceux à qui il était adressé.
 */
export function destinatairesReponse(m: { de: Personne[]; repondreA?: Personne[]; a: Personne[]; cc: Personne[] }, moi: string[]): { a: Personne[]; cc: Personne[] } {
  const estMoi = (p: Personne) => moi.some((x) => memeAdresse(x, p.adresse));
  const vus = new Set<string>();
  const garder = (l: Personne[]) =>
    l.filter((p) => {
      const k = p.adresse.trim().toLowerCase();
      if (estMoi(p) || vus.has(k)) return false;
      vus.add(k);
      return true;
    });
  const premiers = m.repondreA?.length ? m.repondreA : m.de;
  const a = garder([...premiers, ...m.a]);
  const cc = garder(m.cc);
  // Tout le monde était en copie : le premier passe en destinataire, un mail en a besoin d'un.
  return a.length ? { a, cc } : { a: cc.slice(0, 1), cc: cc.slice(1) };
}

/** Le message complet au format RFC 2822, prêt à être envoyé par Gmail. */
export function messageRfc822(r: Reponse): string {
  const a = (Array.isArray(r.a) ? r.a : [r.a]).map(adresseSeule);
  if (!a.length || a.some((x) => !x.includes('@'))) throw new ErreurSaisie("L'adresse du destinataire est introuvable dans ce message.");
  if (!r.texte.trim()) throw new ErreurSaisie('Écris ta réponse avant de l’envoyer.');
  const cc = (r.cc ?? []).map(adresseSeule).filter((x) => x.includes('@'));
  const entetes = [
    `To: ${a.join(', ')}`,
    cc.length ? `Cc: ${cc.join(', ')}` : '',
    r.de ? `From: ${adresseSeule(r.de)}` : '',
    `Subject: ${enteteEncode(sujetReponse(r.sujet))}`,
    r.messageId ? `In-Reply-To: ${r.messageId}` : '',
    r.messageId ? `References: ${[r.references, r.messageId].filter(Boolean).join(' ')}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ].filter((l) => l !== '');
  // La ligne vide sépare les en-têtes du texte : sans elle, le texte serait lu comme un en-tête.
  return [...entetes, '', r.texte.trim()].join('\r\n');
}

/* ---------- Nouveau mail ---------- */

const EMAIL = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;

/** Les adresses d'un champ « À » : séparées par des virgules ou des points-virgules, « Nom <adresse> » accepté. */
export function adresses(v: string | undefined): string[] {
  const liste = (v || '')
    .split(/[,;]/)
    .map((x) => adresseSeule(x))
    .filter(Boolean);
  const fausse = liste.find((x) => !EMAIL.test(x));
  if (fausse) throw new ErreurSaisie(`« ${fausse} » n'est pas une adresse email.`);
  return [...new Set(liste.map((x) => x.toLowerCase()))];
}

export type Nouveau = { a: string[]; cc?: string[]; sujet: string; texte: string };

/** Vérifie un nouveau mail avant l'envoi : au moins un destinataire, un texte, et un objet (« (sans objet) » sinon). */
export function verifierNouveau(m: Nouveau): Required<Nouveau> {
  if (!m.a.length) throw new ErreurSaisie('Indique à qui envoyer ce mail.');
  if (m.a.length + (m.cc?.length ?? 0) > 50) throw new ErreurSaisie('Cinquante destinataires au plus.');
  if (!m.texte.trim()) throw new ErreurSaisie('Écris ton message avant de l’envoyer.');
  return { a: m.a, cc: m.cc ?? [], sujet: m.sujet.trim() || '(sans objet)', texte: m.texte.trim() };
}

/** Un nouveau mail au format RFC 2822, prêt à être envoyé par Gmail. */
export function messageNouveau(m: Nouveau): string {
  const v = verifierNouveau(m);
  const entetes = [`To: ${v.a.join(', ')}`, ...(v.cc.length ? [`Cc: ${v.cc.join(', ')}`] : []), `Subject: ${enteteEncode(v.sujet)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit'];
  return [...entetes, '', v.texte].join('\r\n');
}

/** Gmail attend le message en base64 « URL safe ». */
export const base64Url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ---------- Rendez-vous ---------- */

export type Rendezvous = {
  titre: string;
  date: string;
  /** « HH:MM », ou absent pour un rendez-vous sur la journée entière. */
  debut?: string;
  fin?: string;
  lieu?: string;
  /** Jour entier : l'heure est ignorée. */
  journee?: boolean;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEURE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Ajoute des minutes à une heure « HH:MM » ; au-delà de minuit, l'heure est ramenée à 23:59 le même jour. */
export function plusMinutes(heure: string, minutes: number): string {
  const [h, m] = heure.split(':').map(Number);
  const total = h * 60 + m + minutes;
  if (total >= 24 * 60) return '23:59';
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Vérifie la saisie et complète ce qui manque : une heure de fin absente devient le début + 1 h. */
export function verifierRendezvous(r: Rendezvous): Required<Pick<Rendezvous, 'titre' | 'date' | 'journee'>> & { debut?: string; fin?: string; lieu?: string } {
  const titre = (r.titre || '').trim();
  if (!titre) throw new ErreurSaisie('Donne un titre au rendez-vous.');
  if (!DATE.test(r.date || '')) throw new ErreurSaisie('La date du rendez-vous est incomplète.');
  const lieu = r.lieu?.trim() || undefined;
  if (r.journee || !r.debut) return { titre, date: r.date, journee: true, lieu };
  if (!HEURE.test(r.debut)) throw new ErreurSaisie("L'heure de début doit s'écrire « HH:MM ».");
  const fin = r.fin && HEURE.test(r.fin) ? r.fin : plusMinutes(r.debut, 60);
  if (r.fin && !HEURE.test(r.fin)) throw new ErreurSaisie("L'heure de fin doit s'écrire « HH:MM ».");
  if (fin <= r.debut) throw new ErreurSaisie('La fin doit venir après le début.');
  return { titre, date: r.date, journee: false, debut: r.debut, fin, lieu };
}

/** Le lendemain, pour la date de fin d'un rendez-vous sur la journée (Google attend une fin exclusive). */
export function lendemain(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* ---------- Tâches ---------- */

export type TacheEcrite = { titre: string; echeance?: string | null; fait?: boolean };

export function verifierTache(t: TacheEcrite): TacheEcrite {
  const titre = (t.titre || '').trim();
  if (!titre) throw new ErreurSaisie('Donne un titre à la tâche.');
  if (t.echeance && !DATE.test(t.echeance)) throw new ErreurSaisie("L'échéance doit s'écrire « AAAA-MM-JJ ».");
  return { titre, echeance: t.echeance || null, fait: !!t.fait };
}
