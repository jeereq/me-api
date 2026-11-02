-- Paliers de réunions de Pro (Pro 0 à Pro 3) et audio de réunion transcrit par compte et par mois.
ALTER TABLE "User" ADD COLUMN "abonnementPalier" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Paiement" ADD COLUMN "palier" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "UsageReunion" (
    "userId" TEXT NOT NULL,
    "cle" TEXT NOT NULL,
    "secondes" INTEGER NOT NULL DEFAULT 0,
    "majLe" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageReunion_pkey" PRIMARY KEY ("userId","cle")
);

ALTER TABLE "UsageReunion" ADD CONSTRAINT "UsageReunion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
