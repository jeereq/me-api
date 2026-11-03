-- Hors RD Congo, seuls les numéros ouverts par un admin sont acceptés : un pays entier (numero vide) ou un seul numéro.
CREATE TABLE "NumeroAutorise" (
    "id" TEXT NOT NULL,
    "indicatif" TEXT NOT NULL,
    "numero" TEXT NOT NULL DEFAULT '',
    "parNom" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NumeroAutorise_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NumeroAutorise_indicatif_numero_key" ON "NumeroAutorise"("indicatif", "numero");
