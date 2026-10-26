-- Ce qu'un compte a le droit de faire dans une équipe.
CREATE TYPE "RoleEquipe" AS ENUM ('PROPRIETAIRE', 'MEMBRE', 'LECTEUR');

-- CreateTable
CREATE TABLE "Equipe" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '👥',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Equipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipeMembre" (
    "id" TEXT NOT NULL,
    "equipeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RoleEquipe" NOT NULL DEFAULT 'MEMBRE',
    "depuisLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipeMembre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvitationEquipe" (
    "id" TEXT NOT NULL,
    "equipeId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "RoleEquipe" NOT NULL DEFAULT 'MEMBRE',
    "empreinte" TEXT NOT NULL,
    "parNom" TEXT NOT NULL DEFAULT '',
    "expireLe" TIMESTAMP(3) NOT NULL,
    "utiliseLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvitationEquipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EspaceEquipe" (
    "equipeId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "majLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EspaceEquipe_pkey" PRIMARY KEY ("equipeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "EquipeMembre_equipeId_userId_key" ON "EquipeMembre"("equipeId", "userId");

-- CreateIndex
CREATE INDEX "EquipeMembre_userId_idx" ON "EquipeMembre"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "InvitationEquipe_empreinte_key" ON "InvitationEquipe"("empreinte");

-- CreateIndex
CREATE INDEX "InvitationEquipe_equipeId_idx" ON "InvitationEquipe"("equipeId");

-- CreateIndex
CREATE INDEX "InvitationEquipe_email_idx" ON "InvitationEquipe"("email");

-- AddForeignKey
ALTER TABLE "EquipeMembre" ADD CONSTRAINT "EquipeMembre_equipeId_fkey" FOREIGN KEY ("equipeId") REFERENCES "Equipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipeMembre" ADD CONSTRAINT "EquipeMembre_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvitationEquipe" ADD CONSTRAINT "InvitationEquipe_equipeId_fkey" FOREIGN KEY ("equipeId") REFERENCES "Equipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EspaceEquipe" ADD CONSTRAINT "EspaceEquipe_equipeId_fkey" FOREIGN KEY ("equipeId") REFERENCES "Equipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
