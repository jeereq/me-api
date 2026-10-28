-- Invitations d'équipe : quand le lien a été ouvert, et avec quel compte.
ALTER TABLE "InvitationEquipe" ADD COLUMN "ouverteLe" TIMESTAMP(3),
ADD COLUMN "ouvertePar" TEXT;
