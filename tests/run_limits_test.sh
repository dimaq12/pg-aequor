#!/bin/bash
set -e

CONTAINER_NAME="pg-aequor-limit-test"
DB_PORT=5435  # Use distinct port
DB_USER="postgres"
DB_PASS="mysecretpassword"
DB_NAME="limittest"

echo "=== Setting up Local Postgres for Limit Test ==="

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  docker stop "$CONTAINER_NAME" >/dev/null
  docker rm "$CONTAINER_NAME" >/dev/null
fi

# Use default config (max_connections=100)
docker run --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD="$DB_PASS" \
  -p "$DB_PORT":5432 \
  -d postgres:15-alpine >/dev/null

echo "Waiting for Postgres..."
until docker exec "$CONTAINER_NAME" pg_isready -U "$DB_USER" >/dev/null 2>&1; do
  sleep 1
done
sleep 2

echo "Creating database '$DB_NAME'..."
docker exec "$CONTAINER_NAME" createdb -U "$DB_USER" "$DB_NAME"

export DB_CONN_STRING="postgresql://$DB_USER:$DB_PASS@localhost:$DB_PORT/$DB_NAME"
echo "Running Limit Simulation..."

if [ ! -d "node_modules/pg" ]; then
    npm install pg --no-save
fi

node tests/simulation_limits.js

# echo "Cleaning up..."
# docker stop "$CONTAINER_NAME" && docker rm "$CONTAINER_NAME"

echo "=== Limit Test Completed ==="

