#!/bin/sh
# Runs pending Prisma migrations against DATABASE_URL before the app starts.
# Safe for a single-instance deploy (starter-business scale); if you ever run
# more than one backend instance at once, move this to a separate one-off
# deploy step instead so two instances don't race to migrate at the same time.
set -e

echo "Running database migrations..."
npx prisma migrate deploy

echo "Starting PAYDER backend..."
exec "$@"
