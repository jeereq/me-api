import type { Request, Response } from 'express';

import { TAILLE_PIECE_MAX } from '../services/cotisations/approbations.js';
import { SmsService } from '../services/SmsService.js';
import { ApprobationService as A, TontineService as S } from '../services/TontineService.js';
import { estFichier, lireFormulaire } from '../utils/formulaire.js';
import { HttpError } from '../utils/http.js';
import { dossierEligibiliteSchema, filtresAnnuaireSchema } from '../validators/schemas.js';
import { prisma } from '../utils/prisma.js';

const p = (v: string | string[] | undefined) => String(v ?? '');
const compte = async (req: Request) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, nom: true, fuseau: true, telephone: true } });
  return u;
};

const acteur = (req: Request) => ({ id: req.user!.id, nom: req.user!.nom || req.user!.email, admin: req.user!.role === 'ADMIN' });

const filtresAnnuaire = (req: Request) => {
  const r = filtresAnnuaireSchema.safeParse(req.query);
  return r.success ? r.data : {};
};

export const TontineController = {
  mesGroupes: async (req: Request, res: Response) => {
    res.json(await S.mesGroupes(req.user!.id));
  },
  annuairePublic: async (req: Request, res: Response) => {
    res.json(await S.annuaire(null, filtresAnnuaire(req)));
  },
  limites: async (_req: Request, res: Response) => {
    res.json(await S.limites());
  },
  annuaire: async (req: Request, res: Response) => {
    res.json(await S.annuaire(req.user!.id, filtresAnnuaire(req)));
  },
  groupePublic: async (req: Request, res: Response) => {
    res.json(await S.groupeAnnuaire(null, p(req.params.id)));
  },
  groupeAnnuaire: async (req: Request, res: Response) => {
    res.json(await S.groupeAnnuaire(req.user!.id, p(req.params.id)));
  },
  mesAlertes: async (req: Request, res: Response) => {
    res.json(await S.mesAlertes(req.user!.id));
  },
  creerAlerte: async (req: Request, res: Response) => {
    res.json(await S.creerAlerte(req.user!.id, req.body));
  },
  supprimerAlerte: async (req: Request, res: Response) => {
    res.json(await S.supprimerAlerte(req.user!.id, p(req.params.id)));
  },
  signaler: async (req: Request, res: Response) => {
    res.json(await S.signaler(req.user!.id, p(req.params.id), req.body.motif, req.body.texte));
  },
  adminSignalements: async (_req: Request, res: Response) => {
    res.json(await S.adminSignalements());
  },
  adminDeciderSignalement: async (req: Request, res: Response) => {
    res.json(await S.adminDeciderSignalement(acteur(req), p(req.params.id), req.body.decision));
  },
  detail: async (req: Request, res: Response) => {
    res.json(await S.detail(req.user!.id, p(req.params.id)));
  },
  creer: async (req: Request, res: Response) => {
    res.status(201).json(await S.creer(await compte(req), req.body));
  },
  adherer: async (req: Request, res: Response) => {
    res.json(await S.adherer(await compte(req), p(req.params.id)));
  },
  invitation: async (req: Request, res: Response) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).json(await S.invitation(p(req.params.code)));
  },
  rejoindre: async (req: Request, res: Response) => {
    res.json(await S.rejoindreParInvitation(await compte(req), p(req.params.code), req.body.telephone));
  },
  inviter: async (req: Request, res: Response) => {
    res.json(await S.inviter(req.user!.id, p(req.params.id), req.body.telephone));
  },
  payerPour: async (req: Request, res: Response) => {
    res.json(await S.payerPourMembre(req.user!.id, p(req.params.membreId)));
  },
  retirer: async (req: Request, res: Response) => {
    res.json(await S.retirer(req.user!.id, p(req.params.membreId)));
  },
  eligibilite: async (req: Request, res: Response) => {
    res.json(await A.etat(req.user!.id));
  },
  demanderCode: async (req: Request, res: Response) => {
    await SmsService.demanderCode(req.user!.id, req.body.telephone);
    res.json(await A.etat(req.user!.id));
  },
  confirmerCode: async (req: Request, res: Response) => {
    await SmsService.confirmerCode(req.user!.id, req.body.code);
    res.json(await A.etat(req.user!.id));
  },
  soumettre: async (req: Request, res: Response) => {
    const form = await lireFormulaire(req, TAILLE_PIECE_MAX + 64 * 1024, 'Photo trop lourde : 5 Mo au plus.');
    const fichier = form.get('fichier');
    if (!estFichier(fichier)) throw new HttpError(400, 'Aucune photo reçue. Choisis la photo à nouveau.');
    let brut: unknown;
    try {
      brut = JSON.parse(String(form.get('dossier') ?? ''));
    } catch {
      throw new HttpError(400, 'Dossier illisible.');
    }
    const dossier = dossierEligibiliteSchema.safeParse(brut);
    if (!dossier.success) throw new HttpError(400, dossier.error.issues[0]?.message ?? 'Dossier incomplet.');
    res.status(201).json(await A.soumettre(req.user!.id, new Uint8Array(await fichier.arrayBuffer()), dossier.data));
  },
  adminApprobations: async (_req: Request, res: Response) => {
    res.json(await A.aTraiter());
  },
  adminPiece: async (req: Request, res: Response) => {
    res.set({ 'Cache-Control': 'no-store' }).json(await A.dossier(p(req.params.userId)));
  },
  adminDecider: async (req: Request, res: Response) => {
    if (req.params.userId === req.user!.id && req.user!.role !== 'ADMIN') throw new HttpError(403, 'Un autre responsable doit valider ton compte.');
    res.json(await A.decider(req.user!.nom || req.user!.email, p(req.params.userId), req.body.approuve, req.body.motif));
  },
  reglerRegles: async (req: Request, res: Response) => {
    res.json(await S.reglerRegles(req.user!.id, p(req.params.id), req.body));
  },
  ordonner: async (req: Request, res: Response) => {
    res.json(await S.ordonner(req.user!.id, p(req.params.id), req.body.membres));
  },
  demanderPaiement: async (req: Request, res: Response) => {
    res.json(await S.demanderPaiement(req.user!.id, p(req.params.membreId)));
  },
  adjoint: async (req: Request, res: Response) => {
    res.json(await S.adjoint(req.user!.id, p(req.params.membreId), req.body.adjoint === true));
  },
  proposerChangement: async (req: Request, res: Response) => {
    res.json(await S.proposerChangement(await compte(req), p(req.params.id), req.body));
  },
  repondreChangement: async (req: Request, res: Response) => {
    res.json(await S.repondreChangement(req.user!.id, p(req.params.changementId), req.body.accepte === true));
  },
  annulerChangement: async (req: Request, res: Response) => {
    res.json(await S.annulerChangement(req.user!.id, p(req.params.changementId)));
  },
  changerBeneficiaire: async (req: Request, res: Response) => {
    res.json(await S.changerBeneficiaire(req.user!.id, p(req.params.id), { nom: String(req.body.nom), telephone: String(req.body.telephone) }));
  },
  cloturer: async (req: Request, res: Response) => {
    res.json(await S.cloturer(req.user!.id, p(req.params.id)));
  },
  demanderVersement: async (req: Request, res: Response) => {
    res.json(await S.demanderVersement(req.user!.id, p(req.params.id)));
  },
  demanderATous: async (req: Request, res: Response) => {
    res.json(await S.demanderATous(req.user!.id, p(req.params.id)));
  },
  noterEspeces: async (req: Request, res: Response) => {
    res.json(await S.noterEspeces(req.user!.id, p(req.params.membreId)));
  },
  exclure: async (req: Request, res: Response) => {
    res.json(await S.exclure(req.user!.id, p(req.params.membreId)));
  },
  reglerRappels: async (req: Request, res: Response) => {
    res.json(await S.reglerRappels(req.user!.id, p(req.params.id), req.body));
  },
  quitter: async (req: Request, res: Response) => {
    res.json(await S.quitter(req.user!.id, p(req.params.id)));
  },
  annuler: async (req: Request, res: Response) => {
    res.json(await S.annuler(req.user!.id, p(req.params.id)));
  },
  demarrer: async (req: Request, res: Response) => {
    res.json(await S.demarrer(req.user!.id, p(req.params.id)));
  },
  payer: async (req: Request, res: Response) => {
    res.json(await S.payer(req.user!.id, p(req.params.id), req.body.genre));
  },
  abandonner: async (req: Request, res: Response) => {
    res.json(await S.abandonner(req.user!.id, p(req.params.id)));
  },
  decider: async (req: Request, res: Response) => {
    res.json(await S.decider(req.user!.id, p(req.params.membreId), req.body.accepte));
  },
  rappeler: async (req: Request, res: Response) => {
    res.json(await S.rappeler(req.user!.id, p(req.params.membreId)));
  },
  utiliserCaution: async (req: Request, res: Response) => {
    res.json(await S.utiliserCaution(req.user!.id, p(req.params.membreId)));
  },
  retour: async (req: Request, res: Response) => {
    res.json(await S.retour((req.body ?? {}) as Record<string, unknown>));
  },
  adminResume: async (_req: Request, res: Response) => {
    res.json(await S.resumeAdmin());
  },
  adminVerser: async (req: Request, res: Response) => {
    res.json(await S.verserTour(acteur(req), p(req.params.tourId), req.body.preuve, req.body.montant));
  },
  adminVersements: async (_req: Request, res: Response) => {
    res.json(await S.adminVersements());
  },
  adminReverifier: async (req: Request, res: Response) => {
    res.json(await S.adminReverifier(p(req.params.reference)));
  },
  adminVerserTranche: async (req: Request, res: Response) => {
    res.json(await S.verser(acteur(req), p(req.params.cle), req.body.preuve, req.body.montant));
  },
  adminRendre: async (req: Request, res: Response) => {
    res.json(await S.rendreCaution(acteur(req), p(req.params.membreId), req.body.preuve));
  },
};
