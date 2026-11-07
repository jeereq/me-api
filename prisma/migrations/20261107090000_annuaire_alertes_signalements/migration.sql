ALTER TABLE "Tontine" ADD COLUMN "retireAnnuaireLe" TIMESTAMP(3);

CREATE TABLE "AlerteAnnuaire" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filtres" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlerteAnnuaire_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SignalementTontine" (
    "id" TEXT NOT NULL,
    "tontineId" TEXT NOT NULL,
    "userId" TEXT,
    "motif" TEXT NOT NULL,
    "texte" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'ouvert',
    "traitePar" TEXT,
    "traiteLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalementTontine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AlerteAnnuaire_userId_idx" ON "AlerteAnnuaire"("userId");
CREATE INDEX "SignalementTontine_statut_idx" ON "SignalementTontine"("statut");
CREATE UNIQUE INDEX "SignalementTontine_tontineId_userId_key" ON "SignalementTontine"("tontineId", "userId");

ALTER TABLE "AlerteAnnuaire" ADD CONSTRAINT "AlerteAnnuaire_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SignalementTontine" ADD CONSTRAINT "SignalementTontine_tontineId_fkey" FOREIGN KEY ("tontineId") REFERENCES "Tontine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SignalementTontine" ADD CONSTRAINT "SignalementTontine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
