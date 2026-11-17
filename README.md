> **Development and research use only. Not designed or tested for production use.**
> LDA Local Find runs on one developer machine, bound to localhost. Behaviour,
> limits and relevance differ from the hosted service; test against the real service
> before release. Local data can include drafts and restricted content: keep it private.
> No telemetry. Provided "as is", without warranty. See [LEGAL-NOTICE.md](LEGAL-NOTICE.md).
> This independent project is not affiliated with, sponsored by or endorsed by Optimizely.

# LDA Local Find

**A free, local-only development stand-in compatible with Optimizely Search & Navigation (Find) for CMS 12.** Run your site's own indexing job, then search its content on your own machine.

Part of **Local Developer Accelerator by Coding Koala**. Users need their own Optimizely licence for the CMS and client software they use. This project grants no rights to Optimizely software or services. Product names identify compatibility only; they are trademarks of their respective owners.

## 2-minute quick start

Requires Node.js 24 or later and an existing, licensed CMS 12 site configured to use Search & Navigation. The setup takes about two minutes; indexing time depends on your content.

1. Install and start this server from this folder:

   ```powershell
   npm install
   npm start
   ```

   There are no runtime or development dependencies. Keep this terminal running; the default address is `http://127.0.0.1:8088`.

2. In the terminal that starts your CMS site, set these two development settings, then start the site with its usual command:

   ```powershell
   $env:EPiServer__Find__ServiceUrl = 'http://127.0.0.1:8088/local-development-key/'
   $env:EPiServer__Find__DefaultIndex = 'local-pages'
   ```

   Alternatively, put the same settings in the site's `appsettings.Development.json`:

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

3. In the CMS administration UI, run **the site's own built-in Search & Navigation indexing scheduled job**. Use the site's search page after it finishes. On the Foundation sample, the search term parameter is `?search=jacket`.

The URL path contains a synthetic local key, not a hosted credential. Keep the trailing slash and set the index separately. Start this server before the CMS. On Windows, use `npm.cmd` if the PowerShell npm wrapper does not run its script.

The `lda install find` registration belongs to the separate LDA CLI repository. It is not available in the inspected CLI yet; [the exact installer handoff](docs/lda-install-find.md) records the changes and release prerequisites. Use the source start above for this build.

## Proven on CMS 12 Foundation

The project owner completed the real-site proof on 17 November 2026 using Foundation's own built-in indexing job and search page:

| Check | Result |
| --- | --- |
| Built-in indexing job | **811 items reported by the job; 809 documents stored** in the subsequent admin-screen run. |
| `?search=jacket` | **6 products** displayed. |
| `?search=shoes` | **8 products** displayed. |
| A no-match word | **"No products matched"** displayed. |

**Known Foundation sample limitation:** two items, `CartPage` and `LayoutSettings`, fail inside the sample's outgoing serialization before any request is sent to LDA Local Find. The job's 811-item total appears to include these two errors; it is not a count of successful server acknowledgements.

This proof establishes that indexing and these search-page scenarios work on that CMS 12 sample. It does not establish compatibility with every site feature or parity with hosted search relevance.

## What it supports

| Area | Local behaviour |
| --- | --- |
| Connection | Settings, real-language list reads/clear and feature discovery with unsupported capabilities disabled. CMS-forwarded HTTP/HTTPS loopback Origins are accepted at any port, including comma-separated repetitions of the same origin. JSON bodies with proxy form/plain content types are accepted on search/count and document routes. |
| Indexing | Single and ordered bulk index/create/delete, bounded get/multi-get, query deletion, named-index clearing, refresh lifecycle acknowledgements, version preconditions, TTL expiry and parent metadata. |
| Search | Search/count and newline-framed multi-search; Overview type/language/site counts, Explore match-all (`*:*`), type filters and paging; full text, Boolean/type/language/access/publication predicates, field variants, existence, prefix and numeric/date ranges. Empty predicate objects match all. |
| Results | Term/filter facets, separate query and hit filters, sorting, paging, source/field/partial projections, basic highlights, boosts and native `ascropped` excerpt projections. CMS reference IDs and indexed integer/decimal token types are preserved. |
| Storage | Local memory evaluation with JSON persistence. Writes are visible immediately and persisted before acknowledgement. `:memory:` disables persistence. |

See [docs/compatibility.md](docs/compatibility.md) for endpoint coverage and exact implementation choices.

## What it does not support

- **Full service coverage.** Unimplemented endpoints/methods, including field updates, service queuing and most administration, return HTTP **501** with a short JSON reason, including when URL options are present. Implemented endpoints still reject malformed input or unsupported options with 400 (unsupported scroll uses 501).
- **Hosted search behaviour.** No stemming, hosted analyzer/ranking parity, synonym or best-bet management, arbitrary script execution/scoring, advanced facet families, geo sorting, child joins or attachment extraction. The named `ascropped` projection is a local character crop. Refresh switches acknowledge the lifecycle without delaying write visibility.
- **Statistics or analytics.** Did-you-mean, spellcheck and autocomplete return empty `hits`. Query/hit tracking returns fixed dummy acknowledgements, retains no events and never records tracking bodies. Clear statistics succeeds as a no-op. Totals, GDPR and sanitizer management are unsupported. Nothing is sent anywhere by these endpoints.
- **Remote or production operation.** The server binds only to `127.0.0.1`, validates local Host headers, and accepts Origin only for `http`/`https` on `localhost`, `127.0.0.1` or `[::1]` at any port. Comma-separated Origin lists pass only when every trimmed entry is the same allowed origin; mixed origins, empty entries and non-loopback entries receive 403. It has no telemetry or outbound service integration, distributed indexing or production guarantees.

## Configuration

| Environment setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8088` | Integer TCP port; `0` requests an available port. |
| `HOST` | `127.0.0.1` | Only accepted bind address. Other values prevent startup. |
| `SERVICE_PREFIX` | `/local-development-key` | Complete tenant/key path. Match it in the site's service URL; use synthetic values. |
| `DATA_ROOT` | `./data` beside this README | Approved storage root. Set an absolute path to approve external storage. |
| `DATA_DIR` | Approved root | Storage folder within that root. Relative paths resolve from the install folder. `:memory:` disables persistence. |
| `DEBUG_SEARCH_REQUESTS` | Off | Set to `1` before starting to enable the local recording described below. |
| `LOG_REQUESTS` | On in development; off when `NODE_ENV=production` | `0` disables request logging; `1` enables it. One console line per request: method, redacted path, status, a short error code for 4xx/5xx, and elapsed milliseconds. |

One process serves one prefix and any number of named indices. Use a separate process, port and data directory for another instance. Only one process may own a data directory. The startup message omits the service prefix.

Storage paths containing `..`, paths outside the approved root, symlinks, junctions and Windows reparse points are refused. Writes create `store.json.tmp` exclusively before replacing `store.json`; an existing staging file prevents a write. Windows requires built-in `powershell.exe` for reparse checks. Keep the root under the service owner's control; another process changing directories during a write remains outside portable path-check guarantees.

Integral JSON values beyond JavaScript's safe integer range remain exact through persistence, predicates, sorting, facets and responses. Consumers need a precision-preserving reader too. Indexed decimal tokens retain their decimal syntax; scores use decimal tokens. Reindex values already rounded or stripped of decimal syntax by earlier builds from their original source.

Every terms facet includes `total` (the sum of all term counts within the query and facet-filter scope, including terms omitted by `size`) and `other` (`total` minus the sum of returned term counts). Missing documents are counted separately in `missing`. Multi-valued documents can contribute to several term counts; `other` is zero when all terms are returned.

Document GET uses the same **16 MiB output construction budget** as search, covering metadata, full source and every explicit field selection. Overlapping or repeated fields consume capacity separately; overflow returns **413** before later projections are constructed.

Local quotas are **10,000 documents / 64 MiB per index**, **25,000 documents / 128 MiB per store**, and **128 indices**. Byte accounting includes UTF-8 document records, identities and index settings. Exceeding a quota returns **413** (a per-item 413 for bulk); replacements and expired/deleted content release capacity. Startup refuses stores over these limits. Settings advertise the index document limit. Snapshots reuse cached serialization of unchanged documents, stream to an atomic replacement file, and batch a bulk request into one bounded save before acknowledgement. A save still copies the bounded snapshot to disk.

Search enforces one **16 MiB output construction budget** across hit metadata, source/field/partial projections, crop fields, highlights and facets. Each alias, copy and repeated hit consumes capacity; overflow returns **413** while building the response. Accounting conservatively reserves envelope/punctuation bytes and counts overwritten selections, so a near-limit response can be refused below 16 MiB of final JSON. Multi-search allows at most **100 searches** and shares that **16 MiB aggregate output budget** across all components, returning 413 on overflow. Multi-get allows at most **100 documents** and **16 MiB of response JSON**, counting repeated documents each time; overflow returns 413. Text expressions allow **64 KiB**, nesting up to **40** including surrounding DSL nodes, and a shared **1,024-node/term/field-predicate** compile budget across query, hit filter and facet predicates. Every compiled compound field predicate counts, as does each term-list value. Wildcard patterns allow **1,024 UTF-16 code units** and **64 wildcard operators**; a finite-state matcher avoids backtracking regular expressions. Excesses return 400 before scanning. Search URL `size` (0–1,000) and `from` (nonnegative safe integer) override body paging; `search_type` is validated. Unknown, duplicate, empty or invalid URL options on implemented endpoints return 400, including empty write `routing=` and `language_routing=`; `scroll` returns 501.

`POST` or `DELETE /I/_clear?clear_index=true&clear_stats=false` empties only the named Local Find index and its language metadata; it preserves other indices. Both flags must be Boolean strings. With `clear_index=false&clear_stats=true`, the operation succeeds without writing because no statistics are retained. Explore accepts scalar or array partial-source patterns and omits attachments as requested. Search/count, single-document and multi-get routes also accept `application/x-www-form-urlencoded` or `text/plain` (including charset parameters) only when the body parses as exactly one JSON value; malformed/empty JSON or invalid endpoint shapes return 400. No form decoding is performed. Bulk, multi-search and Statistics retain their existing JSON/NDJSON content-type requirements.

Request logs omit the service prefix, query string, headers and bodies. Dynamic path segments are replaced with `:value`; for example `POST /:value/_search 200 12ms` or `POST /:value/_search 400 invalid_json 12ms`. Error codes are fixed internal identifiers, never error messages or user values. This log is separate from opt-in search-body recording below.

## Opt-in search request recording

Recording is **off by default**. To enable it for a local debugging session:

```powershell
$env:DEBUG_SEARCH_REQUESTS = '1'
npm start
```

Only successfully validated search and multi-search bodies are appended to `DATA_DIR/search-requests.ndjson`, up to **10 MiB**. Rejected requests and partially invalid multi-search batches are never recorded. URLs, headers, multi-search metadata, indexing payloads and Statistics requests are omitted. Credential-named properties (including `key`, `servicePrefix` and `service_prefix`), key-like tokens in values and property names, and the configured service prefix and its segments (including inside query text) are redacted recursively. Long opaque words can be over-redacted.

Search terms and other body values can still contain private information: redaction is not a guarantee that arbitrary text contains no secrets. Keep recordings private and outside release artifacts. Remove the environment setting and restart to disable recording:

```powershell
Remove-Item Env:DEBUG_SEARCH_REQUESTS -ErrorAction SilentlyContinue
```

## Tests

```powershell
npm test
```

Tests use Node's built-in test runner, original synthetic fixtures, temporary local storage and loopback ports. They cover protocol contracts, indexing, visitor visibility, search/projections, exact numeric responses, persistence, storage boundaries, Statistics no-ops and opt-in diagnostics. The real Foundation proof above is separate owner-supplied acceptance evidence.

Run `npm run check:clean-room` before publication. It inspects ignored files too and fails on binaries, SDK probes, diagnostic folders or request/replay captures anywhere outside Git's internal database. The local proof store remains private and excluded from publication. Test recordings use OS temporary storage and are cleaned up.

## Files and licence

`src/` contains the HTTP service, protocol routes, store and evaluator. `test/` contains original synthetic tests. `docs/` contains compatibility, installer handoff and release-check records. Runtime content, diagnostic captures and SDK probes are excluded from release files; see the [release check](docs/release-check.md) for the whole-folder audit boundary.

Free to use, change and share under Apache License 2.0. The complete licence text, including its application appendix, is in [LICENSE.md](LICENSE.md). See [NOTICE](NOTICE), [LEGAL-NOTICE.md](LEGAL-NOTICE.md) and the [clean-room record](CLEAN-ROOM.md). Published by Coding Koalas Pty Ltd. Legal: legal@codingkoala.io.
