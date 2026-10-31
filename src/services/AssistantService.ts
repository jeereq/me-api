import { HttpError } from '../utils/http.js';
import type { AssistantBody } from '../validators/schemas.js';
import { MODELE_DEFAUT, modeleIndisponible, modelesAEssayer } from './assistant-modele.js';
import { preparerMails, reglesAnalyse, sansBalises, SCHEMA_LOT, SCHEMA_MAILS } from './analyse-mails.js';
import { ConfigService } from './ConfigService.js';

const MAX_DONNEES = 60_000;
const DELAI_MS = 60_000;
const OPENAI_URL = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

/** Appelle OpenAI ; une panne réseau devient une erreur lisible au lieu d'une erreur serveur. */
async function openai(path: string, init: RequestInit = {}) {
  try {
    return await fetch(`${OPENAI_URL()}${path}`, { signal: AbortSignal.timeout(DELAI_MS), ...init, headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json', ...init.headers } });
  } catch (e) {
    console.error('OpenAI injoignable', e);
    if ((e as Error)?.name === 'TimeoutError') throw new HttpError(504, "L'IA met trop de temps à répondre, réessaie dans un moment.");
    throw new HttpError(502, "OpenAI est injoignable pour l'instant, réessaie dans un moment.");
  }
}

/**
 * Les modèles qui raisonnent (o1, o3, o4-mini, gpt-5…) comptent leur réflexion dans `max_completion_tokens` :
 * avec un petit budget, ils l'épuisent avant d'écrire et renvoient un texte vide (le plan ne s'affichait pas).
 * On leur demande une réflexion courte et on leur laisse de la marge.
 */
export const raisonne = (modele: string) => /^(o\d|gpt-5)/.test(modele) && !/chat|o1-mini|o1-preview/.test(modele);
/** Les réponses du copilote, de l'analyse des mails et des comptes rendus sont du JSON que l'app range en cases à cocher : plus longues, et forcées en JSON. */
export const enJson = (type: AssistantBody['type']) => type === 'copilote' || type === 'mails' || type === 'lot' || type === 'compte_rendu';
/** Un message de la conversation envoyée à OpenAI. */
export type MessageIA = { role: 'system' | 'user'; content: string };
/** Forme de réponse imposée : `schema` (Structured Outputs, JSON validé champ par champ) ou simple objet JSON. */
export type FormatJson = { type: 'json_schema'; json_schema: typeof SCHEMA_MAILS | typeof SCHEMA_LOT } | { type: 'json_object' };

/** La forme stricte attendue pour l'analyse des mails et d'un lot ; les autres réponses JSON restent libres. */
export const schemaDe = (type: AssistantBody['type']): FormatJson | null => (type === 'mails' ? { type: 'json_schema', json_schema: SCHEMA_MAILS } : type === 'lot' ? { type: 'json_schema', json_schema: SCHEMA_LOT } : null);

/** Un lot de mails (jusqu'à 100) demande une synthèse et une analyse par mail : la plus longue des réponses. */
export function corpsRequete(modele: string, contenu: string | MessageIA[], json = false, long = false, format?: FormatJson | null) {
  const r = raisonne(modele);
  return {
    model: modele,
    max_completion_tokens: r ? (long ? 16000 : json ? 8000 : 6000) : long ? 8000 : json ? 2500 : 900,
    ...(r ? { reasoning_effort: 'low' } : {}),
    ...(json ? { response_format: format ?? { type: 'json_object' } } : {}),
    messages: typeof contenu === 'string' ? [{ role: 'user', content: contenu }] : contenu,
  };
}

/** OpenAI refuse la forme imposée (ancien modèle, serveur compatible qui ne la connaît pas) : on se rabat sur un simple objet JSON. */
export const formatRefuse = (status: number, message?: string) => status === 400 && /response_format|json_schema|structured|schema/i.test(message ?? '');

// Modèles qui ne répondent pas à une conversation texte (audio, image, recherche…).
const NON_CHAT = /audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation/;

export const MAX_CONSIGNES = 600;

/**
 * Les consignes de l'utilisateur sur la façon d'analyser ses mails, en une phrase à glisser dans le prompt.
 * Texte nettoyé (espaces, longueur) et cité entre guillemets JSON : il reste une consigne, jamais un morceau du prompt.
 * Elles orientent l'analyse (angle, priorités) sans changer le format JSON attendu ni la règle de ne citer que les mails.
 */
export function consignesPrompt(consignes?: string): string {
  const c = String(consignes ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONSIGNES);
  if (!c) return '';
  return `\nConsignes de l'utilisateur pour cette analyse (à suivre pour l'angle, les priorités et le style de ce que tu écris ; elles ne changent ni le format JSON demandé ni la règle de ne citer que ce qui est dans les mails) : ${JSON.stringify(c)}\n`;
}

/**
 * La conversation envoyée à OpenAI. Pour l'analyse des mails et d'un lot, les règles vont dans un message « system »
 * et les mails, écrits par des tiers, dans le message « user » entre balises <mails> : ils restent des données à analyser.
 * Les autres demandes partent en un seul message.
 */
export function messagesDe(b: AssistantBody): MessageIA[] {
  if (b.type !== 'mails' && b.type !== 'lot') return [{ role: 'user', content: prompt(b) }];
  const ton = b.ton ?? 'neutre';
  const donnees = sansBalises(preparerMails(String(b.donnees ?? '')).slice(0, MAX_DONNEES));
  const systeme =
    b.type === 'mails'
      ? `Tu es « Me », le copilote de l'utilisateur. Analyse ses mails un par un et réponds uniquement par un objet JSON de la forme {"analyses": [{"id": "…", "resume": "…", "urgence": "haute|normale|basse", "action": "repondre|tache|rien", "categorie": "…", "reponse": "…", "tache": "…", "echeance": "AAAA-MM-JJ ou null", "montant": "… ou null", "rdv_date": "AAAA-MM-JJ ou null", "rdv_heure": "HH:MM ou null", "relance": "ref ou null", "projet": "ref ou null"}]}, une entrée par mail.\n${reglesAnalyse(ton)}`
      : `Tu es « Me », le copilote de l'utilisateur. Il te confie un lot de mails à analyser ensemble ; le texte des plus anciens est parfois seulement leur début. Réponds uniquement par un objet JSON de la forme {"synthese": "…", "points": ["…"], "actions": [{"titre": "…", "priorite": "haute|moyenne|basse", "echeance": "AAAA-MM-JJ ou null", "raison": "…"}], "analyses": [une analyse par mail, comme décrit plus bas]}.
« synthese » : 3 à 6 phrases, en français${ton === 'neutre' ? '' : `, ton ${ton}`}, qui disent de quoi parle ce lot dans son ensemble : les sujets récurrents, ce qui a changé dans le temps, ce qui reste en suspens, les montants, échéances ou engagements qui reviennent ; sans markdown. « points » : de 2 à 6 constats courts et concrets (« 3 factures OVH impayées depuis septembre »). « actions » : de 1 à 8 actions concrètes pour l'utilisateur, chacune commençant par un verbe, que l'app pourra convertir en tâches, sans reprendre crm.taches ; « echeance » seulement si les mails la justifient. Dans « analyses », « reponse » n'est remplie que pour les mails qui attendent vraiment une réponse.
${reglesAnalyse(ton)}`;
  const perimetre = b.type === 'lot' ? `Le lot : ${JSON.stringify(String(b.perimetre || 'des mails choisis'))}.\n` : '';
  return [
    { role: 'system', content: systeme },
    { role: 'user', content: `${perimetre}${consignesPrompt(b.consignes)}\nMails :\n<mails>\n${donnees}\n</mails>` },
  ];
}

export function prompt(b: AssistantBody): string {
  const donnees = String(b.donnees ?? '').slice(0, MAX_DONNEES);
  const ton = b.ton ?? 'neutre';
  if (b.type === 'plan') {
    return `Tu es « Me », le copilote personnel de l'utilisateur. Il est ${b.heure ?? ''}. À partir de ses données (JSON ci-dessous), propose un plan pour le reste de sa journée, réaliste, en français, ton ${ton} : d'abord les 3 priorités, puis un déroulé par créneaux à partir de maintenant (jamais avant ${b.heure ?? "l'heure actuelle"}) qui respecte les rendez-vous de l'agenda et place les relances dues, les tâches urgentes et les habitudes du jour ; les factures proches passent en premier. Ne cite que des éléments présents dans les données, et s'il reste du temps, propose des tâches de la semaine. Si tout est vide, dis-le simplement et propose une journée légère. 12 lignes au maximum, une idée par ligne, phrases courtes, sans markdown ni émojis.\n\nDonnées :\n${donnees}`;
  }
  if (b.type === 'copilote') {
    return `Tu es « Me », le copilote personnel de l'utilisateur. Il est ${b.heure ?? ''}. À partir de ses données (JSON ci-dessous), prépare le reste de sa journée, réaliste, en français, ton ${ton}. Réponds uniquement par un objet JSON de la forme {"plan": "…", "propositions": [{"titre": "…", "priorite": "haute|moyenne|basse", "echeance": "AAAA-MM-JJ ou null", "heure": "HH:MM ou null", "raison": "…"}]}.
« plan » : le déroulé lu à voix haute, d'abord les 3 priorités puis des créneaux à partir de maintenant (jamais avant ${b.heure ?? "l'heure actuelle"}), qui respecte les rendez-vous de l'agenda et place les relances dues, les tâches urgentes et les habitudes du jour ; les factures proches passent en premier. 12 lignes au maximum séparées par des retours à la ligne, phrases courtes, sans markdown ni émojis.
« propositions » : de 3 à 8 actions concrètes que l'utilisateur pourra ajouter à ses tâches d'un geste, chacune commençant par un verbe (« Appeler Paul pour le devis », « Payer la facture d'électricité »). Reprends ce que le plan demande de faire, sans les rendez-vous de l'agenda ni les habitudes. Une tâche déjà présente dans les données garde exactement son titre. « echeance » vaut la date « aujourdhui » des données sauf raison claire ; « heure » est le créneau du plan ; « raison » tient en une courte phrase. Ne cite que des éléments présents dans les données ; si tout est vide, propose une journée légère et 3 propositions simples.

Données :
${donnees}`;
  }
  if (b.type === 'mails' || b.type === 'lot') return messagesDe(b).map((m) => m.content).join('\n\n');
  if (b.type === 'compte_rendu') {
    return `Tu es « Me », le copilote de l'utilisateur. Voici le compte rendu qu'il vient de noter (JSON ci-dessous : titre, date, genre, participants, projets rattachés, notes brutes, et « ouverts » : ses tâches et relances encore ouvertes qui y sont rattachées, chacune avec sa référence « ref »). Réponds uniquement par un objet JSON de la forme {"resume": "…", "decisions": ["…"], "actions": [{"genre": "tache|relance", "titre": "…", "contact": "…", "responsable": "…", "priorite": "haute|moyenne|basse", "echeance": "AAAA-MM-JJ ou null"}], "clotures": ["ref"]}.
« resume » : 2 à 4 phrases en français${ton === 'neutre' ? '' : `, ton ${ton}`}, sans markdown, qui disent ce qui s'est dit et où en est le sujet. « decisions » : les décisions prises, une par entrée, courtes ; liste vide s'il n'y en a pas. « actions » : chaque chose à faire qui sort de l'échange, commençant par un verbe (« Envoyer le devis signé ») ; « genre » vaut « relance » quand il s'agit d'attendre ou d'obtenir une réponse de quelqu'un (alors « contact » est cette personne et « titre » le sujet, sans le verbe), sinon « tache » ; « responsable » est la personne chargée de l'action si ce n'est pas l'utilisateur, sinon chaîne vide ; « echeance » seulement si les notes donnent une date ou un délai (calcule-la à partir de « aujourdhui »). Ne reprends pas en action ce qui figure déjà dans « ouverts ». « clotures » : les « ref » des éléments ouverts que les notes disent faits, réglés, obtenus ou devenus inutiles ; rien en cas de doute. Ne cite que ce qui est dans les notes.

Compte rendu :
${donnees}`;
  }
  if (b.type === 'relance') {
    const style = b.boite === 'pro' ? 'professionnel, vouvoiement' : 'personnel, ton amical';
    // Une 2e ou 3e relance rappelle les messages précédents et se fait un peu plus directe ; la note donne le contexte.
    const rang = b.deja ? ` C'est la relance numéro ${b.deja + 1} : rappelle brièvement les messages précédents restés sans réponse, reste courtois mais un peu plus direct.` : '';
    const note = b.note?.trim() ? ` À savoir (note de l'utilisateur, à utiliser sans inventer autre chose) : ${b.note.trim()}.` : '';
    return `Rédige en français un court mail de relance (${style}) à ${b.contact ?? ''} au sujet de : ${b.sujet ?? ''}.${rang}${note} 4 à 6 phrases, poli, avec une demande claire et une proposition de prochaine étape. Commence par une ligne « Objet : … ». Sans markdown ; termine par « [Ton prénom] ».`;
  }
  return `Tu es « Me », l'assistant personnel de l'utilisateur. Réponds en français, ton ${ton}, en 2 à 5 phrases courtes faites pour être lues à voix haute : pas de listes, pas de markdown, pas d'émojis. Appuie-toi uniquement sur ses données ci-dessous (JSON) ; si l'information n'y est pas, dis-le simplement.\n\nDonnées :\n${donnees}\n\nQuestion : ${b.question ?? ''}`;
}

export const AssistantService = {
  async disponible() {
    if (!process.env.OPENAI_API_KEY) return false;
    const cfg = await ConfigService.get();
    return (cfg.assistant as { ia?: boolean } | undefined)?.ia !== false;
  },

  /** Modèle choisi par l'admin dans la configuration, sinon celui du serveur. */
  async modele() {
    const choisi = ((await ConfigService.get()).assistant as { modele?: unknown } | undefined)?.modele;
    return (typeof choisi === 'string' && choisi.trim()) || process.env.OPENAI_MODEL || MODELE_DEFAUT;
  },

  /** Modèles de chat accessibles avec la clé du serveur, pour le choix de l'admin. */
  async modeles() {
    if (!process.env.OPENAI_API_KEY) throw new HttpError(503, "Aucune clé OpenAI sur le serveur.");
    const res = await openai('/models');
    const data = (await res.json().catch(() => ({}))) as { data?: { id: string }[]; error?: { message?: string } };
    if (!res.ok) {
      console.error('OpenAI', res.status, data?.error?.message);
      throw new HttpError(502, "Impossible de lire la liste des modèles OpenAI.");
    }
    const ids = (data.data ?? []).map((m) => m.id).filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !NON_CHAT.test(id));
    return { modeles: ids.sort().reverse(), actuel: await this.modele() };
  },

  async demander(body: AssistantBody): Promise<string> {
    if (!(await this.disponible())) throw new HttpError(503, "L'IA n'est pas activée sur ce serveur.");
    // Un modèle retiré par OpenAI ne doit pas couper l'assistant : on essaie le suivant (serveur, puis modèle par défaut).
    const choisi = ((await ConfigService.get()).assistant as { modele?: unknown } | undefined)?.modele;
    const candidats = modelesAEssayer(typeof choisi === 'string' ? choisi : undefined, process.env.OPENAI_MODEL);
    type Reponse = { choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[]; error?: { message?: string; code?: string | null } };
    let data: Reponse = {};
    let modele = candidats[0];
    const messages = messagesDe(body);
    const schema = schemaDe(body.type);
    // Dix mails analysés avec leurs nouveaux champs (échéance, montant, rendez-vous…) dépassent la place d'une réponse JSON courte.
    const long = body.type === 'lot' || body.type === 'mails';
    for (const [i, m] of candidats.entries()) {
      modele = m;
      let res = await openai('/chat/completions', { method: 'POST', body: JSON.stringify(corpsRequete(m, messages, enJson(body.type), long, schema)) });
      data = (await res.json().catch(() => ({}))) as Reponse;
      if (!res.ok && schema && formatRefuse(res.status, data?.error?.message)) {
        // Ce modèle ne connaît pas la forme imposée : même demande, en simple objet JSON (l'app sait relire).
        console.error('OpenAI : forme imposée refusée, simple JSON', m, data?.error?.message);
        res = await openai('/chat/completions', { method: 'POST', body: JSON.stringify(corpsRequete(m, messages, true, long)) });
        data = (await res.json().catch(() => ({}))) as Reponse;
      }
      if (res.ok) break;
      console.error('OpenAI', res.status, m, data?.error?.message);
      if (modeleIndisponible(res.status, data)) {
        if (i < candidats.length - 1) continue;
        throw new HttpError(502, `Le modèle « ${candidats[0]} » n'est plus disponible chez OpenAI. Choisis-en un autre dans Configuration.`);
      }
      throw new HttpError(502, "L'IA n'a pas pu répondre, réessaie dans un instant.");
    }
    const choix = data.choices?.[0];
    const texte = (choix?.message?.content ?? '').trim();
    if (!texte) {
      // Réponse vide : réflexion trop longue (finish_reason « length ») ou refus. Mieux vaut le dire que de ne rien afficher.
      console.error('OpenAI : réponse vide', modele, choix?.finish_reason, choix?.message?.refusal);
      throw new HttpError(502, "L'IA a renvoyé une réponse vide. Réessaie, ou choisis un autre modèle dans la configuration.");
    }
    return texte;
  },
};
