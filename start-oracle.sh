#!/bin/bash
# Start the Oracle test server in Docker.
# Uses gvenzl/oracle-xe (no Oracle license required) on port 21521 to avoid
# conflicts with any local Oracle instance.  gvenzl auto-creates the APP_USER
# (bookstore) in its own schema inside the XEPDB1 pluggable database.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Support both the `docker compose` plugin (v2) and the standalone
# `docker-compose` binary, whichever is installed.
if docker compose version >/dev/null 2>&1; then
	COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
	COMPOSE="docker-compose"
else
	echo "ERROR: neither 'docker compose' nor 'docker-compose' is available."
	exit 1
fi

echo "Starting Oracle test server on port 21521 (first boot pulls the image and initializes the DB; this can take several minutes)..."
${COMPOSE} -f "${SCRIPT_DIR}/docker-compose.yml" up -d

echo "Waiting for Oracle to accept connections (gvenzl healthcheck)..."
# Probe with gvenzl's own readiness script rather than the container's HEALTHCHECK
# status — first-boot DB creation can take many minutes (longer still under
# emulation), and the healthcheck.sh probe is the authoritative readiness signal.
ATTEMPTS=0
MAX_ATTEMPTS=240
until docker exec meadow-connection-oracle-test healthcheck.sh >/dev/null 2>&1; do
	ATTEMPTS=$((ATTEMPTS + 1))
	if [ "${ATTEMPTS}" -ge "${MAX_ATTEMPTS}" ]; then
		echo "ERROR: Oracle did not become ready in time."
		docker logs --tail 50 meadow-connection-oracle-test
		exit 1
	fi
	sleep 5
done

echo ""
echo "Oracle test server is ready on port 21521"
echo "  Host:        127.0.0.1"
echo "  Port:        21521"
echo "  Service:     FREEPDB1"
echo "  User:        bookstore"
echo "  Password:    Retold1234567890!"
echo "  SYS/SYSTEM:  Retold1234567890!"
