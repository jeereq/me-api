import type { GenreRessource } from './cloudinary.js';

/** 10 Mo : la limite d'une image sur l'offre gratuite de Cloudinary, et largement assez pour une photo de reçu ou une facture. */
export const TAILLE_MAX = 10 * 1024 * 1024;

/** Ce qu'on accepte comme justificatif : photos (iPhone compris) et PDF. Tous passent en « image » chez Cloudinary. */
const TYPES: Record<string, { genre: GenreRessource; sorte: 'image' | 'pdf' }> = {
  'image/jpeg': { genre: 'image', sorte: 'image' },
  'image/jpg': { genre: 'image', sorte: 'image' },
  'image/png': { genre: 'image', sorte: 'image' },
  'image/webp': { genre: 'image', sorte: 'image' },
  'image/heic': { genre: 'image', sorte: 'image' },
  'image/heif': { genre: 'image', sorte: 'image' },
  'application/pdf': { genre: 'image', sorte: 'pdf' },
};

const PAR_EXTENSION: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf' };

/** Le type du fichier : celui annoncé, sinon (« application/octet-stream » d'Android) celui de l'extension. */
export function typeFichier(type: string, nom: string) {
  const annonce = type.split(';')[0].trim().toLowerCase();
  const mime = TYPES[annonce] ? annonce : PAR_EXTENSION[/\.([a-z0-9]+)$/i.exec(nom)?.[1]?.toLowerCase() ?? ''];
  return mime ? { mime, ...TYPES[mime] } : null;
}

/** Un nom lisible et sûr pour l'affichage : sans chemin, sans caractères de contrôle, 120 caractères au plus. */
export function nomPropre(nom: string, sorte: 'image' | 'pdf') {
  // eslint-disable-next-line no-control-regex
  const n = (nom.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return n || (sorte === 'pdf' ? 'facture.pdf' : 'reçu.jpg');
}

/**
 * Vignette carrée servie par le CDN : la photo recadrée, ou la première page du PDF en JPEG.
 * `https://res.cloudinary.com/<cloud>/image/upload/v1/dossier/id.pdf` → `…/upload/c_fill,w_240,h_240,pg_1,f_jpg/v1/dossier/id.jpg`
 */
export function vignette(url: string, cote = 240) {
  if (!url.includes('/image/upload/')) return undefined;
  return url.replace('/image/upload/', `/image/upload/c_fill,w_${cote},h_${cote},pg_1,f_jpg,q_auto/`).replace(/\.(pdf|heic|heif)$/i, '.jpg');
}

/** Dossier Cloudinary : un par compte, et un par équipe pour les dépenses de son espace partagé. */
export function dossier(userId: string, equipeId?: string | null, racine = process.env.CLOUDINARY_DOSSIER?.trim() || 'me/justificatifs') {
  return `${racine.replace(/\/+$/, '')}/${equipeId ? `equipe-${equipeId}` : userId}`;
}

/** L'espace mentionne-t-il encore ce fichier ? (Un justificatif vit dans une dépense de l'espace, rangé par son identifiant.) */
export const estReference = (data: unknown, publicId: string) => data !== null && data !== undefined && JSON.stringify(data).includes(JSON.stringify(publicId));
