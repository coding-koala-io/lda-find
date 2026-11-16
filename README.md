# LDA Local Find

A local development service compatible with Optimizely Search & Navigation (Find).

LDA Local Find is an independent project, not affiliated with, sponsored by, or endorsed by Optimizely. Users need their own Optimizely licence for the CMS and client software they use.

Development and research use only. The service binds exclusively to `127.0.0.1`, stores content on your machine, and sends no telemetry. It implements a small protocol profile; running CMS 12 compatibility and hosted search relevance have not been verified. See [LEGAL-NOTICE.md](LEGAL-NOTICE.md) and [CLEAN-ROOM.md](CLEAN-ROOM.md).

## Start from source

1. Install Node.js 24 or later. This project has no runtime or development dependencies.
2. Run `npm start` in this folder. The default address is `http://127.0.0.1:8088`.
3. Put the following synthetic development settings in your CMS 12 site's `appsettings.Development.json`:

   ```json
   {
     "EPiServer": {
       "Find": {
         "ServiceUrl": "http://127.0.0.1:8088/local-development-key/",
         "DefaultIndex": "local-pages"
       }
     }
   }
   ```

4. Start the CMS after the service. Exercise its startup, indexing and search flow against synthetic content before relying on the result.

The service URL includes the complete path prefix and synthetic key. The index is a separate setting. Keep any tenant path before the key in `SERVICE_PREFIX`; routing requires that complete prefix. There is no separate Authorization header or credential exchange. Use synthetic local values, never a hosted service credential. The startup message deliberately omits the prefix.

On Windows, use `npm.cmd start` or `npm.cmd test` if a PowerShell npm wrapper exits without running the script.

## Configuration

| Environment setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8088` | Integer TCP port; `0` requests an available port. |
| `HOST` | `127.0.0.1` | This is the only accepted bind address. Other values prevent startup. |
| `SERVICE_PREFIX` | `/local-development-key` | Complete tenant/key path. A trailing slash is optional. Use a synthetic development key. |
| `DATA_DIR` | Approved root | Local JSON storage folder inside the approved root. Relative paths resolve from the install folder; `..` path components are refused. `:memory:` disables persistence. |
| `DATA_ROOT` | `./data` under the install folder | Explicitly approves a different absolute storage root. Values containing `..` anywhere are refused. |

One process serves one prefix and any number of named indices. Run a separate process, port and data directory for another instance. Only one process may own a data directory.

Storage defaults to `data` beside this README regardless of the process working directory. For separate instances use `DATA_DIR=./data/instance-a`. To approve external storage, set `DATA_ROOT` to its absolute path; omit `DATA_DIR` to use that root directly, or set `DATA_DIR` to an absolute child path. Paths outside the approved root prevent startup. Symlinks, junctions and Windows reparse points are refused on storage folders, ancestors and store/staging files. Writes create `store.json.tmp` exclusively before replacing `store.json`; an existing staging file is refused. Windows also requires the built-in `powershell.exe` for reparse-attribute checks and refuses storage if that check fails. Keep the storage root under the service owner's control; portable path checks cannot prevent another process racing to replace a directory during a write.

Integral JSON values beyond JavaScript's safe integer range are kept exactly through persistence, predicates, sorting, facets and responses. Responses emit numeric tokens, so consumers must also use a precision-preserving JSON reader. Floating-point values retain JavaScript number semantics. Values already rounded by an earlier build must be reindexed from their original source; the lost digits cannot be recovered from the store.

## Implemented profile

| Area | Behavior |
| --- | --- |
| Connection | Settings, disabled feature discovery, language-list reads/clear. Statistics, administration and service queuing are not advertised. |
| Documents | Single writes with explicit or generated IDs, get, delete, ordered bulk index/create/delete, multi-get, query deletion, refresh switches, version preconditions, TTL expiry and parent metadata. Identity includes index, transport type and ID. |
| Search | Typed/index-list search and count, newline-framed multi-search, full text, grouped Boolean filters, type hierarchy, field variants, existence, prefix and numeric/date ranges. |
| Results | Term/filter facets, separate query and hit-filter populations, field sorting, paging, source/projections, simple highlight fragments and numeric boosts. |
| Storage | In-memory evaluation with atomic JSON file replacement before acknowledging a write. Submitted source values are retained. |

Writes are visible immediately, including while refresh is off. Refresh switches record state and acknowledge the reindex lifecycle; they do not hide writes. Query deletion always evaluates the supplied predicate, including with `delta_indexing=true`; it does not clear unrelated records.

Single `version` and bulk `_version` require an existing live document with the same version; mismatches return 409. TTL is positive integer milliseconds and hides expired records from reads/searches; replacing without TTL removes the old expiry. Parent metadata is retained and available through `_parent`; child joins remain unsupported. Consistency/replication/timeout/routing controls are validated single-node hints. Percolation is rejected explicitly because its result behavior is unspecified. See the compatibility report for exact local choices.

Search uses Unicode word tokens and lowercase comparison, without stemming. Base string terms remain exact and case-sensitive; `.lowercase`, `.standard`, language, wildcard-language and `.sort` views are evaluated separately. Language analyzer names select the same local token matcher. Language routing is recorded as a language choice and never substitutes for the query's language filter. This is an approximation of analysis and ranking.

## Tests

```powershell
npm test
```

Tests use `node:test`, synthetic documents and temporary loopback ports. They cover each implemented essential endpoint's request/response shape, item failures, malformed requests, prefix enforcement and persistence. One end-to-end test indexes 20 pages of two types and verifies filtering, facets, paging and projection. Another tests 30 CMS records across publication, language, status and type-guard branches, returning only the nine eligible records for its authenticated visitor. Write-option tests exercise conflicts, expiry boundaries, restart and rollback.

## Remaining work

Enabled extensions, script updates/scoring, mapping/exploration APIs, best bets, synonyms, suggestions and tracking remain outside this build. Attachments are retained without extraction. Unsupported operations and query features return explicit errors. No live CMS site or vendor client was executed for this build.

The complete endpoint coverage, unsupported query features and spec decisions are in [docs/compatibility.md](docs/compatibility.md). Read that report before enabling additional site features.

## Repository layout

`src/` holds the HTTP service, protocol routes, store and evaluator. `test/` holds synthetic fixtures and built-in Node tests. `docs/` holds the implementation coverage report. `data/store.json` is generated at runtime and ignored by Git. No dashboard, service installer or release packaging is included in part 1.

See [LICENSE.md](LICENSE.md) and [NOTICE](NOTICE) for the software licence.
