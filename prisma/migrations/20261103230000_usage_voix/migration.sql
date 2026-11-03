-- Caractères lus par Eve, par jour : la synthèse vocale se paie au caractère. « cle » : un compte, ou « essai » pour la page d'accueil.
CREATE TABLE "UsageVoix" (
    "cle" TEXT NOT NULL,
    "jour" TEXT NOT NULL,
    "caracteres" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageVoix_pkey" PRIMARY KEY ("cle","jour")
);

-- Petites valeurs propres au serveur : l'identifiant de la voix d'Eve, créée une seule fois chez ElevenLabs.
CREATE TABLE "ReglageServeur" (
    "cle" TEXT NOT NULL,
    "valeur" TEXT NOT NULL,
    "majLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReglageServeur_pkey" PRIMARY KEY ("cle")
);
