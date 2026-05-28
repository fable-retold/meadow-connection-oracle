#!/bin/bash
# Stop and remove the Oracle test server (including its data volume).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if docker compose version >/dev/null 2>&1; then
	COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
	COMPOSE="docker-compose"
else
	echo "ERROR: neither 'docker compose' nor 'docker-compose' is available."
	exit 1
fi

echo "Stopping Oracle test server..."
${COMPOSE} -f "${SCRIPT_DIR}/docker-compose.yml" down -v
echo "Oracle test server stopped."
