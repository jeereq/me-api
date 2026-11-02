-- Trois formules (Gratuit, Finances, Pro) : la formule payée, sur le compte et sur chaque paiement.
ALTER TABLE "User" ADD COLUMN "abonnementFormule" TEXT;

ALTER TABLE "Paiement" ADD COLUMN "formule" TEXT NOT NULL DEFAULT 'pro';
