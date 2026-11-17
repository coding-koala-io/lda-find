# LDA CLI handoff: `lda install find`

The install list is in the separate repository at `D:/projects/coding-koala/optimizely-local/lda-cli`. No file in that repository was changed during this task. This is the exact registration change to apply there, following Graph and Assets.

The proposed release repository is `coding-koala-io/lda-find`, matching the existing `lda-graph` / `lda-assets` convention. No remote or release was created or verified in this task. Confirm that release destination before publishing.

## Registration patch

Apply this diff from the `lda-cli` repository root:

```diff
diff --git a/src/catalog.js b/src/catalog.js
--- a/src/catalog.js
+++ b/src/catalog.js
@@ -1,5 +1,5 @@
 import {createRequire} from 'node:module';
-export const suite = 'Local Developer Accelerator (LDA), compatible with Optimizely CMS 13';
+export const suite = 'Local Developer Accelerator (LDA), compatible with Optimizely CMS 12 and CMS 13';
 // The single source of the CLI version is package.json (npm always ships it); the release script bumps only that,
 // the lockfile, the licence and the changelog.
 export const version = createRequire(import.meta.url)('../package.json').version;
@@ -7,6 +7,7 @@
 export const catalog = Object.freeze([
   {key: 'graph', product: 'LDA Local Graph', compatibleWith: 'Optimizely Graph', repo: 'coding-koala-io/lda-graph', port: 8082, serviceId: 'LdaGraph', legacyServiceIds: ['OptimizelyGraphLocal'], runtimeFolder: 'Graph', options: {memoryMb: {default: 8192, min: 1024, max: 65536}}},
   {key: 'assets', product: 'LDA Local Assets', compatibleWith: 'Optimizely CMS DAM picker', repo: 'coding-koala-io/lda-assets', port: 8083, serviceId: 'LdaAssets', legacyServiceIds: ['OptimizelyDamLocal'], runtimeFolder: 'Assets', options: {}},
+  {key: 'find', product: 'LDA Local Find', compatibleWith: 'Optimizely Search & Navigation (Find) for CMS 12', repo: 'coding-koala-io/lda-find', port: 8088, serviceId: 'LdaFind', legacyServiceIds: [], runtimeFolder: 'Find', options: {}},
 ]);
 export function moduleFor(key) {
   const mod = catalog.find(m => m.key === (key === 'dam' ? 'assets' : key));
diff --git a/elevated/lda-service.ps1 b/elevated/lda-service.ps1
--- a/elevated/lda-service.ps1
+++ b/elevated/lda-service.ps1
@@ -14,6 +14,7 @@
 $Modules = @{
     graph = @{ Product='LDA Local Graph'; CompatibleWith='Optimizely Graph'; Repo='coding-koala-io/lda-graph'; Port=8082; ServiceId='LdaGraph'; LegacyServiceId='OptimizelyGraphLocal'; RuntimeFolder='Graph'; MemoryMb=8192 }
     assets = @{ Product='LDA Local Assets'; CompatibleWith='Optimizely CMS DAM picker'; Repo='coding-koala-io/lda-assets'; Port=8083; ServiceId='LdaAssets'; LegacyServiceId='OptimizelyDamLocal'; RuntimeFolder='Assets'; MemoryMb=0 }
+    find = @{ Product='LDA Local Find'; CompatibleWith='Optimizely Search & Navigation (Find) for CMS 12'; Repo='coding-koala-io/lda-find'; Port=8088; ServiceId='LdaFind'; LegacyServiceId=''; RuntimeFolder='Find'; MemoryMb=0 }
 }
 # CATALOG-END
 $wrapperUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
diff --git a/tray/lda-tray.ps1 b/tray/lda-tray.ps1
--- a/tray/lda-tray.ps1
+++ b/tray/lda-tray.ps1
@@ -4,7 +4,7 @@
 Set-StrictMode -Version Latest
 $ErrorActionPreference='Stop'
 # CATALOG-KEYS (kept identical to src/catalog.js by tests)
-$script:CatalogKeys=@('graph','assets')
+$script:CatalogKeys=@('graph','assets','find')
 function Test-ModuleKey([string]$Key) {
     # tray.json is user-writable: only known catalogue keys may reach a command line.
     return ($Key -cmatch '^[a-z-]+$') -and ($script:CatalogKeys -ccontains $Key)
```

The JavaScript catalog drives CLI module selection, default ports, hub cards, status, plans and release lookup. The elevated helper has its own module table; changing JavaScript alone does not permit Windows installation. The tray also has an explicit allowlist. Find has no legacy service to adopt and no Graph heap option.

## Matching test and documentation changes in `lda-cli`

1. In `test/core.test.js`, rename the two-module catalog test, expect `['graph', 'assets', 'find']`, and assert `moduleFor('find')` has port `8088`, service ID `LdaFind`, empty `legacyServiceIds` and the release repository above.
2. In `test/powershell.test.js`, replace `LegacyServiceId:m.legacyServiceIds[0]` with `LegacyServiceId:m.legacyServiceIds[0] ?? ''`. This keeps the mirror-table check meaningful for a module without a legacy ID. In `test/hub.test.js`, expect three status rows and check the Find row. In `test/tui.test.js`, change the act-on-all expected keys to `['graph','assets','find']`.
3. Update the all-module expectations in `test/docker.test.js` and `test/linux.test.js` to include port `8088`. Confirm those environments preserve loopback-only operation. Update the CLI README's module table, configuration keys (`ports.find`), release-repository list and suite compatibility wording; retain each module's specific CMS version.
4. Add an install-plan test for `find`: port `8088`, runtime folder `Find`, service ID `LdaFind`, no memory override and no adopt path. Run the CLI's `npm test` after the changes. Those tests were not run or changed here.

## Module release prerequisites — registration alone is insufficient

The inspected Local Find build runs from source. It has no `scripts/service-xml.js`, no unprefixed `/health` endpoint and no release workflow or bundle. The existing CLI requires all of these contracts:

| Contract | Required Find release behaviour |
| --- | --- |
| `scripts/service-xml.js xml` | Read JSON options from stdin (`nodePath`, `repoRoot`, `runtimeRoot`, `port`); return WinSW XML for `LdaFind`, running `src/server.js` as LocalService on `127.0.0.1`. Set `PORT`, `HOST`, `DATA_ROOT` and `DATA_DIR`; both storage paths must identify `<runtimeRoot>/data`. Keep the synthetic service prefix and diagnostics off by default. Follow Graph/Assets path validation, XML escaping and log permissions. |
| `scripts/service-xml.js init` | Read the same stdin contract; initialise only the module's local runtime, idempotently, without overwriting content. The CLI currently checks for `tenants.json` before invoking init; either supply an original noncredential compatibility marker there, or change that check for Find. Find itself has no tenant-file model. |
| Foreground startup | `src/engine.js` currently supplies `DATA_DIR` outside the installed code root but no `DATA_ROOT`. For Find, also pass `DATA_ROOT: path.join(root, 'data')` in the child environment; otherwise the approved-root check refuses the CLI runtime. Preserve `HOST=127.0.0.1`. |
| Health | GET `/health` must work outside the CMS service prefix, after local Host/Origin checks, and expose no content, credentials or prefix. Return HTTP 200 with `product: "find"`, the package `version` and the store's `dataVersion`. The elevated helper checks the module key and exact version, not the display name. |
| Release assets | Publish `lda-find-<version>.zip`, `manifest.json` and `SHA256SUMS` to the proposed module release repository. ZIP root must contain `src/server.js`, `scripts/service-xml.js`, original runtime files and required dependencies only. The manifest requires `module: "find"`, `product: "LDA Local Find"`, `version`, `minNode: "24"`, `dataVersion`, `file`, `sha256`, `size`, `commit` and `builtAt`; generate hashes and metadata from the actual artifact. Exclude all runtime data, probes and private research. |

The CLI currently links every module to `/` as a dashboard; Local Find has no dashboard. Use a local status page or adjust that CLI link for Find before advertising it. Do not weaken the CMS service prefix to make the link work.

After the module contracts, clean release bundle and CLI tests are ready, validate `lda install find --dry-run --accept-notice`, then install/start/status/stop/reinstall/upgrade/rollback/uninstall on a disposable Windows setup. No real service installation or publication was performed in this task.
