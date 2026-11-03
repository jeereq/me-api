import type { Prisma } from '@prisma/client';

import type { AjusterReponseBody, AnalyseBoucleBody, AnalyseMailsBody, ProposerEtiquettesBody, RelireReponseBody } from '../validators/schemas.js';
import { HttpError } from '../utils/http.js';
import { jsonPropre } from '../utils/json.js';
import { prisma } from '../utils/prisma.js';
import { etatAbonnement } from './abonnements/offres.js';
import { donneesBoucle, exemplesEtiquettes, lireAjustement, lireBoucle, lireEtiquettes, lireRelecture, type AnalyseBoucle, type RelectureReponse } from './analyse-mails.js';
import { AssistantService } from './AssistantService.js';
import {
  AGE_MAX_JOURS,
  analyserLot,
  AUTO_PAR_COMPTE,
  AUTO_PAR_PASSAGE,
  contexteDepuisEspace,
  empreinte,
  etatDAnalyse,
  limiteAge,
  lireRef,
  mailPourIA,
  mailsAPreparer,
  refMail,
  tonDe,
  type AnalyseIA,
  type Reponse,
} from './analyses/regles.js';
import { jour } from './integrations/http.js';
import { IntegrationService } from './IntegrationService.js';

/** Les mails déjà essayés plusieurs fois par la préparation à l'avance sans résultat (illisibles, oubliés par l'IA) : on n'insiste pas. */
const essais = new Map<string, number>();
const ESSAIS_MAX = 2;

const prefsAuto = { prefs: { path: ['analyseAuto'], equals: true } } as const;

/**
 * L'analyse des mails faite par le serveur : il lit lui-même les mails (l'app n'a plus à les télécharger puis les renvoyer),
 * garde chaque analyse 30 jours (rouvrir ne coûte rien) et peut préparer à l'avance celle des nouveaux mails.
 * Le texte des mails n'est jamais gardé, seulement ce que l'IA en a tiré.
 */
export const AnalyseMailService = {
  /**
   * Analyse jusqu'à dix mails (`ext:<compte>:<mail>`) du compte. Un mail qui n'est pas à lui, ou qui n'est plus lisible, n'a pas d'analyse.
   * `crm` : ce que l'app sait des relances, tâches et projets (elle connaît aussi l'espace d'une équipe) ; sans lui, l'espace privé du compte.
   */
  async analyser(userId: string, b: Pick<AnalyseMailsBody, 'mails' | 'ton' | 'consignes' | 'crm'>): Promise<Reponse> {
    const refs = b.mails.filter((r) => lireRef(r));
    const ids = [...new Set(refs.map((r) => lireRef(r)!.integrationId))];
    const comptes = new Map((await prisma.integration.findMany({ where: { userId, id: { in: ids } } })).map((i) => [i.id, i]));
    const permises = refs.filter((r) => comptes.has(lireRef(r)!.integrationId));
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { fuseau: true, nomApp: true, espace: { select: { data: true } } } });

    const ton = b.ton ?? tonDe(user.espace?.data);
    const cle = empreinte(ton, b.consignes);
    const contexteMails = permises.map((r) => {
      const { integrationId, mailId } = lireRef(r)!;
      const garde = ((comptes.get(integrationId)!.donnees as { mails?: { id: string; contact?: string; adresse?: string; fil?: string }[]; vus?: { id: string; contact?: string; adresse?: string; fil?: string }[] } | null) ?? {});
      const m = [...(garde.mails ?? []), ...(garde.vus ?? [])].find((x) => x.id === mailId);
      return { contact: m?.contact, adresse: m?.adresse, cleFil: `${integrationId}:${m?.fil ?? mailId}` };
    });
    const crm = b.crm ?? contexteDepuisEspace(user.espace?.data, contexteMails);

    const r = await analyserLot(
      permises,
      { aujourdhui: jour(0, user.fuseau), crm },
      {
        gardees: async (liste) => {
          const parCompte = new Map<string, string[]>();
          for (const ref of liste) {
            const { integrationId, mailId } = lireRef(ref)!;
            parCompte.set(integrationId, [...(parCompte.get(integrationId) ?? []), mailId]);
          }
          const out = new Map<string, AnalyseIA>();
          for (const [integrationId, mailIds] of parCompte) {
            const lignes = await prisma.analyseMail.findMany({ where: { integrationId, mailId: { in: mailIds }, empreinte: cle, majLe: { gte: limiteAge() } } });
            for (const l of lignes) out.set(refMail(integrationId, l.mailId), { ...(l.resultat as object), id: refMail(integrationId, l.mailId) } as AnalyseIA);
          }
          return out;
        },
        lire: async (ref) => {
          const { integrationId, mailId } = lireRef(ref)!;
          const { contenu, ctx, garde } = await IntegrationService.lirePourAnalyse(userId, integrationId, mailId);
          return mailPourIA(ref, contenu, ctx, garde?.extrait);
        },
        demander: (donnees) => AssistantService.demanderAvecModeles({ type: 'mails', ton, nom: user.nomApp, ...(b.consignes?.trim() ? { consignes: b.consignes } : {}), donnees }),
        garder: async (ref, analyse, modeles) => {
          const { integrationId, mailId } = lireRef(ref)!;
          const resultat = jsonPropre(analyse) as unknown as Prisma.InputJsonObject;
          await prisma.analyseMail.upsert({
            where: { integrationId_mailId: { integrationId, mailId } },
            create: { userId, integrationId, mailId, empreinte: cle, modele: modeles.join('+'), resultat },
            update: { empreinte: cle, modele: modeles.join('+'), resultat },
          });
        },
      },
    );
    return { ...r, illisibles: [...r.illisibles, ...b.mails.filter((x) => !permises.includes(x))] };
  },

  /**
   * Comprendre une boucle de mails : de quoi il s'agit, ce qui s'est passé, qui doit agir, et une réponse prête s'il en faut une.
   * Gardée 30 jours comme les autres analyses, sous sa propre clé : un nouveau message de la boucle est un autre mail, donc une nouvelle lecture.
   */
  async analyserBoucle(userId: string, b: AnalyseBoucleBody): Promise<AnalyseBoucle & { messages: number; enCache: boolean }> {
    const ref = lireRef(b.mail);
    if (!ref) throw new HttpError(400, 'Ce mail ne vient pas d’un compte connecté.');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { fuseau: true, nomApp: true, espace: { select: { data: true } } } });
    const ton = b.ton ?? tonDe(user.espace?.data);
    const cle = empreinte(ton, b.consignes);
    const mailId = `boucle:${ref.mailId}`;
    const gardee = await prisma.analyseMail.findFirst({ where: { userId, integrationId: ref.integrationId, mailId, empreinte: cle, majLe: { gte: limiteAge() } } });
    if (gardee) return { ...(gardee.resultat as AnalyseBoucle & { messages: number }), enCache: true };

    const { contenu, ctx, garde, compte } = await IntegrationService.lirePourAnalyse(userId, ref.integrationId, ref.mailId);
    const donnees = donneesBoucle(contenu, { aujourdhui: jour(0, user.fuseau), moi: compte, boite: ctx, extrait: garde?.extrait });
    if (!donnees.messages.length) throw new HttpError(422, 'Ce mail ne contient pas de texte à analyser.');
    const r = await AssistantService.demanderAvecModeles({ type: 'boucle', ton, nom: user.nomApp, ...(b.consignes?.trim() ? { consignes: b.consignes } : {}), donnees: JSON.stringify(donnees) });
    const lu = lireBoucle(r.texte);
    if (!lu) throw new HttpError(502, "L'IA n'a pas pu lire cette boucle. Réessaie dans un instant.");
    const resultat = { ...lu, messages: donnees.messages.length };
    const json = jsonPropre(resultat) as unknown as Prisma.InputJsonObject;
    await prisma.analyseMail.upsert({
      where: { integrationId_mailId: { integrationId: ref.integrationId, mailId } },
      create: { userId, integrationId: ref.integrationId, mailId, empreinte: cle, modele: r.modeles.join('+'), resultat: json },
      update: { empreinte: cle, modele: r.modeles.join('+'), resultat: json },
    });
    return { ...resultat, enCache: false };
  },

  /** Relit une réponse avant son envoi, avec le mail et sa conversation. Pas gardée : le brouillon change à chaque mot, et le mail reste non lu. */
  async relireReponse(userId: string, b: RelireReponseBody): Promise<RelectureReponse> {
    const ref = lireRef(b.mail);
    if (!ref) throw new HttpError(400, 'Ce mail ne vient pas d’un compte connecté.');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { fuseau: true, nomApp: true, espace: { select: { data: true } } } });
    const ton = b.ton ?? tonDe(user.espace?.data);
    const { contenu, ctx, garde, compte } = await IntegrationService.lirePourAnalyse(userId, ref.integrationId, ref.mailId);
    const donnees = { ...donneesBoucle(contenu, { aujourdhui: jour(0, user.fuseau), moi: compte, boite: ctx, extrait: garde?.extrait }), reponse_proposee: b.reponse };
    const r = await AssistantService.demanderAvecModeles({ type: 'relecture', ton, nom: user.nomApp, ...(b.consignes?.trim() ? { consignes: b.consignes } : {}), donnees: JSON.stringify(donnees) });
    const lu = lireRelecture(r.texte);
    if (!lu) throw new HttpError(502, "L'IA n'a pas pu relire cette réponse. Réessaie dans un instant.");
    return lu;
  },

  /** Ajuste une réponse : plus courte, plus formelle, un refus poli, ou une autre version. Rien n'est gardé, et le mail reste non lu. */
  async ajusterReponse(userId: string, b: AjusterReponseBody): Promise<string> {
    const ref = lireRef(b.mail);
    if (!ref) throw new HttpError(400, 'Ce mail ne vient pas d’un compte connecté.');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { fuseau: true, nomApp: true, espace: { select: { data: true } } } });
    const ton = b.ton ?? tonDe(user.espace?.data);
    const { contenu, ctx, garde, compte } = await IntegrationService.lirePourAnalyse(userId, ref.integrationId, ref.mailId);
    const donnees = { ...donneesBoucle(contenu, { aujourdhui: jour(0, user.fuseau), moi: compte, boite: ctx, extrait: garde?.extrait }), reponse_proposee: b.reponse };
    const r = await AssistantService.demanderAvecModeles({ type: 'ajustement', ajustement: b.action, ton, nom: user.nomApp, ...(b.consignes?.trim() ? { consignes: b.consignes } : {}), donnees: JSON.stringify(donnees) });
    const lu = lireAjustement(r.texte);
    if (!lu) throw new HttpError(502, "L'IA n'a pas pu ajuster cette réponse. Réessaie dans un instant.");
    return lu;
  },

  /** Propose des étiquettes d'après le contenu du mail et la façon dont l'utilisateur range déjà. Rien n'est posé ni gardé, et le mail reste non lu. */
  async proposerEtiquettes(userId: string, b: ProposerEtiquettesBody) {
    const ref = lireRef(b.mail);
    if (!ref) throw new HttpError(400, 'Ce mail ne vient pas d’un compte connecté.');
    const [user, integration] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { fuseau: true } }),
      prisma.integration.findFirst({ where: { id: ref.integrationId, userId }, select: { donnees: true } }),
    ]);
    const { contenu, ctx, garde, compte } = await IntegrationService.lirePourAnalyse(userId, ref.integrationId, ref.mailId);
    const gardes = ((integration?.donnees ?? {}) as { mails?: { sujet?: string; libelles?: string[] }[] }).mails ?? [];
    const donnees = { ...donneesBoucle(contenu, { aujourdhui: jour(0, user.fuseau), moi: compte, boite: ctx, extrait: garde?.extrait }), etiquettes: exemplesEtiquettes(b.existantes, gardes), posees: b.posees };
    const r = await AssistantService.demanderAvecModeles({ type: 'etiquettes', donnees: JSON.stringify(donnees) });
    const lu = lireEtiquettes(r.texte, b.existantes, b.posees);
    if (!lu) throw new HttpError(502, "L'IA n'a pas pu proposer d'étiquettes. Réessaie dans un instant.");
    return lu;
  },

  /** Ce qui est déjà analysé parmi ces mails, pour le montrer dans la liste. Rien n'est lu chez le service, et aucune demande ne part à l'IA. */
  async etats(userId: string, mails: string[]) {
    const refs = mails.map(lireRef).filter((r): r is NonNullable<typeof r> => !!r);
    if (!refs.length) return [];
    const lignes = await prisma.analyseMail.findMany({ where: { userId, majLe: { gte: limiteAge() }, mailId: { in: refs.map((r) => r.mailId) } }, select: { integrationId: true, mailId: true, resultat: true } });
    return lignes.flatMap((l) => etatDAnalyse(refMail(l.integrationId, l.mailId), l.resultat) ?? []);
  },

  /**
   * Prépare l'analyse des nouveaux mails non lus des comptes dont l'utilisateur l'a demandé (réglage par compte, désactivé par défaut),
   * pour les abonnés Pro seulement. Mesuré : 10 mails au plus par compte et 100 par passage, sur les 3 derniers jours.
   * Sans consignes (elles restent sur l'appareil) : l'app les relit tels quels, ou refait l'analyse si l'utilisateur en a mis.
   */
  async preparerNouveaux(maintenant = new Date()) {
    if (!(await AssistantService.disponible())) return { comptes: 0, mails: 0 };
    const comptes = await prisma.integration.findMany({
      where: { fournisseur: { in: ['GOOGLE', 'MICROSOFT'] }, ...prefsAuto },
      select: { id: true, userId: true, donnees: true, user: { select: { role: true, essaiJusqua: true, abonnementFormule: true, abonnementPeriode: true, abonnementFinLe: true } } },
    });
    if (essais.size > 5000) essais.clear();
    let mails = 0;
    let traites = 0;
    for (const c of comptes) {
      if (mails >= AUTO_PAR_PASSAGE) break;
      // Les comptes connectés et l'assistant font partie de Pro : sans abonnement (ni essai), rien n'est préparé.
      if (!etatAbonnement(c.user).pro) continue;
      try {
        const recus = ((c.donnees as { mails?: Parameters<typeof mailsAPreparer>[0] } | null)?.mails ?? []).filter((m) => m?.id);
        const user = await prisma.user.findUniqueOrThrow({ where: { id: c.userId }, select: { espace: { select: { data: true } } } });
        const cle = empreinte(tonDe(user.espace?.data), undefined);
        const deja = new Set(
          (await prisma.analyseMail.findMany({ where: { integrationId: c.id, mailId: { in: recus.map((m) => m.id) }, empreinte: cle, majLe: { gte: limiteAge(maintenant) } }, select: { mailId: true } })).map((l) => l.mailId),
        );
        const abandonnes = new Set(recus.filter((m) => (essais.get(refMail(c.id, m.id)) ?? 0) >= ESSAIS_MAX).map((m) => m.id));
        const aPreparer = mailsAPreparer(recus, deja, maintenant, Math.min(AUTO_PAR_COMPTE, AUTO_PAR_PASSAGE - mails), abandonnes);
        if (!aPreparer.length) continue;
        for (const m of aPreparer) essais.set(refMail(c.id, m.id), (essais.get(refMail(c.id, m.id)) ?? 0) + 1);
        const r = await this.analyser(c.userId, { mails: aPreparer.map((m) => refMail(c.id, m.id)) });
        // Un mail analysé n'a plus besoin d'être retenté.
        for (const a of r.analyses) essais.delete(a.id);
        mails += r.fraiches;
        traites++;
      } catch (e) {
        console.error('Analyse à l’avance', c.id, (e as Error).message);
      }
    }
    return { comptes: traites, mails };
  },

  /** Efface les analyses gardées depuis plus de 30 jours. */
  async purger(maintenant = new Date()) {
    const { count } = await prisma.analyseMail.deleteMany({ where: { majLe: { lt: limiteAge(maintenant) } } });
    return { effacees: count, jours: AGE_MAX_JOURS };
  },
};
