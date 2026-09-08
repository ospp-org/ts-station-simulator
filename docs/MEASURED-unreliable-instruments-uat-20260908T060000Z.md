# Two instruments on UAT that read clean while telling you nothing

Measured 2026-09-08, during the post-deploy verification run. **Neither is repaired
here.** Both are written down because each produces a *reassuring* output when it is
not working, which is the only kind of broken instrument that costs you anything.

---

## 1. The EMQX topic trace is blind — again, and this is the second time

**What it looks like:** `docker logs csms-emqx-uat` returns cleanly. No errors. No
denials. Nothing.

**What was actually measured:** across a 90-minute window in which the full 148-scenario
suite ran and the server logged **120 `BootNotification] Accepted`**, the broker
container emitted **zero log lines**. Not zero matching lines — zero lines:

```
docker logs --since 90m csms-emqx-uat 2>&1 | wc -l
0
```

**Why that is a trap.** The natural reading of "no denials in the broker log" is "no
connections were denied". During that window the broker completed at least 120 TLS
handshakes and refused several more by design (the TLS-floor scenarios). Its silence
carried none of it. A negative read off this instrument means nothing.

**This is a recurrence.** `traversal-captures/README.md` records the same instrument
failing on 2026-09-07 in the other direction: `emqx ctl trace start topic
'ospp/v1/stations/#'` stayed listed as active for a whole run and **never created its
output file**, across ~140 matching frames. That entry closes with the rule this one
re-earns: *"I did not positive-control it before trusting it."*

**Use instead**, all of which were positive-controlled during this run:

| question | instrument that answers it |
|---|---|
| did a connection reach the broker? | `emqx ctl clients list` / `emqx ctl broker stats` — showed 1 client, and the count moved with reality |
| is a listener up and enforcing? | `emqx ctl listeners` — `ssl:default running: true` |
| was a message refused after arrival? | the DLQ on `redis-queue`, whose records carry `failure_reason`, `error_class` and `error_message` |
| did the station observe a refusal? | the simulator's own capture — `connect rejected as expected [<reason>]` |

**Positive control before believing any negative from the broker log:** make it say
something you already know is true. If it cannot, its silence is not evidence.

---

## 2. `csms-emqx-uat` is serving a stale `emqx.conf`, and a reload would hide it

**What the deploy said** (`scripts/deploy-uat.sh`, 2026-09-08, reported and deliberately
not acted on):

```
[WARN]  csms-emqx-uat is serving a STALE copy of /opt/emqx/etc/emqx.conf
[WARN]    host file changed 660h after the container started.
[WARN]    NOT restarting. Re-run with DEPLOY_RESTART_STALE_CONFIG=1, or
[WARN]    restart it yourself once you know what the config change does.
[WARN]  Stale config above means a SIGHUP/reload will re-read the OLD file and report success.
```

**The trap is the last line.** The container holds an open inode from before the host
file was edited — roughly 27 days before. A reload re-reads *that* inode. It will
complete, it will report success, and the broker will still be running the old
configuration. There is no output anywhere that distinguishes "reloaded the new file"
from "reloaded the old one".

**Not repaired here, and the deploy script is right not to.** The remedy is a restart,
a restart drops every connected station, and that is an operator's call rather than a
deploy step's. The script's own comment says so.

**What follows from it, for anyone reading broker behaviour on UAT:** the running
configuration is *not* `docker/emqx/emqx.conf` at HEAD. Any claim of the form "the broker
enforces X because the conf says X" is unfounded on this host until it is restarted or X
is confirmed against the live broker (`emqx ctl`, or out-of-band, e.g. `nmap
ssl-enum-ciphers` for the TLS floor — which is exactly how
`scenarios/tls-floor/s3-rejects-tls11-below-floor.yaml` establishes the broker-side half
of its claim, rather than trusting the file).

---

## The shape both share

Each fails by producing the output of success. A blind log reads as a quiet system; a
stale reload reads as an applied change. Neither announces its own failure, so neither
can be trusted on a negative result without a control that makes it speak first.
