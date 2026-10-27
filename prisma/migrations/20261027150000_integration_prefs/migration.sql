-- Réglages propres à un compte connecté : agendas choisis pour la synchronisation.
ALTER TABLE "Integration" ADD COLUMN "prefs" JSONB;
