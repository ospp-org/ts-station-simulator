# Running the scenario suite against the LOCAL stack

Sibling of [`RUNNING-AGAINST-UAT.md`](RUNNING-AGAINST-UAT.md), and it exists for the same
reason: on 2026-08-25 a single local run hit **six** blockers in a row, none of them a defect
in this repo or in `csms-server`, and every one cost time to attribute. They fire **in
order** — clearing one only reveals the next — so the list is worth more than any one entry.

Everything below was measured that day, against `csms-server` at `0e9f871a` with
`@ospp/protocol 0.26.0` installed here.

## Why bother with local at all

`scripts/deploy-uat.sh` is `git pull origin master --ff-only`, so UAT can only ever run code
that is already on trunk **and** already deployed. The local stack **bind-mounts the working
tree** (`/home/gabi/dev/projects/osp/csms-server → /var/www/html`), so it runs the code under
test with no deploy. "Prove it on the wire" and "do not deploy" are only both satisfiable
here.

What it does **not** prove: same CODE, not the same DEPLOYMENT — no image bake, no nginx
edge, no supervisord consumer, no public-CA broker cert.

---

## The six blockers, in the order they fire

### 1. Target `local` is dead — use `local-mtls`

`listeners.tcp.default { enabled = false }` on `csms-emqx`. Plaintext 1883 answers
`Error: Connection closed` in ~30 ms, which reads like a crash and is a disabled listener.
The dev broker runs `verify_peer` + `peer_cert_as_username` like prod, so `local-mtls` is the
only local target that can connect at all.

### 2. `certs/local/stn_e0000001.pem` is EXPIRED ON PURPOSE

`notAfter = 2025-01-01`. It is the **S6 refusal fixture** — the leaf whose whole job is to be
rejected. Picking it for an unrelated run gives
`tls alert certificate expired … SSL alert number 45`, which reads as a broken local CA.

Check before choosing a station:

```bash
cd certs/local && for f in stn_*.pem; do
  case "$f" in *-key.pem|*-chain.pem|*receipt*) continue;; esac
  openssl x509 -in "$f" -noout -checkend 0 >/dev/null 2>&1 \
    && echo "VALID   $f" || echo "EXPIRED $f"
done
```

Valid at the time of writing: `stn_b222c63b`, `stn_e0000002`, `stn_e26b94f3`.

### 3. `OSPP_PROTOCOL_VERSION=0.2.1` is mandatory

The local server pins `OSPP_PROTOCOL_VERSION=0.2.1` (`csms-server/.env:65`) and negotiation is
**exact match**, so an unset env means every boot is refused **`1007
PROTOCOL_VERSION_MISMATCH — Unsupported version: 0.3.0`**, logged server-side as the far less
helpful `Protocol: invalid message`.

`resolveWireProtocolVersion()` (`src/mqtt/protocolVersion.ts`) exists for exactly this and
its docblock says so: *"The env remains an override for talking to a server pinned
elsewhere."*

**This is not a bump artefact.** `OSPP_PROTOCOL_VERSION` is `'0.3.0'` in `@ospp/protocol` at
**both** `v0.23.0` and `v0.26.0` — verified at both tags — so no SDK bump causes it and none
fixes it. It is a property of the local server's configuration.

### 4. The dev database is empty again — re-seed it

The container test suite **truncates the dev database** as part of its normal run, so a stack
that worked yesterday has no users today. Past blocker 3 the symptom is
`BootNotification: station not registered`.

```bash
docker exec -w /var/www/html csms-app php artisan db:seed --class=RolesAndPermissionsSeeder --force
docker exec -w /var/www/html csms-app php artisan db:seed --class=UserSeeder --force
docker exec csms-postgres psql -U csms -d csms -c "
INSERT INTO model_has_roles (role_id, model_type, model_id)
SELECT r.id, 'App\\Modules\\Auth\\Models\\User', u.id
FROM roles r, users u
WHERE r.name='platform_super_admin' AND u.email='admin@csms.local'
ON CONFLICT DO NOTHING;"
```

There is no `tinker` in that image. Verify with a login, not by reading the table:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@csms.local","password":"password"}'   # expect 200
```

### 5. `PUT /admin/stations/{id}/catalog` is a RETIRED door — 404

`csms-server` removed the legacy catalog push at `bf35637`. `artisan route:list --path=catalog`
returns **exactly one** row today: `POST /api/v1/admin/stations/{stationId}/catalog/publish`,
which takes **no body**.

`scenarios/device-management/service-catalog-update.yaml` called the retired route and 404'd.
**Fixed 2026-08-25** — it is on the publish door now, like the three `e2e/*` parcours. Kept in
this list because the failure mode is the instructive part: a corpus that lags a server change
fails on the next deploy and looks like the deploy broke it.

### 6. Publish is `catalog.manage`, and the pool identity does not have it

`--bootstrap-pool` hands a scenario with no `auth:` block a **`tenant_operator`** — "the
principled non-owner role" (`src/scenarios/bootstrap/uatPrivileged.ts:678`). Measured against
the seeded role table:

| | `catalog.manage` |
|---|---|
| `platform_super_admin`, `tenant_admin`, `tenant_owner` | yes |
| `tenant_operator` | **no catalog permission at all** |

So publish as a pool identity is **403 "This action is unauthorized"**. That refusal is a
decision, not an obstacle — `csms-server` binds it to owner+admin because "which prices and
programs a station starts selling under is the settlement-critical decision D-RBAC".

The pool **does** mint an ephemeral `tenant_owner`, but its password never leaves
`PoolBootstrap` and no scenario can ask for it, so *running as the pool owner would need a
runner change*. What works today is declaring the identity in the file, the same mechanism the
`e2e/*` scenarios use:

```yaml
auth:
  email_env: UAT_E2E_PLATFORM_ADMIN_EMAIL
  password_env: UAT_E2E_PLATFORM_ADMIN_PASSWORD
```

A `platform_super_admin` is NULL-scoped and a member of no organisation, which is the case
`StationPolicy::checkTenantPermission` admits through its platform-tier override: the
station's org resolves, membership fails, the NULL-team grant carries it. No header, no SQL,
no role edit.

---

## The working invocation

```bash
export UAT_E2E_PLATFORM_ADMIN_EMAIL=admin@csms.local
export UAT_E2E_PLATFORM_ADMIN_PASSWORD=password
export OSPP_PROTOCOL_VERSION=0.2.1
export UAT_SSH_HOST=local UAT_DB_CONTAINER=csms-postgres UAT_DB_USER=csms UAT_DB_NAME=csms

npx simulator run \
  --scenario scenarios/device-management/service-catalog-update.yaml \
  --target local-mtls --bootstrap-pool --pool-size 1 --pool-bays 2
```

`UAT_SSH_HOST=local` is what makes the privileged bootstrap steps spawn `docker` instead of
`ssh` — sshd is not running on localhost, so without it the pool cannot be built.

Measured 2026-08-25: 7/7 steps green, and `csms-server`'s own log shows
`UpdateServiceCatalogResponseHandler: catalog persisted — catalogVersion "2",
previousCatalogVersion "1", serviceCount 4`. That last line is the point: the Response
crossed the schema rail the `v0.25.0` bump armed, rather than merely being sent.

---

## Two things that will still stop you

* **The self-provisioning `e2e/*` files refuse `--bootstrap-pool`** (`skip_when_pooled`, they
  would 409 on the shared pool) and, run standalone against `local-mtls`, get through six REST
  calls and `provision` before failing `connect_mqtt` with *"unable to verify the first
  certificate"*. Not diagnosed further as of 2026-08-25.
* **4 of 32 `device-management` scenarios fail locally on `403 "Testing endpoints are
  disabled"`** — `TESTING_TRIGGER_COMMAND_ENABLED` is unset on the dev stack. Environmental,
  not a defect.
