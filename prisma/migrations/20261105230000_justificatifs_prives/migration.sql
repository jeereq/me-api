-- Les justificatifs déjà déposés restent publics ("upload") jusqu'à leur passage en privé ; les nouveaux sont privés.
ALTER TABLE "Justificatif" ADD COLUMN "acces" TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE "Justificatif" ADD COLUMN "format" TEXT;
