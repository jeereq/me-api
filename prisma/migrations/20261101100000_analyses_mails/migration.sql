-- CreateTable
CREATE TABLE "AnalyseMail" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "mailId" TEXT NOT NULL,
    "empreinte" TEXT NOT NULL,
    "modele" TEXT NOT NULL,
    "resultat" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "majLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyseMail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyseMail_userId_idx" ON "AnalyseMail"("userId");

-- CreateIndex
CREATE INDEX "AnalyseMail_majLe_idx" ON "AnalyseMail"("majLe");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyseMail_integrationId_mailId_key" ON "AnalyseMail"("integrationId", "mailId");

-- AddForeignKey
ALTER TABLE "AnalyseMail" ADD CONSTRAINT "AnalyseMail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyseMail" ADD CONSTRAINT "AnalyseMail_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
