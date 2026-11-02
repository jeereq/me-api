-- Rappels par SMS : numéro vérifié du compte, vérification en cours, et historique des envois (date et état, sans le texte).
ALTER TABLE "User" ADD COLUMN "telephone" TEXT;
ALTER TABLE "User" ADD COLUMN "telephoneEnAttente" TEXT;
ALTER TABLE "User" ADD COLUMN "smsVerificationId" TEXT;
ALTER TABLE "User" ADD COLUMN "smsVerificationLe" TIMESTAMP(3);

CREATE TABLE "EnvoiSms" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'soumis',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvoiSms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EnvoiSms_userId_createdAt_idx" ON "EnvoiSms"("userId", "createdAt");

ALTER TABLE "EnvoiSms" ADD CONSTRAINT "EnvoiSms_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
