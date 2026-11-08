import { estFichier } from '../../utils/formulaire.js';
import { Cloudinary, configCloudinary, peutSigner, raisonCloudinary } from './cloudinary.js';

/** Une étape du test d'envoi de fichiers, pour l'admin. */
export type EtapeDiagnostic = { etape: string; ok: boolean; detail: string };

// Une image PNG de 1 × 1 pixel.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/**
 * Tout le chemin d'un fichier envoyé par l'app, sans toucher aux données de personne : lecture du formulaire par ce serveur,
 * configuration et clé Cloudinary, puis un dépôt d'essai aussitôt effacé. On s'arrête à la première étape en échec.
 */
export async function diagnosticFichiers(): Promise<{ ok: boolean; etapes: EtapeDiagnostic[] }> {
  const etapes: EtapeDiagnostic[] = [];
  const fin = () => ({ ok: etapes.every((e) => e.ok), etapes });

  // 1. Le serveur sait-il lire un formulaire avec fichier, comme celui de l'app ?
  try {
    const fd = new FormData();
    fd.append('fichier', new Blob([PIXEL], { type: 'image/png' }), 'essai.png');
    const envoi = new Response(fd);
    const lu = (await new Response(await envoi.arrayBuffer(), { headers: { 'content-type': envoi.headers.get('content-type') ?? '' } }).formData()).get('fichier');
    const ok = estFichier(lu) && lu.size === PIXEL.length;
    etapes.push({ etape: 'Lecture des fichiers reçus', ok, detail: ok ? `Node ${process.version}` : `Node ${process.version} : le fichier lu est vide ou inconnu` });
  } catch (e) {
    etapes.push({ etape: 'Lecture des fichiers reçus', ok: false, detail: `Node ${process.version} : ${(e as Error).message}` });
  }
  if (!etapes[0].ok) return fin();

  // 2. La configuration.
  const c = configCloudinary();
  if (!c) {
    etapes.push({ etape: 'Configuration Cloudinary', ok: false, detail: 'Rien de configuré : CLOUDINARY_CLOUD_NAME et CLOUDINARY_UPLOAD_PRESET (preset non signé), ou CLOUDINARY_URL (cloudinary://<clé>:<secret>@<compte>).' });
    return fin();
  }
  etapes.push(
    c.preset
      ? { etape: 'Configuration Cloudinary', ok: true, detail: `compte « ${c.cloud} », preset non signé « ${c.preset} »${peutSigner(c) ? '' : ' (sans secret : les fichiers ne seront pas supprimés de Cloudinary)'}` }
      : { etape: 'Configuration Cloudinary', ok: true, detail: `compte « ${c.cloud} », clé …${c.cle.slice(-4)} (${c.cle.length} chiffres), secret de ${c.secret.length} caractères${/^\*+$/.test(c.secret) ? ' : ce sont des étoiles, copie le vrai secret' : ''}` },
  );

  // 3. La clé, sauf avec un preset qui s'en passe.
  if (!c.preset) {
    try {
      await Cloudinary.verifier(c);
      etapes.push({ etape: 'Clé Cloudinary', ok: true, detail: 'acceptée' });
    } catch (e) {
      etapes.push({ etape: 'Clé Cloudinary', ok: false, detail: raisonCloudinary(e, true) });
      return fin();
    }
  }

  // 4. Un vrai dépôt, effacé aussitôt quand c'est possible.
  try {
    const racine = process.env.CLOUDINARY_DOSSIER?.trim() || 'me/justificatifs';
    const d = await Cloudinary.deposer(c, { contenu: new Blob([PIXEL], { type: 'image/png' }), nom: 'essai.png' }, `${racine}-diagnostic`, 'image');
    const efface = peutSigner(c) ? await Cloudinary.supprimer(c, d.publicId, 'image', d.acces).then(() => true, () => false) : false;
    // Un preset qui dépose en privé demanderait le secret pour montrer chaque fichier.
    if (c.preset && d.acces === 'authenticated' && !peutSigner(c)) etapes.push({ etape: 'Dépôt d’essai', ok: false, detail: 'Le preset dépose en privé (« authenticated ») : règle son « Delivery type » sur « upload », ou ajoute la clé et le secret.' });
    else etapes.push({ etape: 'Dépôt d’essai', ok: true, detail: efface ? 'déposé puis effacé' : 'déposé (fichier d’essai de 1 pixel resté chez Cloudinary)' });
  } catch (e) {
    etapes.push({ etape: 'Dépôt d’essai', ok: false, detail: raisonCloudinary(e, true) });
  }
  return fin();
}
