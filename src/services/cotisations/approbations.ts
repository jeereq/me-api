import type { PrismaClient } from '@prisma/client';

import { numeroMasque, prenomDe } from '../../commun/cotisations.js';
import { chiffrer, dechiffrer } from '../../utils/crypto.js';
import { HttpError } from '../../utils/http.js';
import type { AvisGroupe } from './envois.js';

export const TAILLE_PIECE_MAX = 5 * 1024 * 1024;

export type DepsApprobations = {
  db: Pick<PrismaClient, 'approbationCompte' | 'user'>;
  avertir(userId: string, telephone: string | null, avis: AvisGroupe): Promise<unknown>;
  maintenant?: () => number;
};

/** Le vrai type du fichier, d'après ses premiers octets : le nom et le type annoncés ne prouvent rien. */
export function typeImage(o: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return 'image/jpeg';
  if (o[0] === 0x89 && o[1] === 0x50 && o[2] === 0x4e && o[3] === 0x47) return 'image/png';
  if (String.fromCharCode(...o.slice(0, 4)) === 'RIFF' && String.fromCharCode(...o.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export function creerApprobations(d: DepsApprobations) {
  const maintenant = () => d.maintenant?.() ?? Date.now();
  return {
    async comptesApprouves(ids: string[]) {
      if (!ids.length) return new Set<string>();
      const lignes = await d.db.approbationCompte.findMany({ where: { userId: { in: [...new Set(ids)] }, statut: 'approuvee' }, select: { userId: true } });
      return new Set(lignes.map((l) => l.userId));
    },

    async etat(userId: string) {
      const [u, a] = await Promise.all([d.db.user.findUniqueOrThrow({ where: { id: userId }, select: { telephone: true } }), d.db.approbationCompte.findUnique({ where: { userId }, select: { statut: true, motif: true } })]);
      return { statut: a?.statut ?? 'aucune', motif: a?.motif ?? null, telephone: u.telephone ? numeroMasque(u.telephone) : null };
    },

    /** La photo est chiffrée avant d'entrer en base, et n'y reste que jusqu'à la décision. */
    async soumettre(userId: string, octets: Uint8Array) {
      const u = await d.db.user.findUniqueOrThrow({ where: { id: userId }, select: { telephone: true } });
      if (!u.telephone) throw new HttpError(409, 'Confirme d’abord ton numéro par SMS.');
      const existante = await d.db.approbationCompte.findUnique({ where: { userId }, select: { statut: true } });
      if (existante?.statut === 'approuvee') throw new HttpError(409, 'Ton compte est déjà approuvé.');
      if (octets.length > TAILLE_PIECE_MAX) throw new HttpError(413, 'Photo trop lourde : 5 Mo au plus.', 'TROP_LOURD');
      const type = typeImage(octets);
      if (!type) throw new HttpError(400, 'Envoie une photo JPEG, PNG ou WebP de ta pièce d’identité.');
      const piece = chiffrer(`${type};${Buffer.from(octets).toString('base64')}`);
      await d.db.approbationCompte.upsert({ where: { userId }, create: { userId, piece }, update: { piece, statut: 'soumise', motif: null, decideParNom: null, decideLe: null } });
      return this.etat(userId);
    },

    /** Pour l'admin. Sans la photo : elle ne s'ouvre qu'à la demande. */
    async aTraiter() {
      const lignes = await d.db.approbationCompte.findMany({
        where: { statut: { in: ['soumise', 'approuvee'] } },
        orderBy: { updatedAt: 'desc' },
        take: 200,
        select: { userId: true, statut: true, createdAt: true, user: { select: { nom: true, telephone: true, email: true } } },
      });
      return { approbations: lignes.map((l) => ({ userId: l.userId, statut: l.statut, demandeLe: l.createdAt, nom: l.user.nom, telephone: l.user.telephone, email: l.user.email })) };
    },

    async piece(userId: string) {
      const a = await d.db.approbationCompte.findUnique({ where: { userId }, select: { piece: true } });
      if (!a?.piece) throw new HttpError(404, 'Aucune photo.');
      const [type, base64] = dechiffrer(a.piece).split(';');
      return { type, base64 };
    },

    /** La décision efface la photo. Un compte déjà approuvé peut perdre son approbation. */
    async decider(adminNom: string, userId: string, approuve: boolean, motif?: string) {
      const a = await d.db.approbationCompte.findUnique({ where: { userId }, select: { statut: true } });
      if (!a) throw new HttpError(404, 'Demande introuvable.');
      if (!approuve && !motif) throw new HttpError(400, 'Indique le motif du refus.');
      const decideLe = new Date(maintenant());
      await d.db.approbationCompte.update({ where: { userId }, data: { statut: approuve ? 'approuvee' : 'refusee', motif: approuve ? null : motif, piece: null, decideParNom: adminNom, decideLe } });
      const u = await d.db.user.findUnique({ where: { id: userId }, select: { telephone: true, nom: true } });
      await Promise.resolve(
        d.avertir(userId, u?.telephone ?? null, approuve ? { cle: `approbation:${decideLe.getTime()}`, titre: 'Compte approuvé', corps: `${prenomDe(u?.nom ?? '')}, tu peux utiliser l’annuaire des cotisations.`.trim() } : { cle: `approbation:${decideLe.getTime()}`, titre: 'Compte non approuvé', corps: motif ?? '' }),
      ).catch((e) => console.error('Avis d’approbation', e));
      return this.aTraiter();
    },
  };
}
