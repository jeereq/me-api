ALTER TABLE "Tontine" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'rotation';
ALTER TABLE "Tontine" ADD COLUMN "visibilite" TEXT NOT NULL DEFAULT 'public';
ALTER TABLE "Tontine" ADD COLUMN "cautionRequise" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Tontine" ADD COLUMN "codeInvitation" TEXT;
ALTER TABLE "Tontine" ADD COLUMN "raison" TEXT;
ALTER TABLE "Tontine" ADD COLUMN "beneficiaire" JSONB;
ALTER TABLE "Tontine" ADD COLUMN "dateFin" TEXT;
CREATE UNIQUE INDEX "Tontine_codeInvitation_key" ON "Tontine"("codeInvitation");

CREATE TABLE "ApprobationCompte" (
    "userId" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'soumise',
    "piece" TEXT,
    "motif" TEXT,
    "decideParNom" TEXT,
    "decideLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprobationCompte_pkey" PRIMARY KEY ("userId")
);
CREATE INDEX "ApprobationCompte_statut_updatedAt_idx" ON "ApprobationCompte"("statut", "updatedAt");
ALTER TABLE "ApprobationCompte" ADD CONSTRAINT "ApprobationCompte_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
