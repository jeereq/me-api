-- Un compte peut être créé avec son seul numéro de téléphone. L'index unique reste : PostgreSQL y admet plusieurs NULL.
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
