-- Petites valeurs propres au serveur : l'identifiant de la voix d'Eve, créée une seule fois chez ElevenLabs.
CREATE TABLE "ReglageServeur" (
    "cle" TEXT NOT NULL,
    "valeur" TEXT NOT NULL,
    "majLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReglageServeur_pkey" PRIMARY KEY ("cle")
);
