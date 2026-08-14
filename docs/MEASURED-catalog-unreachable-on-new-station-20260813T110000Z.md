# MEASURED — a newly-registered station cannot be given a single service through any public API path

> **CLOSED 2026-08-15 — the loop below no longer exists on csms-server `99cab60`.**
> The measurement stands as taken; what it measured has since been changed, and this
> banner is here so the body is not read as current. Nothing below has been edited.
>
> The fix was not one of the three options in *What would close it* — it was the first
> of them **plus a fourth door nobody had proposed**, which is why it cost neither gate:
>
> - `POST /api/v1/admin/stations/{id}/catalog/publish` (`bb8c28f`) sends the catalog **as
>   the server already holds it**. It takes no body, so there are no caller prices for
>   `assertNoKindAwareServices` to refuse — the kind guard is untouched and simply has
>   nothing to act on. Services with no `(bay, program)` binding are not a refusal here:
>   they are reported in a `withheld` list, `[{serviceId, reason}]`, and the rest ships.
> - `POST …/services` now **honours a caller-supplied `serviceId`** (option 1 above;
>   `StationServiceCatalogController.php:186-192`). Step 2's silent substitution is gone,
>   so the binding and the catalog can finally name the same service. A collision is a
>   named 422, `code: SERVICE_ID_TAKEN`.
> - Registration now **refuses** `bays[].services` (`dbc45f7`, 422) instead of accepting
>   and dropping it — the sub-finding at the end of *Why the two doors do not meet*.
>
> `resolveBindings()` and `assertNoKindAwareServices()` are both still in force on the
> legacy `PUT …/catalog`, and both still refuse exactly what they refused on 2026-08-13.
> The sequence that reaches a sellable service today is
> `POST …/services` → `POST …/services/{stationServiceId}/binding` → `POST …/catalog/publish`,
> and the three `scenarios/e2e/*` files drive it as of 2026-08-15 — written against the
> server read at source, **not yet run**: the route is not on UAT at the time of writing.

- **Date (UTC):** 2026-08-13T11:00:00Z
- **Mode:** measurement against live UAT, then code reading to explain what was measured.
  No server change. No production. The probe station and everything it created were torn
  down (see *Cleanup*).
- **Environment:** UAT `api-uat.onestoppay.ro`, csms-server `00d7286`,
  ts-station-simulator `37c8ffa` + the e2e capability fix in this branch.
- **Status of the claim:** measured on a real request sequence, end to end. It was
  previously reachable only as a deduction from reading the two guards; the sequence below
  is the observation.

---

## The claim

A station registered today can be given **no service at all** through the public REST API.
The two surfaces that could give it one are each individually functional, and they do not
meet: the legacy catalog push requires state only the new surface can create, and the new
surface stamps that state with a marker the legacy push then refuses.

This is not a scenario-authoring gap and not a simulator bug. It is a closed loop in the
server, and it is why the three `scenarios/e2e/*` files stop where they do.

---

## The measurement

Fresh station `stn_629bb7b2`, provisioned and booted by
`scenarios/e2e/e2e-new-customer-onboarding.yaml` against UAT, org
`019ffac2-618a-73e3-91ad-920c4f852d35`, caller = the run's own `tenant_owner`.
`device_management_supported = true` (verified in `stations`), station online.

**Step 1 — the legacy catalog push, on a station with no services.**

```
PUT /api/v1/admin/stations/stn_629bb7b2/catalog
    {"services":[{"serviceId":"svc_wash_basic", … }]}
→ 400
{"error":{"code":"VALIDATION_ERROR","ospp_code":6004,
  "message":"Service 'svc_wash_basic' has no (bay, program) binding on this station.
             Create one before pushing the catalog:
             POST /api/v1/admin/stations/{stationId}/services/{stationServiceId}/binding"}}
```

The refusal names the cure. Follow it.

**Step 2 — create the service through the only REST route that writes `station_services`.**

```
POST /api/v1/admin/stations/stn_629bb7b2/services
    {"serviceId":"svc_wash_basic","serviceName":"Basic Wash",
     "serviceKind":"UserDuration","pricingType":"PerMinute","priceCreditsPerMinute":10}
→ 201
{"data":{"id":"fc20e3fe-…","serviceId":"svc_907c53fadc94bf24","serviceKind":"UserDuration", … }}
```

Note the response. The `serviceId` the caller asked for was **discarded**; the server minted
`svc_907c53fadc94bf24` of its own. And `serviceKind` came back set — it is a required field
on this route, so it is always set.

**Step 3 — create the binding, exactly as the 400 instructed.**

```
POST /api/v1/admin/stations/stn_629bb7b2/services/fc20e3fe-…/binding
    {"bayId":"bay_656ad95594056095bca431cdc7945f9d","programNumber":1}
→ 201 {"success":true,"binding":{"bayNumber":1,"programNumber":1, … }}
```

Works. A `(bay, program)` binding now exists on this station.

**Step 4 — retry the catalog push for the service the caller wanted.**

```
PUT …/catalog  {"services":[{"serviceId":"svc_wash_basic", … }]}
→ 400  Service 'svc_wash_basic' has no (bay, program) binding on this station.
```

Same refusal. The binding exists, but under the id the server minted in step 2, not the one
the caller named — and the caller was never able to name it.

**Step 5 — retry for the id the server actually minted.**

```
PUT …/catalog  {"services":[{"serviceId":"svc_907c53fadc94bf24", … }]}
→ 400
{"error":{"code":"VALIDATION_ERROR","ospp_code":6004,
  "message":"Service(s) [svc_907c53fadc94bf24] are kind-aware and must be managed via the
             service catalog (catalog.manage); the legacy station-catalog path cannot
             re-price them."}}
```

The loop closes. Step 4 fails because the binding is under another id; step 5 fails because
the only id that HAS a binding is the one the legacy route is forbidden to touch.

---

## Why the two doors do not meet

Line references are `csms-server` at `00d7286`.

**The legacy push demands a binding.**
`app/Modules/DeviceManagement/Actions/UpdateServiceCatalogAction.php:149` `resolveBindings()`
joins `bay_services → bays → station_services → service_definitions`; at `:161` an empty
result throws (`:167`). It is called at `:92`, inside the payload build, before anything is
dispatched — so it gates every push including the first. It landed in `11aa480` (2026-08-06,
*"finish the 2.2 wire shapes — bindings on the catalog"*), implementing spec v0.11.0
`common/service-item.schema.json`, where `bindings` became REQUIRED with `minItems: 1`.

**The legacy push refuses a kind-tagged definition.**
Same file, `:249` `assertNoKindAwareServices()` selects `service_definitions` for the DTO's
service ids `whereNotNull('service_kind')` (`:257`) and throws if any match (`:261`–`:268`).
Deliberate: a kind-tagged definition is owned by the kind-aware surface, and the kind-blind
legacy path cannot express per-unit or preset semantics, so letting it re-price one would
mis-charge an N-unit customer.

**Nothing else writes the two tables.** Exhaustively, on `00d7286`:

| table | writer | reachable on a fresh station? |
|---|---|---|
| `station_services` | `StationServiceCatalogController.php:152` (`POST …/services`) | yes — but see below |
| `station_services` | `UpdateServiceCatalogResponseHandler.php:149` | **no** — runs only after a catalog push already succeeded |
| `bay_services` | `StationServiceCatalogController.php:272` (`POST …/binding`) | yes — needs a `station_services` row first |

And registration creates neither: `app/Modules/Station/Actions/RegisterStationAction.php:16`
states it outright — *"registration writes NOTHING into the services tier"* — so the
`bays[].services[]` array that `POST /api/v1/admin/stations` accepts and that all three e2e
files send is read for `bayNumber` only (`:39`–`:47`). The service names in it reach no table.

**The kind marker cannot be avoided.** `StationServiceCatalogController.php:132` generates
`$serviceId = 'svc_'.bin2hex(random_bytes(8))` unconditionally — the caller's `serviceId` is
never read — and `:143` writes `'service_kind' => $kind->value` from a required request
field. There is no route that creates a NULL-kind `service_definitions` row.

So the only state that satisfies `resolveBindings()` is a NULL-kind definition with a
binding, and no public route can produce a NULL-kind definition. The pooled suite does not
hit this because `PoolBootstrap.buildSeedCatalogSql`
(`src/scenarios/bootstrap/uatPrivileged.ts:253`) writes all three tiers by privileged SQL
over SSH — its own docblock records the same finding from the other side: *"`service-catalog-
update.yaml` could never pass … the PUT could not return 202 on any run."*

---

## What this costs, stated plainly

- **A new tenant cannot sell anything through the documented onboarding path.** Register →
  provision → boot → push catalog is the flow the three e2e files model and the flow the
  400's own error message directs an operator through. It terminates in a refusal loop.
- **The 400 in step 1 gives advice that cannot be followed.** It names the binding route as
  the cure; following it produces step 5. An operator reading the error does the right thing
  and still fails, which is worse than a refusal that says "use the other surface".
- **The kind-aware surface may well be the intended path now** — but nothing says so. The
  legacy route is still mounted (`routes/api/v1/admin.php:60`), still documented by the e2e
  corpus, and still the only one that produces the `UpdateServiceCatalog` MQTT round-trip.
  If it is deprecated for new stations, that is a decision nothing in the code records.
- **The gate is invisible to the server's own suite.** `StationFactory` (and
  `PoolBootstrap`) seed the services tier directly, so no test drives a station from
  registration to a first catalog push over the API.

## What would close it

Not proposed as a fix — the server is another session's — but the shape of the answer
follows from the two lines above:

1. Let `POST …/services` accept a caller-supplied `serviceId` (today `:132` discards it),
   **or**
2. give the legacy push a way to create its own NULL-kind definition + binding on a first
   push (its `bindings` could be derived from `bay_programs` the way
   `buildSeedCatalogSql` derives them), **or**
3. declare the legacy route closed to stations registered after 11aa480 and make the 400 say
   so instead of naming a cure that leads to step 5.

Whichever is chosen, the discriminator worth keeping is that a fresh station should be able
to reach a sellable service through **one** documented sequence, and a test should drive
that sequence rather than seeding around it.

---

## Cleanup

The probe station and everything it created were removed through
`teardownScenarioResources` and verified absent afterwards: `stations`, `organizations`,
`users`, `service_definitions` for org `019ffac2-…` all count 0, and the local artifact
directory is gone. The `service_definitions` row from step 2 went with the organization's
CASCADE. Nothing from this measurement remains on UAT.
