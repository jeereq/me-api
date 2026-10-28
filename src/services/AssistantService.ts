import { HttpError } from '../utils/http.js';
import type { AssistantBody } from '../validators/schemas.js';
import { MODELE_DEFAUT, modeleIndisponible, modelesAEssayer } from './assistant-modele.js';
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
/** Les réponses du copilote et de l'analyse des mails sont du JSON que l'app range en cases à cocher : plus longues, et forcées en JSON. */
export const enJson = (type: AssistantBody['type']) => type === 'copilote' || type === 'mails' || type === 'lot';
/** Un lot de mails (jusqu'à 50) demande une synthèse et une analyse par mail : la plus longue des réponses. */
export function corpsRequete(modele: string, contenu: string, json = false, long = false) {
  const r = raisonne(modele);
  return {
    model: modele,
    max_completion_tokens: r ? (long ? 16000 : json ? 8000 : 6000) : long ? 8000 : json ? 2500 : 900,
    ...(r ? { reasoning_effort: 'low' } : {}),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    messages: [{ role: 'user', content: contenu }],
  };
}

// Modèles qui ne répondent pas à une conversation texte (audio, image, recherche…).
const NON_CHAT = /audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation/;

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
  if (b.type === 'mails') {
    return `Tu es « Me », le copilote de l'utilisateur. Analyse ses mails (JSON ci-dessous : id, de, sujet, boite perso ou pro, texte) et réponds uniquement par un objet JSON de la forme {"analyses": [{"id": "…", "resume": "…", "urgence": "haute|normale|basse", "action": "repondre|tache|rien", "reponse": "…", "tache": "…"}]}, une entrée par mail, avec le même id.
« resume » : ce que veut l'expéditeur, en une phrase. « action » : « repondre » si le mail attend une réponse, « tache » s'il demande surtout un travail, « rien » pour une lettre d'information, une publicité ou une notification automatique. « reponse » : une réponse prête à envoyer, en français, ${ton === 'neutre' ? '' : `ton ${ton}, `}vouvoiement pour une boîte pro et ton amical pour une boîte perso, 3 à 6 phrases, qui répond vraiment à la demande sans inventer de fait, de date ni de prix (propose plutôt d'en convenir) ; sans objet, sans markdown, terminée par « [Ton prénom] » ; chaîne vide quand l'action est « rien ». « tache » : le travail à faire, commençant par un verbe, ou chaîne vide.

Mails :
${donnees}`;
  }
  if (b.type === 'lot') {
    return `Tu es « Me », le copilote de l'utilisateur. Il te confie un lot de mails à analyser ensemble : ${b.perimetre || 'des mails choisis'}. Les mails sont dans le JSON ci-dessous (id, de, adresse, date, sujet, boite perso ou pro, texte ; le texte est parfois seulement le début du mail). Réponds uniquement par un objet JSON de la forme {"synthese": "…", "points": ["…"], "actions": [{"titre": "…", "priorite": "haute|moyenne|basse", "echeance": "AAAA-MM-JJ ou null", "raison": "…"}], "analyses": [{"id": "…", "resume": "…", "urgence": "haute|normale|basse", "action": "repondre|tache|rien", "reponse": "…", "tache": "…"}]}.
« synthese » : 3 à 6 phrases, en français${ton === 'neutre' ? '' : `, ton ${ton}`}, qui disent de quoi parle ce lot dans son ensemble : les sujets récurrents, ce qui a changé dans le temps, ce qui reste en suspens, les montants, échéances ou engagements qui reviennent ; sans markdown. « points » : de 2 à 6 constats courts et concrets (« 3 factures OVH impayées depuis septembre »). « actions » : de 1 à 8 actions concrètes pour l'utilisateur, chacune commençant par un verbe, que l'app pourra convertir en tâches ; « echeance » seulement si les mails la justifient. « analyses » : une entrée par mail avec le même id, comme pour une analyse mail par mail ; « reponse » est une réponse prête à envoyer (vouvoiement pour une boîte pro, ton amical pour une boîte perso, 2 à 5 phrases, sans inventer de fait, de date ni de prix, terminée par « [Ton prénom] ») seulement pour les mails qui attendent vraiment une réponse, sinon chaîne vide. Ne cite que ce qui est dans les mails.

Mails :
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
    for (const [i, m] of candidats.entries()) {
      modele = m;
      const res = await openai('/chat/completions', { method: 'POST', body: JSON.stringify(corpsRequete(m, prompt(body), enJson(body.type), body.type === 'lot')) });
      data = (await res.json().catch(() => ({}))) as Reponse;
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
