-- Abonnements, suite : preuve des CGV par paiement, recherche des paiements par statut, essai unique par personne.
ALTER TABLE "Paiement" ADD COLUMN "cgvVersion" TEXT,
ADD COLUMN "accesImmediat" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Paiement_statut_createdAt_idx" ON "Paiement"("statut", "createdAt");

CREATE TABLE "EssaiUtilise" (
    "empreinte" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EssaiUtilise_pkey" PRIMARY KEY ("empreinte")
);
