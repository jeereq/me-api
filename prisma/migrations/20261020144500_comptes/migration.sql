-- CreateEnum
CREATE TYPE "TypeJeton" AS ENUM ('VERIFICATION', 'REINITIALISATION', 'CONNEXION');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifie" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "googleId" TEXT,
ADD COLUMN     "motDePasseLe" TIMESTAMP(3),
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- Les comptes déjà créés restent utilisables : ils sont considérés comme confirmés.
UPDATE "User" SET "emailVerifie" = true;

-- CreateTable
CREATE TABLE "JetonCompte" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TypeJeton" NOT NULL,
    "empreinte" TEXT NOT NULL,
    "expireLe" TIMESTAMP(3) NOT NULL,
    "utiliseLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JetonCompte_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JetonCompte_empreinte_key" ON "JetonCompte"("empreinte");

-- CreateIndex
CREATE INDEX "JetonCompte_userId_type_idx" ON "JetonCompte"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- AddForeignKey
ALTER TABLE "JetonCompte" ADD CONSTRAINT "JetonCompte_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

