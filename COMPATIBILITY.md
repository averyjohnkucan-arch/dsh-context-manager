# DSH compatibility

Supported runtime line: `>=0.2.1-rc.2 <0.3.0-0`.

DSH prereleases participate in its compatibility checks. Patch and prerelease
updates within the 0.2 line can load this plugin without exact-version overrides.
The next minor (including its prereleases) requires review; future APIs cannot
be guaranteed compatible by a version range alone.

The DSH compatibility workflow tests the baseline and npm's `latest` DSH on
pull requests, pushes, manual runs, and weekly. It aligns the actual DSH host
packages, builds the plugin, checks host imports and browser module declarations,
runs the existing behavioral tests, and checks the packed package's exports.
A failure against latest is a request to investigate before upgrading support,
not a reason to disable DSH's compatibility protection.

To reproduce with dependencies installed against the chosen DSH:

```sh
npm run build --if-present
npm run check:dsh
npm test
```

These checks do not download models or prove GPU/engine performance. Existing
native-runtime and hardware validation procedures still apply.

## Reproducing the compatibility matrix

Use Node 22.19 or newer and a fresh checkout for each target. The following
matches the compatibility workflow (repeat with `DSH_VERSION=latest`):

```sh
export DSH_VERSION=0.2.1-rc.2
export DSH_HOME="$PWD/.compat-home"
compat_host=$(mktemp -d)
npm install --ignore-scripts --legacy-peer-deps --package-lock=false --no-audit --no-fund
npm install --prefix "$compat_host" --ignore-scripts --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION"
node scripts/use-dsh-host.mjs "$compat_host"
npm run build --if-present
npm run check:dsh
npm test
archive=$(npm pack --ignore-scripts --json | node -e 'let x="";process.stdin.on("data",v=>x+=v).on("end",()=>console.log(JSON.parse(x)[0].filename))')
mkdir -p .compat-packed
tar -xzf "$archive" -C .compat-packed
ln -s "$PWD/node_modules" .compat-packed/package/node_modules
node scripts/check-dsh-compatibility.mjs .compat-packed/package
```

The browser-shell check accepts quoted module keys and unquoted JavaScript
identifier keys (for example, `react:`). React is supplied by DSH's browser
shell; installing a separate React package would mask this check's setup error.
Unknown module IDs still fail resolution. Host evaluation and the 0.3 rejection
assertions remain enabled.

## Setup patch validation (November 10, 2026)

Local environment: Node 24.22.1, Linux. GitHub's Node 22 / Ubuntu 22.04 jobs
must still run; local results are not a claim that Actions is green.

| Check | Result |
| --- | --- |
| Baseline DSH 0.2.1-rc.2 tests | 27 passed |
| npm latest, resolved to DSH 0.2.2-rc.1 | 5 passed, 22 failed: changed agent-loop/tool composition and null lifecycle receiver in coordinateCompactors |
| Host imports, browser declarations, packed exports | Passed against both targets |

The original failed Actions run predates these patches. Rerun the compatibility
workflow on the updated draft PR head (both matrix entries, including tests and
packed exports). Keep the existing DSH range and rejection of 0.3 prereleases.
Model downloads and GPU inference were not exercised.
