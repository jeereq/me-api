/** Le message du formulaire de contact, prêt à partir par email. Module pur, testé dans tests/contact.test.ts. */

export type MessageContact = { nom: string; email: string; telephone?: string; message: string };

const echapper = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** L'adresse qui reçoit les messages. */
export const adresseContact = (env: Record<string, string | undefined> = process.env) => env.CONTACT_EMAIL?.trim() || 'mingandajeereq@gmail.com';

export function emailContact(m: MessageContact) {
  // Une seule ligne dans l'objet : un retour à la ligne ne doit pas pouvoir y entrer.
  const nom = m.nom.replace(/\s+/g, ' ').trim();
  const lignes = [`De : ${nom} <${m.email}>`, ...(m.telephone ? [`Téléphone : ${m.telephone}`] : []), '', m.message];
  const html =
    `<p><strong>${echapper(nom)}</strong> &lt;${echapper(m.email)}&gt;${m.telephone ? `<br>Téléphone : ${echapper(m.telephone)}` : ''}</p>` +
    `<p style="white-space:pre-wrap">${echapper(m.message)}</p>`;
  return { sujet: `Contact Me : ${nom}`.slice(0, 120), texte: lignes.join('\n'), html };
}
