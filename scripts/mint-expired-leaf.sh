#!/usr/bin/env bash
#
# Mint the TLS-floor S6 fixture pair: two client leaves that differ in exactly
# one field — notAfter.
#
# WHY THIS SCRIPT EXISTS. An expired certificate is the one broken credential
# that cannot be obtained the way a revoked one can. Revocation is an ACTION
# somebody with the right permission performs on a live server; expiry is the
# passage of time. The server signs 365-day leaves and exposes no short-dated or
# backdated issuance route, and the earliest notAfter anywhere in this repo's
# fixture corpus is 2027-03-24 — so there is nothing to wait for and nothing to
# ask for. The only way to hold an expired leaf is to sign one.
#
# Signing one is possible ONLY against the local stack, and only because the dev
# Station CA private key sits on the developer's own disk at
# csms-server/storage/keys/station-ca-key.pem — the same CA the local broker
# trusts as its client-cert anchor (/opt/emqx/etc/certs/ca.pem). Verify that
# equality before trusting any refusal this fixture produces:
#
#   openssl x509 -in "$CA_CERT" -noout -fingerprint -sha256
#   docker exec csms-emqx sh -c 'openssl crl2pkcs7 -nocrl -certfile \
#     /opt/emqx/etc/certs/ca.pem | openssl pkcs7 -print_certs' \
#     | awk '/Station CA/,0' | openssl x509 -noout -fingerprint -sha256
#
# If those differ the fixture is from a foreign hierarchy and the broker will
# refuse it for `unknown ca` — which classifies as broker-bad-certificate, so
# S6 fails rather than passing for the wrong reason. That is deliberate: the
# whole point of giving expiry its own refusal reason is that the untrusted-chain
# refusal must never be able to satisfy an expiry proof.
#
# THE PAIR IS THE PROOF. Both leaves get the same CA, the same key type, the
# same extension profile (CA:FALSE / clientAuth / SAN / CRLDP, matching what the
# local server issues) and the same notBefore. Only notAfter differs: 2025 for
# the expired one, 2034 for the control. So "refused" vs "connected" cannot be
# attributed to anything else. Run them as a pair or neither means much.
#
# Usage:  ./scripts/mint-expired-leaf.sh [output-dir]     (default: certs/local)
#
set -euo pipefail

OUT_DIR="${1:-certs/local}"
CA_DIR="${OSPP_SERVER_KEYS_DIR:-$HOME/dev/projects/osp/csms-server/storage/keys}"
CA_CERT="$CA_DIR/station-ca-cert.pem"
CA_KEY="$CA_DIR/station-ca-key.pem"
ROOT_CERT="$CA_DIR/root-ca-cert.pem"
CRL_URI="${OSPP_LOCAL_CRL_URI:-http://localhost:8080/pki/station-ca.crl}"

EXPIRED_ID="stn_e0000001"
CONTROL_ID="stn_e0000002"

for f in "$CA_CERT" "$CA_KEY" "$ROOT_CERT"; do
  if [ ! -r "$f" ]; then
    echo "mint-expired-leaf: cannot read $f" >&2
    echo "  Set OSPP_SERVER_KEYS_DIR to the csms-server storage/keys directory." >&2
    exit 1
  fi
done

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/db"
: > "$WORK/db/index.txt"
echo 1000 > "$WORK/db/serial"

emit_conf() {
  cat > "$WORK/ca.cnf" <<EOF
[ca]
default_ca = CA_default
[CA_default]
dir = $WORK
database = $WORK/db/index.txt
serial = $WORK/db/serial
new_certs_dir = $WORK/db
certificate = $CA_CERT
private_key = $CA_KEY
default_md = sha256
policy = pol
email_in_dn = no
unique_subject = no
copy_extensions = none
[pol]
commonName = supplied
[leaf_$1]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation,digitalSignature,keyEncipherment
extendedKeyUsage = clientAuth
subjectAltName = DNS:$1
crlDistributionPoints = URI:$CRL_URI
EOF
}

# notBefore is IDENTICAL for both; only notAfter moves. Backdating both is what
# keeps the pair a one-variable experiment — a control minted "today" would
# differ in issuance date as well as in validity.
mint() { # <stationId> <enddate>
  local id="$1" enddate="$2"
  emit_conf "$id"
  openssl ecparam -name prime256v1 -genkey -noout -out "$OUT_DIR/$id-key.pem"
  chmod 600 "$OUT_DIR/$id-key.pem"
  openssl req -new -key "$OUT_DIR/$id-key.pem" -subj "/CN=$id" -out "$WORK/$id.csr"
  openssl ca -batch -config "$WORK/ca.cnf" -extensions "leaf_$id" \
    -startdate 20240101000000Z -enddate "$enddate" \
    -in "$WORK/$id.csr" -out "$WORK/$id.raw" 2>/dev/null
  # `openssl ca` prefixes the PEM with a text dump; keep the certificate only.
  openssl x509 -in "$WORK/$id.raw" -out "$OUT_DIR/$id.pem"
  cat "$CA_CERT" "$ROOT_CERT" > "$OUT_DIR/$id-chain.pem"
}

mint "$EXPIRED_ID" 20250101000000Z   # EXPIRED — notAfter in the past
mint "$CONTROL_ID" 20340101000000Z   # control — same everything, valid

echo "Minted into $OUT_DIR:"
for id in "$EXPIRED_ID" "$CONTROL_ID"; do
  printf '  %s  ' "$id"
  openssl x509 -in "$OUT_DIR/$id.pem" -noout -enddate
done
echo
echo "Now run the pair (both, or neither proves anything):"
echo "  npm run build"
echo "  node dist/cli/index.js run --scenario scenarios/tls-floor/s6-rejects-expired-cert.yaml --target local-mtls"
echo "  node dist/cli/index.js run --scenario scenarios/tls-floor/s6b-accepts-unexpired-cert.yaml --target local-mtls"
