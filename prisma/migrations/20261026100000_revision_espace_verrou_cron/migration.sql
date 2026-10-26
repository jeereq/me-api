-- Version de l'espace : sert à détecter qu'un autre appareil a écrit entre-temps.
ALTER TABLE "Espace" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- Verrou des tâches planifiées (une seule instance à la fois).
CREATE TABLE "VerrouCron" (
    "nom" TEXT NOT NULL,
    "porteur" TEXT NOT NULL,
    "jusqua" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerrouCron_pkey" PRIMARY KEY ("nom")
);
