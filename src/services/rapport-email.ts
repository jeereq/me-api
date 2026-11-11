import { periodeCourte, type Rapport, resumeRapport, somme as montant } from '../commun/rapport.js';
import { composerSms, phrase, preparerTexte } from './sms/asmsc.js';

const echapper = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const TON = { alerte: '#FF6474', conseil: '#FFCB5C', bravo: '#3EF0B0' } as const;
export const PIED_RAPPORT = 'Tu reçois ce rapport parce que tu as un abonnement Me. Tu peux le couper ou changer son heure dans Finances › Réglages.';

/** Le SMS d'un rapport : le total d'abord, puis les conseils qui tiennent, et le lien s'il tient en entier. */
export function smsRapport(r: Rapport, lien?: string | null): string {
  const quand = periodeCourte(r.periode, r.debut);
  const tete = r.nombre
    ? `Dépenses ${quand} : ${montant(r.depenses, r.devise)} (${r.nombre} dépense${r.nombre > 1 ? 's' : ''}).`
    : `Aucune dépense notée ${quand === r.debut.slice(0, 4) ? `en ${quand}` : quand}.`;
  return composerSms([tete, ...r.conseils.map((c) => c.court)], lien);
}

/** Le rapport du soir en SMS long : au plus ce nombre de SMS facturés. */
export const SEGMENTS_RAPPORT = 3;

/** Un nom sans emoji (un seul emoji ferait passer tout le SMS en Unicode, deux fois plus cher). */
const sansEmoji = (t: string) => t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, '').replace(/\s+/g, ' ').trim();

/**
 * Le rapport du soir par SMS, comme l'email : bonjour, le total et l'habitude, les conseils, où est parti l'argent, les
 * budgets, puis le lien. Un SMS long (jusqu'à SEGMENTS_RAPPORT SMS facturés), sans emoji. Si tout ne tient pas, les
 * dernières lignes (budgets, puis catégories, puis conseils) tombent entières, le lien reste : jamais une ligne coupée au milieu.
 */
export function smsRapportComplet(r: Rapport, nom?: string | null, lien?: string | null): string {
  const m = (n: number) => montant(n, r.devise);
  const prenom = nom ? sansEmoji(nom).split(' ')[0] : '';
  const tete = [`Me. ${prenom ? `Bonjour ${prenom},` : 'Bonjour,'}`, `${r.titre} : ${r.nombre ? `${m(r.depenses)}.` : 'aucune dépense notée.'}`];
  if (r.nombre) tete.push(`${r.nombre} dépense${r.nombre > 1 ? 's' : ''}${r.habitude ? ` (d'habitude ${m(r.habitude)})` : ''}.`);
  if (r.revenus > 0) tete.push(`Reçu : ${m(r.revenus)}.`);
  const sections: [string, string[]][] = [
    ['Conseils :', r.conseils.slice(0, 1).map((c) => `- ${phrase(c.texte)}`)],
    ["Où est parti l'argent :", r.categories.slice(0, 3).map((c) => `- ${sansEmoji(c.nom)} : ${m(c.montant)}`)],
    ['Budgets :', r.budgets.slice(0, 3).map((b) => `- ${sansEmoji(b.nom)} : ${m(b.depense)} / ${m(b.plafond)}${b.depasse ? ' (dépassé)' : ''}`)],
  ];
  // La place du lien est gardée d'avance : il ne tombe jamais au profit d'une ligne de plus.
  const fin = lien ? `\n\n${lien}` : '';
  const tient = (t: string) => !preparerTexte(`${t}${fin}`, { segments: SEGMENTS_RAPPORT }).coupe;
  let texte = tete.join('\n');
  for (const [titre, lignes] of sections) {
    let bloc = '';
    for (const l of lignes) {
      if (!tient(`${texte}\n\n${titre}\n${bloc ? `${bloc}\n` : ''}${l}`)) break;
      bloc = bloc ? `${bloc}\n${l}` : l;
    }
    if (bloc) texte = `${texte}\n\n${titre}\n${bloc}`;
  }
  return `${texte}${fin}`;
}

/** La notification d'un rapport : le total, puis le conseil le plus utile. */
export const avisRapport = (r: Rapport) => ({ titre: r.titre, corps: [resumeRapport(r), r.conseils[0]?.texte].filter(Boolean).join(' ') });

/** L'email du soir : un ou plusieurs rapports (le jour, et la semaine ou le mois qui finit ce soir). */
export function emailRapport(rapports: Rapport[], nom: string, lien?: string) {
  const r0 = rapports[0];
  const sujet = rapports.length === 1 ? `${r0.titre} : ${r0.nombre ? montant(r0.depenses, r0.devise) : 'rien de noté'}` : `${r0.titre} et ${rapports.length - 1 === 1 ? rapports[1].titre.replace(/^Tes dépenses /, '') : 'plus'}`;
  const m = (r: Rapport, n: number) => montant(n, r.devise);

  const texte =
    `${nom ? `Bonjour ${nom},\n\n` : ''}` +
    rapports
      .map((r) => {
        const cats = r.categories.slice(0, 3).map((c) => `  - ${c.nom} : ${m(r, c.montant)} (${c.part} %)`);
        const budgets = r.budgets.slice(0, 4).map((b) => `  - ${b.nom} : ${m(r, b.depense)} sur ${m(r, b.plafond)}${b.depasse ? ' (dépassé)' : ''}`);
        return [
          r.titre.toUpperCase(),
          resumeRapport(r),
          r.revenus > 0 ? `Reçu : ${m(r, r.revenus)}.` : '',
          cats.length ? `Où est parti l'argent :\n${cats.join('\n')}` : '',
          budgets.length ? `Budgets :\n${budgets.join('\n')}` : '',
          r.conseils.length ? `Conseils :\n${r.conseils.map((c) => `  - ${c.texte}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n') +
    `${lien ? `\n\nVoir dans Me : ${lien}` : ''}\n\n— Me\n${PIED_RAPPORT}`;

  const bloc = (r: Rapport) => {
    const barre = (part: number, couleur: string) =>
      `<div style="height:6px;border-radius:3px;background:#13222D;margin-top:4px"><div style="height:6px;width:${Math.max(2, Math.min(100, part))}%;border-radius:3px;background:${couleur}"></div></div>`;
    const cats = r.categories
      .slice(0, 4)
      .map((c) => `<tr><td style="padding:6px 0"><div style="display:flex;justify-content:space-between;color:#DCF3FF;font-size:13px"><span>${echapper(c.nom)}</span><span style="float:right">${echapper(m(r, c.montant))}</span></div>${barre(c.part, '#38D9FF')}</td></tr>`)
      .join('');
    const budgets = r.budgets
      .slice(0, 4)
      .map((b) => {
        const part = b.plafond > 0 ? Math.round((b.depense / b.plafond) * 100) : 100;
        return `<tr><td style="padding:6px 0"><div style="color:#DCF3FF;font-size:13px">${echapper(b.nom)}<span style="float:right;color:${b.depasse ? '#FF6474' : '#86A7B8'}">${echapper(m(r, b.depense))} / ${echapper(m(r, b.plafond))}</span></div>${barre(part, b.depasse ? '#FF6474' : part >= 80 ? '#FFCB5C' : '#3EF0B0')}</td></tr>`;
      })
      .join('');
    const conseils = r.conseils
      .map((c) => `<tr><td style="padding:10px 12px;border-left:3px solid ${TON[c.ton]};background:#0A141C;border-radius:8px;color:#DCF3FF;font-size:14px;line-height:20px">${echapper(c.texte)}</td></tr><tr><td style="height:8px"></td></tr>`)
      .join('');
    const titre = (t: string) => `<div style="color:#86A7B8;font-size:12px;margin:18px 0 4px">${t}</div>`;
    return (
      `<div style="padding:18px;border-radius:14px;background:#08121A;margin-bottom:16px">` +
      `<div style="color:#86A7B8;font-size:13px">${echapper(r.titre)}</div>` +
      `<div style="color:#DCF3FF;font-size:30px;font-weight:800;margin:4px 0">${echapper(r.nombre ? m(r, r.depenses) : 'Rien de noté')}</div>` +
      `<div style="color:#86A7B8;font-size:13px">${echapper(resumeRapport(r))}${r.revenus > 0 ? ` Reçu : ${echapper(m(r, r.revenus))}.` : ''}</div>` +
      (conseils ? `${titre('Conseils')}<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${conseils}</table>` : '') +
      (cats ? `${titre("Où est parti l'argent")}<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${cats}</table>` : '') +
      (budgets ? `${titre('Budgets')}<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${budgets}</table>` : '') +
      `</div>`
    );
  };

  const html =
    `<div style="background:#04080C;padding:28px 16px;font-family:-apple-system,Segoe UI,Roboto,sans-serif">` +
    `<div style="max-width:520px;margin:0 auto">` +
    `<div style="font-size:30px;font-weight:800;color:#DCF3FF;margin-bottom:18px">Me<span style="color:#38D9FF">.</span></div>` +
    (nom ? `<p style="color:#DCF3FF;font-size:15px">Bonjour ${echapper(nom)},</p>` : '') +
    rapports.map(bloc).join('') +
    (lien ? `<a href="${echapper(lien)}" style="display:inline-block;margin-top:4px;padding:11px 18px;border-radius:9px;background:#38D9FF;color:#04080C;font-size:14px;font-weight:700;text-decoration:none">Voir mes finances</a>` : '') +
    `<p style="color:#86A7B8;font-size:12px;margin-top:18px">${echapper(PIED_RAPPORT)}</p>` +
    `</div></div>`;
  return { sujet, texte, html };
}
