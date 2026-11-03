-- Caractères lus par Eve, par jour : la synthèse vocale se paie au caractère. « cle » : un compte, ou « essai » pour la page d'accueil.
CREATE TABLE "UsageVoix" (
    "cle" TEXT NOT NULL,
    "jour" TEXT NOT NULL,
    "caracteres" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageVoix_pkey" PRIMARY KEY ("cle","jour")
);
