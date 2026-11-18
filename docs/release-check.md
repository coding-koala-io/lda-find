# Release preparation check — LDA Local Find, round 9b

Date: 17 November 2026. Existing working-tree changes were preserved. Rounds 9 and 9b used the repository's original code and specifications, the supplied Overview facet contract (clarified in round 9b) and the round-4 P1 review's functional description. No vendor implementation, decompiled code, private capture or installed SDK was consulted or executed. No commit, push, publication, running-service restart or live CMS mutation was performed.

## Current whole-folder status

Diagnostics were previously relocated to private sibling research storage outside this repository. `node scripts/check-clean-room.js` passes with **0 findings**, including ignored files and excluding Git internals and the root `dist/` release output directory. No diagnostic files were moved or deleted in rounds 9 or 9b. The private `data/foundation-proof/store.json` remains in place and excluded from publication.

`npm run release:build` writes the release assets to `dist/`. Use `npm run release:build -- <output-directory>` to write them to an external directory.

A passing gate checks prohibited artifact patterns; it does not certify authorship or approve publication. Earlier historical file/blob audits and SDK replays were not rerun in this clean-room round.

## Round-9 corrections, with round-9b facet clarification

| Area | Current behavior and regression evidence |
| --- | --- |
| Terms facet counters | Every terms facet includes `total`, the sum of ALL term counts within the query and facet-filter scope, including terms omitted by `size`. `other` is `total` minus the sum of returned term counts. Missing documents are counted separately. Both counters are zero on an empty index; `other` is zero when every term is returned. Original synthetic Overview tests cover type, language and site facets. Truncation tests cover multi-valued documents, duplicate values/fields, size zero, missing values, query/facet-filter scope and independence from hit filters and paging. Round 9b corrects the earlier returned-only total and uncovered-document interpretation of `other`. |
| Bounded document GET | `getDocument()` uses the shared `ResponseBudget` implementation with the same 16 MiB limit as search. Metadata, full source and every explicit field projection consume capacity; overlapping and repeated selections count separately, including overwritten selections. Overflow stops construction before later fields are visited and returns a short 413. Small projections, ordinary source reads and missing-document responses retain their behavior. README now documents the enforced GET limit and facet counters. |

`test/fix-round9.test.js` contains **6 tests**: the original 5 with corrected facet expectations, plus the round-9b size-5 regression. That regression uses an original synthetic distribution matching the supplied Foundation counters: **813 total term counts**, **626 returned counts** and **187 other counts**. Returning every term gives **total 813** and **other 0**. One additional document without the field is counted only in `missing`; no Foundation proof data is loaded. The multi-valued regression now expects `total 5` and `other 3` for size 1, and `total 5` and `other 5` for size zero.

The round-4 P1 regression reconstructs a **338-byte application path** (excluding the service prefix) selecting **17 overlapping paths, `a`, `a.a`, ...**, from one original synthetic **1 MiB value**. It verifies HTTP **413** with a response shorter than 250 bytes instead of a roughly 17 MB 200 response; two projections still return 200. No literal request was supplied by the review. Additional tests cover repeated selections, UTF-8 byte accounting, stopping before a throwing later field, oversized source reads, small field selections and 404 responses. Existing full-facet assertions were updated for the two new members. README describes the clarified counters.

## Round-9b validation and acceptance boundary

`npm test` (invoked as `npm.cmd test`) passes: **111 tests, 111 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo**, in **13.329 seconds**. The targeted round-9 run passed **6 tests**. Before the implementation correction, the two updated/new facet regressions failed with the old arithmetic, including `total 626` instead of `813` in the size-5 case. An independent static review found no facet code or test regressions. `node scripts/check-clean-room.js` passes with **0 findings**. `git diff --check` passes; Git reports only LF/CRLF normalization notices.

No live CMS admin-screen rerun was performed and no running server was restarted. The Overview contract and GET limits were verified through synthetic local HTTP tests. Tests use memory stores or cleaned OS temporary storage; no proof-store content was loaded into the tests.

Foundation proof SHA-256 captured before and after round 9b (same as round 9):

```text
304dfd6efa21dd647a682a9a131daf7660a0f88d691931194f53b97a8ef3910c
```

The proof store is byte-for-byte unchanged in rounds 9 and 9b. Its starting hash differs from the prior round-8 record below; the current file was preserved as found.

## Previous round-8 corrections

| Area | Current behavior and regression evidence |
| --- | --- |
| Repeated Origin | Body requests accept comma-separated repetitions only when every trimmed entry is the same allowed HTTP(S) loopback origin. Mixed ports, hosts or schemes, external entries, empty entries and malformed origins receive 403. Raw repeated header lines are covered. Host enforcement and IPv4 loopback binding remain active. |
| Proxy content type | Search/count and single-document/multi-get routes accept JSON labelled `application/x-www-form-urlencoded` or `text/plain`, including charset parameters. Exactly one JSON value and normal endpoint shapes are required. Actual forms, empty/malformed JSON, concatenated values and trailing data receive 400. Bulk, multi-search and Statistics keep their existing media requirements. Overview and Explore regressions use the supplied structures with synthetic documents. |
| Search output budget | One 16 MiB construction budget covers envelopes, hit metadata, source/explicit/partial/crop fields, highlights and facets. Aliases, copies, overwritten selections and repeated hits consume capacity. Multi-search shares that budget across components. Projection fragments are charged before retention; JSON accounting walks values without serializing the assembled response. Highlight pieces are charged before tag expansion. Overflow returns a small 413. Conservative reservations can reject final JSON just below 16 MiB. |
| Compound predicates | Each field compiled by term/terms/prefix/wildcard/range consumes the shared 1,024-unit budget, alongside DSL nodes, text terms and term-list values. Query, hit-filter and facet branches share it. One term clause with 1,025 fields returns 400 before scanning both empty and populated indices; ordinary compounds still match. |
| Logs and licence | 4xx/5xx request lines include a fixed short error code, including direct 404/501 replies and unexpected 500s. Bodies, error messages, header values and query values are omitted. `LICENSE.md` contains all nine Apache 2.0 sections and the complete application appendix from the Apache Software Foundation's licence text. README and compatibility documentation describe these rules. |

`test/fix-round8.test.js` adds **8 tests**. The review's amplification regression uses a **444-byte request with 17 aliases selecting one synthetic 1 MiB document** and verifies a short HTTP 413 instead of a roughly 17 MB response. The review did not include literal request bytes; the fixture reconstructs the described shape and pads valid JSON with whitespace to the exact stated size. Two copies succeed. A budget interruption regression proves the third alias is never constructed after the second copy overflows. Other checks cover explicit/source projections, highlights, facets and multi-search. The existing round-7 log regression and unsupported-media regression were updated for the new contracts.

## Previous round-8 validation and acceptance boundary

`npm test` (invoked as `npm.cmd test`) passes: **105 tests, 105 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo**, in **17.591 seconds**. The earlier targeted run passed all **38 tests**. `node scripts/check-clean-room.js` passes with **0 findings**. `git diff --check` passes; Git reports only LF/CRLF normalization notices.

No live CMS admin-screen rerun was performed and no running server was restarted. Browser acceptance remains unverified for these new proxy fixes. Tests use original synthetic content, memory stores or cleaned OS temporary storage; no proof-store content was loaded into the tests. CLI registration remains a separate handoff; see [lda-install-find.md](lda-install-find.md).

Foundation proof SHA-256 captured before and after round 8:

```text
777e6494754fc0055b41673c35d850c23b2a8522be65b11a67e689e624852523
```

The proof store was byte-for-byte unchanged in round 8. That starting hash differs from the historical round-7 report's `9643aa6c91a2c5dcb926f17df846c4dcd413ed3824b2002b9c7aa39536d0bf05`; the file was preserved as found in that round.
