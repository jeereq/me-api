-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'UTILISATEUR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "nom" TEXT NOT NULL DEFAULT '',
    "role" "Role" NOT NULL DEFAULT 'UTILISATEUR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Espace" (
    "userId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "majLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Espace_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "majLe" TIMESTAMP(3) NOT NULL,
    "majPar" TEXT,

    CONSTRAINT "Config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "Espace" ADD CONSTRAINT "Espace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
