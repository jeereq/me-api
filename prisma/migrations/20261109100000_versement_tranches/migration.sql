-- Versement en plusieurs tranches : plusieurs versements par tour, un seul en cours à la fois.
DROP INDEX IF EXISTS "TontineMouvement_un_versement";
CREATE UNIQUE INDEX "TontineMouvement_un_versement_en_cours" ON "TontineMouvement"("tourId") WHERE "genre" = 'versement' AND "statut" = 'en_attente';
ALTER TABLE "Tontine" ADD COLUMN "trancheDemandeLe" TIMESTAMP(3);
