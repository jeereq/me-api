import { jour, json, local, passe } from './http.js';
import { vide, type Connecteur, type Elements } from './types.js';

const API = 'https://api.trello.com/1';
const cle = () => process.env.TRELLO_API_KEY || '';
const q = (token: string, extra: Record<string, string> = {}) => new URLSearchParams({ key: cle(), token, ...extra });

type Carte = { id: string; name: string; due: string | null; dueComplete: boolean; idBoard: string; url: string };

/**
 * Trello n'a pas d'OAuth 2 : la page d'autorisation renvoie le jeton dans le fragment de l'URL de retour.
 * Une petite page du serveur (route /trello/retour) le lit et le transmet ; `echanger` reçoit donc directement le jeton.
 */
export const trello: Connecteur = {
  fournisseur: 'TRELLO',
  nom: 'Trello',
  sources: ['trello'],
  ctx: 'pro',
  configure: () => !!(cle() && process.env.PUBLIC_URL),

  urlAutorisation: (state) =>
    `https://trello.com/1/authorize?${new URLSearchParams({
      key: cle(),
      name: 'me',
      scope: 'read',
      expiration: 'never',
      response_type: 'token',
      callback_method: 'fragment',
      return_url: `${(process.env.PUBLIC_URL || '').replace(/\/+$/, '')}/api/integrations/trello/retour?state=${encodeURIComponent(state)}`,
    })}`,

  async echanger(token) {
    const moi = await json<{ fullName?: string; username?: string }>('Trello', `${API}/members/me?${q(token, { fields: 'fullName,username' })}`);
    return { accessToken: token, compte: moi.username ? `@${moi.username}` : moi.fullName || 'Compte Trello' };
  },

  async importer({ jetons, fuseau, prefs }) {
    const out: Elements = vide();
    const p = prefs('trello');
    if (!p.actif) return out;
    const [boards, cartes] = await Promise.all([
      json<{ id: string; name: string }[]>('Trello', `${API}/members/me/boards?${q(jetons.accessToken, { filter: 'open', fields: 'name' })}`),
      json<Carte[]>('Trello', `${API}/members/me/cards?${q(jetons.accessToken, { filter: 'open', fields: 'name,due,dueComplete,idBoard,url' })}`),
    ]);
    const nomBoard = new Map(boards.map((b) => [b.id, b.name]));
    const limite = jour(14, fuseau);
    for (const c of cartes) {
      if (c.dueComplete || !passe(p.filtre, nomBoard.get(c.idBoard))) continue;
      const titre = `${c.name} · ${nomBoard.get(c.idBoard) || 'Trello'}`;
      const echeance = c.due ? local(c.due, fuseau) : null;
      if (p.imports.includes('taches')) out.taches.push({ id: c.id, titre, echeance: echeance?.date ?? null, source: 'trello', lien: c.url });
      if (p.imports.includes('agenda') && echeance && echeance.date >= jour(0, fuseau) && echeance.date <= limite) {
        out.agenda.push({ id: c.id, date: echeance.date, debut: echeance.heure, titre: `Échéance : ${titre}`, source: 'trello', lien: c.url });
      }
    }
    return out;
  },
};
