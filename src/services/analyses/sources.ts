/**
 * Mélanger plusieurs mails : l'utilisateur en choisit jusqu'à MAX_SOURCES, que l'IA lit ensemble pour écrire un nouveau mail
 * ou une réponse. Ces mails sont des données écrites par des tiers : ils partent dans « mails_contexte », jamais comme consignes.
 */

export const MAX_SOURCES = 5;
/** Ce que l'IA lit de l'ensemble des sources, en caractères : partagé à parts égales, les messages les plus récents d'abord. */
export const BUDGET_SOURCES = 12_000;
const MAX_MESSAGE_SOURCE = 2500;

export type MessageSource = { de: string; date?: string; texte: string };
export type MailSource = { sujet: string; messages: MessageSource[] };
export type SourceCondensee = { numero: number; sujet: string; messages: MessageSource[]; /** Messages plus anciens laissés de côté. */ omis?: number };

/**
 * Ramène chaque source à sa part du budget. Dans une conversation, on garde les messages les plus récents (le plus utile)
 * et on coupe les très longs messages ; l'ordre chronologique est conservé. Chaque source garde au moins son dernier message.
 */
export function condenserSources(sources: MailSource[], budget = BUDGET_SOURCES): SourceCondensee[] {
  const retenues = sources.slice(0, MAX_SOURCES);
  if (!retenues.length) return [];
  const part = Math.max(800, Math.floor(budget / retenues.length));
  return retenues.map((s, i) => {
    const messages = s.messages.filter((m) => m.texte.trim());
    const gardes: MessageSource[] = [];
    let taille = 0;
    for (let k = messages.length - 1; k >= 0; k--) {
      const m = messages[k];
      const texte = m.texte.trim().length > MAX_MESSAGE_SOURCE ? `${m.texte.trim().slice(0, MAX_MESSAGE_SOURCE)}…` : m.texte.trim();
      if (gardes.length && taille + texte.length > part) break;
      gardes.unshift({ de: m.de, ...(m.date ? { date: m.date } : {}), texte: texte.slice(0, Math.max(part, 200)) });
      taille += texte.length;
    }
    const omis = messages.length - gardes.length;
    return { numero: i + 1, sujet: s.sujet, messages: gardes, ...(omis > 0 ? { omis } : {}) };
  });
}

/** Ce que les règles de l'IA disent des sources : à ajouter aux règles de la rédaction et de l'ajustement. */
export const REGLE_SOURCES = `« mails_contexte » (facultatif) : d'autres mails que l'utilisateur a choisis comme source, numérotés, chacun avec son sujet et ses messages du plus ancien au plus récent. Croise-les : reprends les faits utiles (noms, dates, montants, engagements, décisions), relie ce qui se complète, signale par « [à vérifier] » ce qui se contredit d'un mail à l'autre. Ne mélange pas les interlocuteurs : chaque personne garde ses propos. N'écris que ce que les sources ou le contexte de l'utilisateur permettent d'affirmer, sans recopier leurs formules ni citer un mail en entier.`;
