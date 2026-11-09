-- Adjoints de l'initiateur, et changements dans un groupe (place cédée, tours échangés).
ALTER TABLE "TontineMembre" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'membre';

CREATE TABLE "TontineChangement" (
    "id" TEXT NOT NULL,
    "tontineId" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "membreId" TEXT NOT NULL,
    "avecMembreId" TEXT,
    "code" TEXT,
    "numero" TEXT,
    "nouveauUserId" TEXT,
    "nouveauContact" JSONB,
    "demandeParId" TEXT,
    "accordMembre" BOOLEAN NOT NULL DEFAULT false,
    "accordAutre" BOOLEAN NOT NULL DEFAULT false,
    "accordInitiateur" BOOLEAN NOT NULL DEFAULT false,
    "etat" TEXT NOT NULL DEFAULT 'en_attente',
    "faitLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TontineChangement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TontineChangement_code_key" ON "TontineChangement"("code");
CREATE INDEX "TontineChangement_tontineId_etat_idx" ON "TontineChangement"("tontineId", "etat");
ALTER TABLE "TontineChangement" ADD CONSTRAINT "TontineChangement_tontineId_fkey" FOREIGN KEY ("tontineId") REFERENCES "Tontine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
