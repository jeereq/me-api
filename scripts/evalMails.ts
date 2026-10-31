/**
 * Mesure la qualité de l'analyse des mails sur le jeu d'essai `eval/mails.json`, avec le vrai modèle OpenAI.
 *
 *   OPENAI_API_KEY=… npm run eval:mails                       # modèle OPENAI_MODEL, sinon le modèle par défaut
 *   OPENAI_API_KEY=… npm run eval:mails -- --modele gpt-4.1   # un autre modèle
 *   OPENAI_API_KEY=… npm run eval:mails -- --sans-contexte    # sans fil, pièces jointes ni crm, pour mesurer leur apport
 *
 * À lancer avant et après chaque changement de prompt ou de modèle : la note globale ne doit pas baisser.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';

import { MODELE_DEFAUT } from '../src/services/assistant-modele.js';
import { corpsRequete, messagesDe, schemaDe } from '../src/services/AssistantService.js';
import { noter, type AnalyseRendue, type CasEval } from '../src/services/eval-mails.js';

type Jeu = { aujourdhui: string; crm: unknown; mails: (Record<string, unknown> & CasEval)[] };

const args = process.argv.slice(2);
const option = (nom: string) => {
  const i = args.indexOf(nom);
  return i >= 0 ? args[i + 1] : undefined;
};
const modele = option('--modele') || process.env.OPENAI_MODEL || MODELE_DEFAUT;
const sansContexte = args.includes('--sans-contexte');
const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY manque : la mesure appelle le vrai modèle.');
  process.exit(1);
}

const jeu = JSON.parse(readFileSync(new URL('../eval/mails.json', import.meta.url), 'utf8')) as Jeu;
const mails = jeu.mails.map(({ attendu: _a, ...m }) => (sansContexte ? { ...m, precedents: undefined, pj: undefined } : m));

const analyses: AnalyseRendue[] = [];
const debut = Date.now();
let jetons = 0;
for (let i = 0; i < mails.length; i += 10) {
  const donnees = JSON.stringify({ aujourdhui: jeu.aujourdhui, ...(sansContexte ? {} : { crm: jeu.crm }), mails: mails.slice(i, i + 10) });
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpsRequete(modele, messagesDe({ type: 'mails', donnees }), true, true, schemaDe('mails'))),
  });
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number }; error?: { message?: string } };
  if (!res.ok) {
    console.error(`OpenAI ${res.status} : ${data.error?.message}`);
    process.exit(1);
  }
  jetons += data.usage?.total_tokens ?? 0;
  analyses.push(...((JSON.parse(data.choices?.[0]?.message?.content || '{}').analyses ?? []) as AnalyseRendue[]));
}

const note = noter(jeu.mails, analyses);
console.log(`\nAnalyse des mails · ${modele}${sansContexte ? ' · sans contexte' : ''} · ${mails.length} mails · ${Math.round((Date.now() - debut) / 1000)} s · ${jetons} jetons\n`);
for (const [nom, c] of Object.entries(note.criteres)) console.log(`${nom.padEnd(26)} ${String(c.ok).padStart(3)} / ${String(c.total).padEnd(3)} ${Math.round((100 * c.ok) / c.total)} %`);
console.log(`\nNote globale : ${Math.round(note.reussite * 100)} %`);
if (note.echecs.length) console.log(`\nÀ revoir :\n${note.echecs.map((e) => `- ${e}`).join('\n')}`);
