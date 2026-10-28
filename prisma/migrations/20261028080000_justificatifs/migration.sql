-- CreateTable
CREATE TABLE "Justificatif" (
    "publicId" TEXT NOT NULL,
    "genre" TEXT NOT NULL DEFAULT 'image',
    "userId" TEXT NOT NULL,
    "equipeId" TEXT,
    "verifieLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Justificatif_pkey" PRIMARY KEY ("publicId")
);

-- CreateIndex
CREATE INDEX "Justificatif_userId_idx" ON "Justificatif"("userId");

-- CreateIndex
CREATE INDEX "Justificatif_equipeId_idx" ON "Justificatif"("equipeId");

-- CreateIndex
CREATE INDEX "Justificatif_createdAt_idx" ON "Justificatif"("createdAt");
