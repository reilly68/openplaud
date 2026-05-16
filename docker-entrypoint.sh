#!/bin/sh
set -e

echo "🚀 Starting OpenPlaud..."

echo "⏳ Running database migrations..."
bun migrate-idempotent.js

echo "🔄 Starting auto-process worker..."
bun autoprocess.ts &

echo "🚀 Starting application..."
exec "$@"
