CREATE TABLE "Cotisation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "titre" TEXT NOT NULL,
    "montant" INTEGER NOT NULL,
    "devise" TEXT NOT NULL,
    "rythme" TEXT NOT NULL,
    "debut" TEXT NOT NULL,
    "archive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cotisation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CotisationMembre" (
    "id" TEXT NOT NULL,
    "cotisationId" TEXT NOT NULL,
    "contact" JSONB NOT NULL,
    "jeton" TEXT NOT NULL,
    "demandeLe" TIMESTAMP(3),
    "demandePeriode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CotisationMembre_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaiementCotisation" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "cotisationId" TEXT,
    "membreId" TEXT,
    "periode" TEXT NOT NULL,
    "montant" INTEGER NOT NULL,
    "devise" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "statut" TEXT NOT NULL,
    "telephone" TEXT NOT NULL DEFAULT '',
    "commande" TEXT,
    "message" TEXT,
    "payeLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaiementCotisation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Cotisation_userId_archive_idx" ON "Cotisation"("userId", "archive");
CREATE UNIQUE INDEX "CotisationMembre_jeton_key" ON "CotisationMembre"("jeton");
CREATE INDEX "CotisationMembre_cotisationId_idx" ON "CotisationMembre"("cotisationId");
CREATE UNIQUE INDEX "PaiementCotisation_reference_key" ON "PaiementCotisation"("reference");
CREATE INDEX "PaiementCotisation_cotisationId_statut_idx" ON "PaiementCotisation"("cotisationId", "statut");
CREATE INDEX "PaiementCotisation_membreId_createdAt_idx" ON "PaiementCotisation"("membreId", "createdAt");
CREATE INDEX "PaiementCotisation_statut_createdAt_idx" ON "PaiementCotisation"("statut", "createdAt");

-- Une seule demande en attente par membre et par période, même si deux clics arrivent en même temps.
CREATE UNIQUE INDEX "PaiementCotisation_une_attente" ON "PaiementCotisation"("membreId", "periode") WHERE "statut" = 'en_attente';

ALTER TABLE "Cotisation" ADD CONSTRAINT "Cotisation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CotisationMembre" ADD CONSTRAINT "CotisationMembre_cotisationId_fkey" FOREIGN KEY ("cotisationId") REFERENCES "Cotisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaiementCotisation" ADD CONSTRAINT "PaiementCotisation_cotisationId_fkey" FOREIGN KEY ("cotisationId") REFERENCES "Cotisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaiementCotisation" ADD CONSTRAINT "PaiementCotisation_membreId_fkey" FOREIGN KEY ("membreId") REFERENCES "CotisationMembre"("id") ON DELETE SET NULL ON UPDATE CASCADE;
