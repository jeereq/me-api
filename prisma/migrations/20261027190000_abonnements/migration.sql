-- Abonnements : essai Pro, période Pro prépayée, acceptation des CGV et paiements FlexPaie.
ALTER TABLE "User" ADD COLUMN "essaiJusqua" TIMESTAMP(3),
ADD COLUMN "abonnementPeriode" TEXT,
ADD COLUMN "abonnementFinLe" TIMESTAMP(3),
ADD COLUMN "cgvAccepteesLe" TIMESTAMP(3),
ADD COLUMN "cgvVersion" TEXT;

-- Les comptes existants commencent leur essai de 14 jours aujourd'hui : personne ne perd l'accès d'un coup.
UPDATE "User" SET "essaiJusqua" = NOW() + INTERVAL '14 days';

CREATE TABLE "Paiement" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "reference" TEXT NOT NULL,
    "periode" TEXT NOT NULL,
    "montant" INTEGER NOT NULL,
    "devise" TEXT NOT NULL,
    "telephone" TEXT NOT NULL DEFAULT '',
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "commande" TEXT,
    "message" TEXT,
    "payeLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Paiement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Paiement_reference_key" ON "Paiement"("reference");
CREATE INDEX "Paiement_userId_createdAt_idx" ON "Paiement"("userId", "createdAt");

ALTER TABLE "Paiement" ADD CONSTRAINT "Paiement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
