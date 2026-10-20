import { HttpError } from '../utils/http.js';
import type { AssistantBody } from '../validators/schemas.js';
import { ConfigService } from './ConfigService.js';

const MAX_DONNEES = 60_000;

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
    if (!process.env.ANTHROPIC_API_KEY) return false;
    const cfg = await ConfigService.get();
    return (cfg.assistant as { ia?: boolean } | undefined)?.ia !== false;
  },

  async demander(body: AssistantBody): Promise<string> {
    if (!(await this.disponible())) throw new HttpError(503, "L'IA n'est pas activée sur ce serveur.");
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 900, messages: [{ role: 'user', content: prompt(body) }] }),
    });
    const data = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
    if (!res.ok) {
      console.error('Claude', res.status, data?.error?.message);
      throw new HttpError(502, "L'IA n'a pas pu répondre, réessaie dans un instant.");
    }
    return (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim();
  },
};
