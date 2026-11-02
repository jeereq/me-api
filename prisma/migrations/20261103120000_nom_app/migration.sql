-- Nom de l'app choisi par l'utilisateur (vide = « Me »).
ALTER TABLE "User" ADD COLUMN "nomApp" TEXT NOT NULL DEFAULT '';
