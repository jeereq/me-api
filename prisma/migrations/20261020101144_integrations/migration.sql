-- CreateEnum
CREATE TYPE "Fournisseur" AS ENUM ('GOOGLE', 'MICROSOFT', 'TRELLO', 'SLACK');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "fuseau" TEXT NOT NULL DEFAULT 'UTC';

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fournisseur" "Fournisseur" NOT NULL,
    "compte" TEXT NOT NULL,
    "ctx" TEXT NOT NULL DEFAULT 'perso',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "donnees" JSONB,
    "derniereSync" TIMESTAMP(3),
    "erreur" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Integration_userId_idx" ON "Integration"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_userId_fournisseur_compte_key" ON "Integration"("userId", "fournisseur", "compte");

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
