/**
 * Cotisations de groupe : périodes, ce qu'un membre doit encore, et le message de demande.
 * Commun au serveur (page publique, paiement) et à l'app (suivi, WhatsApp, SMS).
 */

export type RythmeCotisation = 'unique' | 'hebdomadaire' | 'mensuel';
/** Une seule période pour une collecte unique. */
export const PERIODE_UNIQUE = 'unique';

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const JOUR_MS = 86400000;
const enDate = (jour: string) => new Date(`${jour}T00:00:00Z`);
const enJour = (d: Date) => d.toISOString().slice(0, 10);

/** Le lundi de la semaine d'un jour « AAAA-MM-JJ ». */
function lundi(jour: string) {
  const d = enDate(jour);
  return enJour(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * JOUR_MS));
}

/** La période d'un jour : « unique », « 2026-11 », ou le lundi de la semaine. */
export function periodeDuJour(rythme: RythmeCotisation, jour: string) {
  if (rythme === 'unique') return PERIODE_UNIQUE;
  return rythme === 'mensuel' ? jour.slice(0, 7) : lundi(jour);
}

/** Toutes les périodes du début à aujourd'hui, de la plus ancienne à la plus récente. */
export function periodesDepuis(rythme: RythmeCotisation, debut: string, jour: string): string[] {
  if (rythme === 'unique') return [PERIODE_UNIQUE];
  const fin = periodeDuJour(rythme, jour);
  const liste: string[] = [];
  if (rythme === 'mensuel') {
    let [a, m] = debut.slice(0, 7).split('-').map(Number);
    for (;;) {
      const p = `${a}-${String(m).padStart(2, '0')}`;
      if (p > fin) break;
      liste.push(p);
      m += 1;
      if (m > 12) {
        m = 1;
        a += 1;
      }
    }
    return liste;
  }
  for (let p = lundi(debut); p <= fin; p = enJour(new Date(enDate(p).getTime() + 7 * JOUR_MS))) liste.push(p);
  return liste;
}

/** Une période possible pour ce rythme ? */
export function periodeValide(rythme: RythmeCotisation, debut: string, jour: string, periode: string) {
  return periodesDepuis(rythme, debut, jour).includes(periode);
}

/** « novembre 2026 », « semaine du 2 novembre », ou rien pour une collecte unique. */
export function libellePeriode(periode: string) {
  if (periode === PERIODE_UNIQUE) return '';
  const [a, m, j] = periode.split('-').map(Number);
  return j ? `semaine du ${j === 1 ? '1er' : j} ${MOIS[m - 1]}` : `${MOIS[m - 1]} ${a}`;
}

/** La plus ancienne période encore à payer, ou null si le membre est à jour. */
export function premierePeriodeDue(periodes: string[], payees: Iterable<string>) {
  const faites = new Set(payees);
  return periodes.find((p) => !faites.has(p)) ?? null;
}

/** 1000 → « 10 USD », 1050 → « 10,50 USD », 5000000 → « 50 000 CDF ». */
export function montantCotisation(centimes: number, devise: string) {
  const [entier, decimales] = (centimes / 100).toFixed(2).split('.');
  const milliers = entier.replace(/\B(?=(\d{3})+$)/g, ' ');
  return `${milliers}${decimales === '00' ? '' : `,${decimales}`} ${devise}`;
}

/** « 10 USD par mois ». */
export function montantEtRythme(centimes: number, devise: string, rythme: RythmeCotisation) {
  return `${montantCotisation(centimes, devise)}${rythme === 'mensuel' ? ' par mois' : rythme === 'hebdomadaire' ? ' par semaine' : ''}`;
}

/** Le premier mot du nom : « Marie » pour « Marie Kabila ». */
export const prenomDe = (nom: string) => nom.trim().split(/\s+/)[0] ?? '';

/** Ce que l'organisateur envoie au membre. Sans lien, le paiement en ligne n'est pas ouvert. */
export function messageCotisation(c: { nom: string; titre: string; montant: number; devise: string; periode: string; lien?: string | null }) {
  const quand = libellePeriode(c.periode);
  const debut = `Bonjour ${prenomDe(c.nom)}, cotisation « ${c.titre} »${quand ? ` de ${quand}` : ''} : ${montantCotisation(c.montant, c.devise)}.`;
  return c.lien ? `${debut}\nPaie ici : ${c.lien}` : debut;
}

/** Le numéro sans « + » (243812345678), prêt pour WhatsApp. */
export const lienWhatsapp = (telephone: string, texte: string) => `https://wa.me/${telephone}?text=${encodeURIComponent(texte)}`;
export const lienSms = (telephone: string, texte: string) => `sms:+${telephone}?body=${encodeURIComponent(texte)}`;

/** Pour la page publique et les traces de paiement : 243•••••5678. */
export function numeroMasque(telephone: string) {
  return telephone.length < 8 ? '•••' : `${telephone.slice(0, 3)}•••••${telephone.slice(-4)}`;
}

/* Tontines : chaque tour, tous cotisent et un membre reçoit la cagnotte. */

export type RythmeTontine = 'quotidien' | 'hebdomadaire' | 'mensuel';
/** Commission de la plateforme : 5 %, retenus sur la cagnotte. */
export const COMMISSION_BPS = 500;

/** Pour 10 membres à 10 $ : 100 $ collectés, 5 $ de commission, 95 $ versés. Le tout en centimes. */
export function repartitionCagnotte(montant: number, membres: number, bps: number = COMMISSION_BPS) {
  const brut = montant * membres;
  const commission = Math.round((brut * bps) / 10000);
  return { brut, commission, net: brut - commission };
}

/** Les jours limites des tours : un jour, une semaine ou un mois après le précédent. Le 31 devient le dernier jour d'un mois plus court. */
export function echeancesTontine(rythme: RythmeTontine, debut: string, tours: number) {
  const d = enDate(debut);
  const jour = d.getUTCDate();
  return Array.from({ length: tours }, (_, i) => {
    const n = i + 1;
    if (rythme === 'quotidien') return enJour(new Date(d.getTime() + n * JOUR_MS));
    if (rythme === 'hebdomadaire') return enJour(new Date(d.getTime() + 7 * n * JOUR_MS));
    const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0));
    return enJour(new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth(), Math.min(jour, fin.getUTCDate()))));
  });
}

/** « 10 USD par mois », « par jour », « par semaine ». */
export function montantTontine(centimes: number, devise: string, rythme: RythmeTontine) {
  return `${montantCotisation(centimes, devise)} ${rythme === 'mensuel' ? 'par mois' : rythme === 'hebdomadaire' ? 'par semaine' : 'par jour'}`;
}
