ALTER TABLE "EnvoiSms" ADD COLUMN "genre" TEXT NOT NULL DEFAULT 'compte';

CREATE TABLE "Tontine" (
    "id" TEXT NOT NULL,
    "organisateurId" TEXT,
    "nom" TEXT NOT NULL,
    "description" TEXT,
    "montant" INTEGER NOT NULL,
    "devise" TEXT NOT NULL,
    "rythme" TEXT NOT NULL,
    "places" INTEGER NOT NULL,
    "commissionBps" INTEGER NOT NULL,
    "fuseau" TEXT NOT NULL,
    "etat" TEXT NOT NULL DEFAULT 'ouvert',
    "tourCourant" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tontine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TontineMembre" (
    "id" TEXT NOT NULL,
    "tontineId" TEXT NOT NULL,
    "userId" TEXT,
    "contact" JSONB NOT NULL,
    "etat" TEXT NOT NULL DEFAULT 'demande',
    "rang" INTEGER,
    "cautionStatut" TEXT NOT NULL DEFAULT 'due',
    "conditionsVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TontineMembre_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TontineTour" (
    "id" TEXT NOT NULL,
    "tontineId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "beneficiaireId" TEXT,
    "echeance" TEXT NOT NULL,
    "etat" TEXT NOT NULL DEFAULT 'a_venir',
    "brut" INTEGER NOT NULL,
    "commission" INTEGER NOT NULL,
    "net" INTEGER NOT NULL,
    "valideParNom" TEXT,
    "valideLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TontineTour_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TontineMouvement" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "tontineId" TEXT,
    "membreId" TEXT,
    "tourId" TEXT,
    "genre" TEXT NOT NULL,
    "montant" INTEGER NOT NULL,
    "devise" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "statut" TEXT NOT NULL,
    "telephone" TEXT NOT NULL DEFAULT '',
    "commande" TEXT,
    "message" TEXT,
    "payeLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TontineMouvement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Tontine_etat_createdAt_idx" ON "Tontine"("etat", "createdAt");
CREATE INDEX "Tontine_organisateurId_idx" ON "Tontine"("organisateurId");
CREATE UNIQUE INDEX "TontineMembre_tontineId_userId_key" ON "TontineMembre"("tontineId", "userId");
CREATE INDEX "TontineMembre_userId_idx" ON "TontineMembre"("userId");
CREATE UNIQUE INDEX "TontineTour_tontineId_numero_key" ON "TontineTour"("tontineId", "numero");
CREATE INDEX "TontineTour_etat_idx" ON "TontineTour"("etat");
CREATE UNIQUE INDEX "TontineMouvement_reference_key" ON "TontineMouvement"("reference");
CREATE INDEX "TontineMouvement_membreId_createdAt_idx" ON "TontineMouvement"("membreId", "createdAt");
CREATE INDEX "TontineMouvement_tourId_genre_idx" ON "TontineMouvement"("tourId", "genre");
CREATE INDEX "TontineMouvement_statut_createdAt_idx" ON "TontineMouvement"("statut", "createdAt");

-- Une seule demande en attente par membre, même si deux clics arrivent ensemble.
CREATE UNIQUE INDEX "TontineMouvement_une_attente" ON "TontineMouvement"("membreId") WHERE "statut" = 'en_attente' AND "genre" IN ('caution', 'cotisation');
-- Un tour n'est jamais versé deux fois, et une caution jamais rendue deux fois.
CREATE UNIQUE INDEX "TontineMouvement_un_versement" ON "TontineMouvement"("tourId") WHERE "genre" = 'versement' AND "statut" IN ('en_attente', 'paye');
CREATE UNIQUE INDEX "TontineMouvement_une_caution_rendue" ON "TontineMouvement"("membreId") WHERE "genre" = 'caution_rendue' AND "statut" IN ('en_attente', 'paye');
-- Une caution ne couvre qu'une fois le même tour.
CREATE UNIQUE INDEX "TontineMouvement_une_couverture" ON "TontineMouvement"("membreId", "tourId") WHERE "genre" = 'caution_utilisee';

ALTER TABLE "Tontine" ADD CONSTRAINT "Tontine_organisateurId_fkey" FOREIGN KEY ("organisateurId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TontineMembre" ADD CONSTRAINT "TontineMembre_tontineId_fkey" FOREIGN KEY ("tontineId") REFERENCES "Tontine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TontineMembre" ADD CONSTRAINT "TontineMembre_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TontineTour" ADD CONSTRAINT "TontineTour_tontineId_fkey" FOREIGN KEY ("tontineId") REFERENCES "Tontine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TontineTour" ADD CONSTRAINT "TontineTour_beneficiaireId_fkey" FOREIGN KEY ("beneficiaireId") REFERENCES "TontineMembre"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TontineMouvement" ADD CONSTRAINT "TontineMouvement_tontineId_fkey" FOREIGN KEY ("tontineId") REFERENCES "Tontine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TontineMouvement" ADD CONSTRAINT "TontineMouvement_membreId_fkey" FOREIGN KEY ("membreId") REFERENCES "TontineMembre"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TontineMouvement" ADD CONSTRAINT "TontineMouvement_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "TontineTour"("id") ON DELETE SET NULL ON UPDATE CASCADE;
