import type { Rappel } from '../commun/calcul.js';

const COULEURS: Record<string, string> = { agressif: '#FF6474', normal: '#62AEFF', coach: '#3EF0B0', hebdo: '#FFCB5C', briefing: '#38D9FF', passif: '#7F98A6' };
const echapper = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const PIED_RAPPELS = 'Tu reçois cet email parce que les rappels par email sont activés dans Me (Mon compte).';

/** L'email d'un passage des rappels. `lien` : l'écran à ouvrir (celui du rappel s'il est seul, sinon la liste des rappels). */
export function emailRappels(rappels: Pick<Rappel, 'titre' | 'corps' | 'mode'>[], nom: string, pied = PIED_RAPPELS, lien?: string) {
  const sujet = rappels.length === 1 ? rappels[0].titre : `${rappels.length} rappels de Me`;
  const texte = `${nom ? `Bonjour ${nom},\n\n` : ''}${rappels.map((r) => `• ${r.titre}\n  ${r.corps}`).join('\n\n')}${lien ? `\n\nOuvrir dans Me : ${lien}` : ''}\n\n— Me, ton assistant personnel${pied === PIED_RAPPELS ? '' : `\n${pied}`}`;
  const lignes = rappels
    .map(
      (r) =>
        `<tr><td style="padding:14px 16px;border-left:3px solid ${COULEURS[r.mode] || '#38D9FF'};background:#0A141C;border-radius:8px">` +
        `<div style="font-weight:700;color:#DCF3FF;font-size:15px">${echapper(r.titre)}</div>` +
        `<div style="color:#86A7B8;font-size:13px;line-height:19px;margin-top:4px">${echapper(r.corps)}</div></td></tr><tr><td style="height:10px"></td></tr>`,
    )
    .join('');
  const html =
    `<div style="background:#04080C;padding:28px 16px;font-family:-apple-system,Segoe UI,Roboto,sans-serif">` +
    `<div style="max-width:520px;margin:0 auto">` +
    `<div style="font-size:30px;font-weight:800;color:#DCF3FF">Me<span style="color:#38D9FF">.</span></div>` +
    `<div style="color:#38D9FF;font-family:monospace;font-size:11px;letter-spacing:2px;margin:4px 0 20px">TES RAPPELS</div>` +
    (nom ? `<p style="color:#DCF3FF;font-size:15px">Bonjour ${echapper(nom)},</p>` : '') +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${lignes}</table>` +
    (lien ? `<a href="${echapper(lien)}" style="display:inline-block;margin-top:8px;padding:11px 18px;border-radius:9px;background:#38D9FF;color:#04080C;font-size:14px;font-weight:700;text-decoration:none">Ouvrir dans Me</a>` : '') +
    `<p style="color:#86A7B8;font-size:12px;margin-top:18px">${echapper(pied)}</p>` +
    `</div></div>`;
  return { sujet, texte, html };
}
