-- L'initiateur demande le versement de la cagnotte.
ALTER TABLE "TontineTour" ADD COLUMN "versementDemandeLe" TIMESTAMP(3);
ALTER TABLE "TontineTour" ADD COLUMN "versementDemandes" INTEGER NOT NULL DEFAULT 0;
