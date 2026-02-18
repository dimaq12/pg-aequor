#!/bin/bash
set -e

CONTAINER_NAME="pg-aequor-load-test"
DB_PORT=5433  # Use non-standard port to avoid conflicts
DB_USER="postgres"
DB_PASS="mysecretpassword"
DB_NAME="loadtest"

echo "=== Setting up Local Postgres for Load Test ==="

# 1. Cleanup old container if exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Stopping and removing existing container..."
  docker stop "$CONTAINER_NAME" >/dev/null
  docker rm "$CONTAINER_NAME" >/dev/null
fi

# 2. Start new container
echo "Starting Postgres container on port $DB_PORT..."
docker run --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD="$DB_PASS" \
  -p "$DB_PORT":5432 \
  -d postgres:15-alpine >/dev/null

# 3. Wait for DB to be ready
echo "Waiting for Postgres to be ready..."
until docker exec "$CONTAINER_NAME" pg_isready -U "$DB_USER" >/dev/null 2>&1; do
  sleep 1
done
sleep 2 # Extra safety buffer

# 4. Create Database
echo "Creating database '$DB_NAME'..."
docker exec "$CONTAINER_NAME" createdb -U "$DB_USER" "$DB_NAME"

# 5. Run Simulation
export DB_CONN_STRING="postgresql://$DB_USER:$DB_PASS@localhost:$DB_PORT/$DB_NAME"
echo "Running Load Test Simulation..."
echo "Connection String: $DB_CONN_STRING"

# Install dependencies if needed (pg)
if [ ! -d "node_modules/pg" ]; then
    echo "Installing 'pg' dependency for test..."
    npm install pg --no-save
fi

node tests/simulation.js

# 6. Cleanup (Optional, commented out to inspect if failed)
# echo "Cleaning up..."
# docker stop "$CONTAINER_NAME" && docker rm "$CONTAINER_NAME"

echo "=== Load Test Completed ==="

