#!/usr/bin/env bash
#
# Mint the TLS-floor S5 fixture: a client leaf whose ONLY defect is that its
# serial has been revoked on UAT.
#
# WHY THIS SCRIPT EXISTS, and why it is the opposite of mint-expired-leaf.sh.
# An expired leaf has to be SIGNED, because expiry is the passage of time and no
# route issues a short-dated certificate. A revoked leaf is the other way round:
# revocation is an ACTION on a live server, so the fixture is made by asking the
# server to perform it, and nothing here signs anything. What cannot be obtained
# a second time is the PRIVATE KEY — the server hands it over exactly once, at
# provisioning, and `certs/` is gitignored in full. The previous fixture
# (`stn_985c8a8b`, serial 012C, revoked 2026-07-23) was lost that way, and S5 was
# the corpus's only inconclusive result from 2026-08-13 until 2026-09-22.
#
# WHAT IT LEAVES ON UAT, DELIBERATELY. The certificate row. ADR-0005 invariant 7
# (csms-server 2026_07_23_000001_guard_revoked_certificate_deletion.php) refuses
# to delete a certificate while `status='revoked' AND expires_at > now()`, because
# `CertificateRevocationRepository::revokedSerials()` reads that table and nothing
# else — the row IS the CRL entry, and deleting it would silently un-revoke the
# holder. Everything else this script creates is torn down: the station, its bays,
# the location, the organization and the run identities. A kept certificate needs
# none of them (`certificates` has zero outbound foreign keys).
#
# UAT ONLY. Every remote command names the UAT stack; nothing here touches prod.
#
# Usage:  scripts/mint-revoked-fixture.sh
# Needs:  ~/.config/osp-e2e-secrets.env  (UAT_E2E_PLATFORM_ADMIN_EMAIL/PASSWORD)
#         ssh access to the UAT host, and `npm run build` already done.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

UAT_HOST="${UAT_SSH_HOST_PLAIN:-89.33.25.117}"
API="${UAT_API_URL:-https://api-uat.onestoppay.ro}"
FIXTURE="certs/uat/revoked-fixture"

# The three paths S5 names. Refuse to clobber a fixture that is still good, so a
# stray run cannot cost the suite its only revoked leaf.
if [ -f "${FIXTURE}.pem" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "A fixture already exists at ${FIXTURE}.pem. Check it first:" >&2
  openssl x509 -in "${FIXTURE}.pem" -noout -serial -subject -dates >&2
  echo "Re-mint anyway with FORCE=1 $0" >&2
  exit 1
fi

set -a; . "$HOME/.config/osp-e2e-secrets.env"; set +a
export UAT_EMAIL="${UAT_E2E_PLATFORM_ADMIN_EMAIL}"
export UAT_PASSWORD="${UAT_E2E_PLATFORM_ADMIN_PASSWORD}"
export OSPP_PROTOCOL_VERSION="${OSPP_PROTOCOL_VERSION:-0.3.0}"

echo "== 1. bootstrap a one-station pool (kept, so the certificate material survives the run)"
node dist/cli/index.js run --scenario scenarios/core/happy-boot.yaml \
  --bootstrap-pool --pool-size 1 --keep-pool --target uat >/dev/null

HANDLE="tests/artifacts/pool-handle.json"
STATION="$(python3 -c "import json;print(json.load(open('$HANDLE'))['stationIds'][0])")"
IDENT="$(python3 -c "import json;print(json.load(open('$HANDLE'))['identityCredentials'][0]['email'])")"
PW="$(python3 -c "import json;print(json.load(open('$HANDLE'))['identityCredentials'][0]['password'])")"
echo "   station=$STATION  identity=$IDENT"

echo "== 2. copy the leaf, key and chain OUT of the run's own paths"
# The teardown removes exactly the paths the handle lists, so the fixture must not
# be one of them. Copied, never moved: the run still owns its originals.
cp "certs/uat/${STATION}.pem"       "${FIXTURE}.pem"
cp "certs/uat/${STATION}-key.pem"   "${FIXTURE}-key.pem"
cp "certs/uat/${STATION}-chain.pem" "${FIXTURE}-chain.pem"
chmod 600 "${FIXTURE}-key.pem"
SERIAL_HEX="$(openssl x509 -in "${FIXTURE}.pem" -noout -serial | cut -d= -f2)"
NOT_AFTER="$(openssl x509 -in "${FIXTURE}.pem" -noout -enddate | cut -d= -f2)"
echo "   serial=$SERIAL_HEX  notAfter=$NOT_AFTER"

echo "== 3. grant the revocation permission to the run identity"
# `platform.certificates.revoke` is held by ONE role of nine, platform_super_admin,
# and the standing e2e platform admin is platform_admin and does NOT hold it.
# Granted to a run-scoped identity so the pool teardown sweeps the binding with the user.
ssh -o BatchMode=yes "$UAT_HOST" \
  "docker exec csms-app-uat php artisan ospp:assign-platform-role '$IDENT' platform_super_admin" </dev/null

echo "== 4. revoke through the server's own route"
TOKEN="$(curl -sS -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
  -H 'Accept: application/json' -d "{\"email\":\"$IDENT\",\"password\":\"$PW\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['access_token'])")"
curl -sS -X POST "$API/api/v1/admin/stations/${STATION}/revoke-certificate" \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"reason":"revoked-certificate fixture for TLS floor S5"}'
echo

echo "== 5. confirm the serial on the SERVED CRL, with a control"
CRL="$(mktemp)"; trap 'rm -f "$CRL"' EXIT
curl -sS "$API/pki/station-ca.crl" -o "$CRL"
TEXT="$(openssl crl -inform DER -in "$CRL" -noout -text)"
if ! grep -q "Serial Number: ${SERIAL_HEX}" <<<"$TEXT"; then
  echo "FIXTURE NOT USABLE: serial $SERIAL_HEX is absent from the served CRL" >&2
  exit 1
fi
# A list that contains everything proves nothing. The station's own PREVIOUS serial
# is not revoked, so it must be absent.
PREV_HEX="$(printf '%04X' $(( 16#${SERIAL_HEX} - 1 )))"
echo "   listed: $(grep -c 'Serial Number:' <<<"$TEXT") serial(s); ${SERIAL_HEX} present; control ${PREV_HEX} present=$(grep -c "Serial Number: ${PREV_HEX}" <<<"$TEXT")"

echo "== 6. tear the pool down — station, bays, location, org and identities go; the certificate stays"
node dist/cli/index.js teardown-pool

cat > "${FIXTURE}.txt" <<EOF
TLS-floor S5 fixture — a leaf whose only defect is revocation.
station     ${STATION}
serial      ${SERIAL_HEX}
notAfter    ${NOT_AFTER}
revoked     through POST /api/v1/admin/stations/${STATION}/revoke-certificate
minted      $(date -u +%Y-%m-%dT%H:%M:%SZ)
The certificate row stays on UAT until notAfter: ADR-0005 invariant 7 forbids deleting a
revoked unexpired certificate, because it is the CRL's source of truth. Everything else
this fixture created has been torn down.
EOF
echo "== done. ${FIXTURE}.pem / -key.pem / -chain.pem written; provenance in ${FIXTURE}.txt"
