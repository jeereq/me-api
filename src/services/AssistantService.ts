import { HttpError } from '../utils/http.js';
import type { AssistantBody } from '../validators/schemas.js';
import { ConfigService } from './ConfigService.js';

const MAX_DONNEES = 60_000;
const MODELE_DEFAUT = 'gpt-4o-mini';
const OPENAI_URL = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

/** Appelle OpenAI ; une panne réseau devient une erreur lisible au lieu d'une erreur serveur. */
async function openai(path: string, init: RequestInit = {}) {
  try {
    return await fetch(`${OPENAI_URL()}${path}`, { ...init, headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json', ...init.headers } });
  } catch (e) {
    console.error('OpenAI injoignable', e);
    throw new HttpError(502, "OpenAI est injoignable pour l'instant, réessaie dans un moment.");
  }
}

// Modèles qui ne répondent pas à une conversation texte (audio, image, recherche…).
const NON_CHAT = /audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation/;

function prompt(b: AssistantBody): string {
  const donnees = String(b.donnees ?? '').slice(0, MAX_DONNEES);
  const ton = b.ton ?? 'neutre';
  if (b.type === 'plan') {
    return `Tu es « me », le copilote personnel de l'utilisateur. Il est ${b.heure ?? ''}. À partir de ses données (JSON ci-dessous), propose un plan de journée réaliste en français, ton ${ton} : d'abord les 3 priorités, puis un déroulé par créneaux qui tient compte de l'agenda, des relances dues, des tâches urgentes et des habitudes (factures en premier si elles sont dues ou en retard). 12 lignes au maximum, phrases courtes, sans markdown ni émojis.\n\nDonnées :\n${donnees}`;
  }
  if (b.type === 'relance') {
    const style = b.boite === 'pro' ? 'professionnel, vouvoiement' : 'personnel, ton amical';
    return `Rédige en français un court mail de relance (${style}) à ${b.contact ?? ''} au sujet de : ${b.sujet ?? ''}. 4 à 6 phrases, poli, avec une demande claire et une proposition de prochaine étape. Commence par une ligne « Objet : … ». Sans markdown ; termine par « [Ton prénom] ».`;
  }
  return `Tu es « me », l'assistant personnel de l'utilisateur. Réponds en français, ton ${ton}, en 2 à 5 phrases courtes faites pour être lues à voix haute : pas de listes, pas de markdown, pas d'émojis. Appuie-toi uniquement sur ses données ci-dessous (JSON) ; si l'information n'y est pas, dis-le simplement.\n\nDonnées :\n${donnees}\n\nQuestion : ${b.question ?? ''}`;
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
    const res = await openai('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: await this.modele(), max_completion_tokens: 900, messages: [{ role: 'user', content: prompt(body) }] }),
    });
    const data = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string | null } }[]; error?: { message?: string } };
    if (!res.ok) {
      console.error('OpenAI', res.status, data?.error?.message);
      throw new HttpError(502, "L'IA n'a pas pu répondre, réessaie dans un instant.");
    }
    return (data.choices?.[0]?.message?.content ?? '').trim();
  },
};
