#!/usr/bin/env bash
# Sauvegarde compressée de la base : ./scripts/sauvegarde.sh [dossier]
# Lit DATABASE_URL dans l'environnement ou dans .env. Garde les 14 sauvegardes les plus récentes.
# Restauration : pg_restore --clean --if-exists -d "$DATABASE_URL" fichier.dump
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
fi
: "${DATABASE_URL:?DATABASE_URL manquant (environnement ou fichier .env)}"

dossier="${1:-sauvegardes}"
mkdir -p "$dossier"
# Le paramètre ?schema=... de Prisma n'est pas compris par pg_dump.
url="${DATABASE_URL%%\?*}"
fichier="$dossier/me-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump --format=custom --no-owner --file "$fichier" "$url"
echo "Sauvegarde écrite : $fichier ($(du -h "$fichier" | cut -f1))"

# Rotation : ne garde que les 14 plus récentes.
ls -1t "$dossier"/me-*.dump | tail -n +15 | while read -r vieux; do rm -f -- "$vieux"; done
