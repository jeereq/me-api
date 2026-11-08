-- Règles des groupes, part en espèces des tours, invitations envoyées.
ALTER TABLE "Tontine" ADD COLUMN "regles" JSONB;
ALTER TABLE "TontineTour" ADD COLUMN "especes" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "TontineInvitation" (
    "id" TEXT NOT NULL,
    "tontineId" TEXT NOT NULL,
    "empreinte" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "mail" BOOLEAN NOT NULL DEFAULT false,
    "sms" BOOLEAN NOT NULL DEFAULT false,
    "envois" INTEGER NOT NULL DEFAULT 1,
    "envoyeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rejointLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TontineInvitation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TontineInvitation_tontineId_empreinte_key" ON "TontineInvitation"("tontineId", "empreinte");
ALTER TABLE "TontineInvitation" ADD CONSTRAINT "TontineInvitation_tontineId_fkey" FOREIGN KEY ("tontineId") REFERENCES "Tontine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
