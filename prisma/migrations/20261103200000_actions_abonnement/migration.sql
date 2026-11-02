-- Journal des gestes de l'admin sur les abonnements : formule offerte ou retirée, essai prolongé.
CREATE TABLE "ActionAbonnement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parNom" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "formule" TEXT,
    "palier" INTEGER NOT NULL DEFAULT 0,
    "duree" TEXT,
    "finApres" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionAbonnement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActionAbonnement_userId_createdAt_idx" ON "ActionAbonnement"("userId", "createdAt");

ALTER TABLE "ActionAbonnement" ADD CONSTRAINT "ActionAbonnement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
