# E2E test artifacts

Everything in this directory except this README is **generated** — by the `provision`
scenario step, by `ProvisionStationPoolStep`, and by the pool bootstrap in
`src/cli/index.ts`. Nothing here is authored by hand and nothing here belongs in git.

## These files carry live credentials

`pool-handle.json` holds the ephemeral operator accounts a pool run creates, as
**plaintext `{email, password}` pairs**. `uat/stn_*/` holds station private keys,
receipt signing keys and issued certificates.

## Ignore rule

`.gitignore` ignores `tests/artifacts/*` and re-admits only this README:

```
tests/artifacts/*
!tests/artifacts/README.md
```

The directory is ignored as a whole **so that a new artifact kind is covered the day it
is written**, without anyone having to remember to add a rule. Until 2026-08-06 the rule
named `tests/artifacts/uat/` alone, so `pool-handle.json` sat unignored and one
`git add .` from being published. It was never committed — verified with
`git log --all -- tests/artifacts/pool-handle.json`.

If you add an artifact that genuinely should be tracked, re-admit it explicitly with its
own `!` line and say why. Do not widen the ignore rule back to a subdirectory.
