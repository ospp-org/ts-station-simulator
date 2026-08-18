#!/usr/bin/env node
/**
 * Measure how far this repo's @ospp/protocol pin is behind the published SDK.
 *
 * Why this is not a `.spec-ref`
 * -----------------------------
 * Both SDKs carry a `.spec-ref` because both VENDOR spec artefacts — schemas and the
 * conformance vector corpus — and their gates compare the vendored bytes against the
 * spec at that tag. This repo vendors nothing. It reads schemas through
 * `@ospp/protocol`, so its effective spec version is whatever the installed SDK
 * pinned. A `.spec-ref` here would be a SECOND COPY of a fact the SDK already ships,
 * kept by hand, and a hand-kept copy of a number is how three baselines in this
 * programme went stale (`ospp/spec` CONTRIBUTING, "No Number Without Its Measurement
 * Point"). So this reads the SDK's, and never restates it.
 *
 * What actually went wrong, and what this catches
 * -----------------------------------------------
 * The pin was `^0.20.0` while the SDK was at `0.22.0`. On `0.x` a caret is
 * MINOR-LOCKED: `^0.20.0` can never resolve to `0.21`, `0.22` or `0.23`. So this repo
 * was not lagging and waiting to catch up — it was BLOCKED, `npm update` would never
 * have moved it, and only an explicit pin edit could. Nothing said so, because a pin
 * that resolves cleanly looks identical to one that is current.
 *
 * The three repositories release in lockstep (spec ADR-001), so one published minor
 * ahead is a divergence, not slack. This fails on it, which is the point: the cost of
 * being behind should land on the day the SDK releases, not on the day someone
 * happens to look.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const PKG = '@ospp/protocol';
const fail = (msg) => { console.error(msg); process.exit(1); };

const pin = JSON.parse(readFileSync('package.json', 'utf8')).dependencies?.[PKG];
if (!pin) fail(`${PKG} is not a dependency of this package.`);

// Read the installed package off disk rather than through `require`: the SDK
// declares `exports`, which does not expose ./package.json, and a resolver error
// there would read as "not installed" when it is.
const root = `node_modules/${PKG}`;
let installed, specRef;
try {
  installed = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version;
} catch {
  fail(`${PKG} is not installed under ${root} — run \`npm ci\` before this check.`);
}
try {
  specRef = readFileSync(`${root}/.spec-ref`, 'utf8').trim();
} catch {
  specRef = '(the installed SDK ships no .spec-ref)';
}

let latest;
try {
  latest = execFileSync('npm', ['view', PKG, 'version'], { encoding: 'utf8' }).trim();
} catch {
  fail(`Could not reach the registry to read the published ${PKG} version. This check needs network; it is not a reason to skip it.`);
}

const parse = (v) => v.replace(/^[^0-9]*/, '').split('.').map(Number);
const [pMaj, pMin] = parse(pin);       // the PIN's floor — what the manifest asks for
const [iMaj, iMin] = parse(installed); // what is on disk right now
const [lMaj, lMin] = parse(latest);    // what the registry has

console.log(`pin        ${pin}          (floor ${pMaj}.${pMin})`);
console.log(`installed  ${installed}   (spec ${specRef})`);
console.log(`published  ${latest}`);

// Two different faults, and the first version of this check could not tell them
// apart because it compared INSTALLED against PUBLISHED. A stale or hand-edited
// node_modules then read exactly like an out-of-date pin, and the message blamed
// the manifest for something the tree had done.

// (1) The tree does not match the manifest. Nothing about the pin is wrong.
if (pMaj !== iMaj || pMin !== iMin) {
  fail(
    `\nThe installed ${PKG} (${installed}) does not satisfy the pin ${pin}.\n` +
    `This is the TREE, not the manifest: run \`npm ci\`. If it persists after that,\n` +
    `package-lock.json disagrees with package.json and the lockfile is what to fix.`,
  );
}

// (2) The pin itself has stopped tracking. On 0.x the minor is the breaking axis,
// so a caret cannot cross it: `^0.20.0` never resolves to 0.21+, and `npm update`
// will not move it. The repo is BLOCKED, not lagging, and only a pin edit changes
// that — which is the state this repo was in for three minors with nothing saying so.
if (pMaj === 0 && lMaj === 0 && lMin > pMin) {
  const behind = lMin - pMin;
  fail(
    `\nBLOCKED, not behind: the pin ${pin} is minor-locked on 0.x and can never resolve\n` +
    `past 0.${pMin}.x, so it is ${behind} minor(s) short of the published ${latest} and\n` +
    `\`npm update\` will not move it. Edit the pin in package.json — that is the only\n` +
    `thing that can — and re-run the scenario linter afterwards, because the SDK carries\n` +
    `the spec schemas this repo validates against and a tightening lands as new lint\n` +
    `failures rather than as an install error.`,
  );
}
if (lMaj > pMaj) fail(`\nThe published ${PKG} is a major ahead (${latest} vs pin ${pin}). Edit the pin deliberately.`);

console.log(`\nOK — the pin tracks the published ${PKG}, and the tree matches the pin.`);
console.log(`     Spec version is the SDK's, read from it rather than restated here.`);
