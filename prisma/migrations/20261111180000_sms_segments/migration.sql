-- Les SMS facturés par envoi : un SMS long en compte plusieurs, et le forfait mensuel se compte en segments.
ALTER TABLE "EnvoiSms" ADD COLUMN "segments" INTEGER NOT NULL DEFAULT 1;
-- Pour compter vite les segments d'un compte sur une période.
CREATE INDEX IF NOT EXISTS "EnvoiSms_userId_genre_createdAt_idx" ON "EnvoiSms"("userId", "genre", "createdAt");
