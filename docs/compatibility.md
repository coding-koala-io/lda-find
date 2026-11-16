# Part 1 coverage and implementation choices

This report records the minimum-server build on 17 November 2026. Behavior was implemented from the five supplied specifications only. Endpoint labels below refer to the endpoint specification's identifiers; the private specifications and their source citations are not copied into this repository.

## Coverage of the minimum-server ranks

| Rank | Implemented | Remaining boundary |
| --- | --- | --- |
| 1: connection | E14 settings with a non-null item, E15 features without service queue, E17 language reads. Full tenant/key prefix is required. | The settings language-item representation and real CMS settings gate still need runtime validation. No hosted credential validation. |
| 2: lifecycle | E01 explicit/generated single writes; E02 reads; E03 deletes; E04 ordered bulk; E07 scoped query deletion, including delta cleanup; E16 refresh on/off; E17 language clear. | Advanced write controls, delayed visibility and attachment extraction are absent. Scheduled external-best-bet reindexing remains unverified. |
| 3: visitor search | E08 search and E09 count across indices/types. Full text, hierarchy/exact type predicates, suffix/path resolution, Boolean composition, existence, missing through negation, prefix, numeric/date ranges and CMS identity projection. | Full hosted analysis/relevance parity and real CMS hydration remain unverified. Unsupported DSL nodes fail instead of being discarded. |
| 4: result page | Term/filter facets, facet filters, separate hit filters, sort/paging, fields/partial fields and basic highlights; E11 multi-search; E10 multi-get. | E06 script update is deliberately unimplemented. Advanced facet families, nested/geo sorting, scripts and hosted highlight parity are absent. |
| 5: extensions | Capabilities report statistics/admin/queue disabled. Ordinary documents may contain external-target fields. | No best-bet management/query integration, unified weights, synonyms, automatic scoring presets, autocomplete/statistical suggestions, spellcheck/related queries, tracking/click/GDPR operations, mapping/exploration/admin APIs or E05 service queue. |

There is no claim of full Foundation compatibility: a site that calls an omitted operation needs that feature implemented. No successful placeholder response is supplied for it. Unknown routes use 404 or 501; unsupported DSL/options use 400. Script updates are not reinterpreted as partial document writes.

## Endpoint shape tests

The specifications describe shapes in tables rather than supplying a complete recorded exchange. Fixtures are original synthetic instances of those shapes.

| Tests | Contracts exercised |
| --- | --- |
| `test/protocol.test.js` | E01–E04 identity, replacement, source, generated ID, 404 envelopes and action-wrapped bulk outcomes; E07 delta cleanup and shard acknowledgements. |
| `test/protocol.test.js` | E08/E09 integer totals, hit identity, count, scopes and count search type; E10 document order/missing results; E11 LF/CRLF metadata/body pairs and response order. |
| `test/protocol.test.js` | E14 item/capabilities/headers, E15 empty features, E16 body-free controls, E17 string-array/Boolean responses; prefix and error contracts. |
| `test/search.test.js` | Twenty-page/two-type end-to-end search; visibility predicates, type and suffix conventions, query/hit-filter facet populations, sorting, page totals, projections, highlights and rejection of unsupported input. |
| `test/persistence.test.js` | Restart fidelity, version/settings persistence, fail-closed corrupt data, rollback after write failure and prototype-shaped fields/identities. |

The end-to-end corpus has 20 synthetic pages. Six are excluded by access, expiry, deletion, language, publication start or site. The query population is 14, split into seven records per category and seven per concrete content type. The hit-only article filter leaves seven hits. Descending rank with offset two and size three returns `page-16`, `page-14`, `page-12`. Facets continue to count all 14 eligible records.

## Decisions where the specifications leave execution open

| Ambiguity | Choice in this build |
| --- | --- |
| Rejected local key status and single-write success status | Exact full-prefix comparison; wrong prefix returns 403. First write returns 201, replacement 200. No Authorization challenge or header is invented. |
| Missing document status/body | GET returns 404 with nonempty identity, version zero and `exists:false`; DELETE returns 404 with `ok:true` and `found:false`. These preserve the modeled special-handler envelopes. |
| Settings item types and language encoding | Use Boolean false for disabled `stats`, `admin` and `connectors`, a string version and null `max_docs`. The specs require a languages array without defining its elements. Use `['en']`, with English token matching as the tested profile. Real converter acceptance is unverified. No hosted stemming is claimed. |
| Specific-language population | List unique `language_routing` values from successful writes until clear. It is not inferred from a document's application-specific language field. Clearing does not delete content. |
| Refresh and persistence timing | Immediate visibility regardless of refresh switch. Save `data/store.json` through temporary-file replacement before acknowledgement. One process per data directory; no multi-process locking or write-ahead recovery. Memory and versions roll back on persistence failure. |
| Bulk create, malformed framing and missing targets | `index` replaces; `create` on an existing identity produces one 409 item error. Missing deletes succeed as items with `found:false`. Malformed JSON/framing rejects the whole HTTP request before writes; valid framing can contain independent failed items. No final newline is required. |
| Default free-text operator and scoring | OR when omitted, explicit AND supported, implicit NOT excludes. Scores count matched selected fields with numeric weights; ties keep storage order. Zero boosts retain eligibility. This is local ranking, not hosted scoring. |
| Analyzers and language variants | Unicode word tokens with lowercase comparison. Analyzer labels use this same local matcher; synonym analyzers are rejected. No stemming, fuzzy spelling, linguistic normalization or hosted relevance formulas. Exact base fields remain case-sensitive, `.lowercase` folds text, analyzed variants yield words and `.sort` folds the original string. |
| Date execution | ISO dates and `now` with optional signed seconds/minutes/hours/days/weeks and `/m` rounding. One timestamp per search evaluation. Bounds default to inclusive; omitted/null bounds are open. No calendar arithmetic or timezone-specific analysis. |
| Default limits, sort and facet order | Ten hits by default; nonnegative offsets, size at most 1,000, no separate 10,000-result window. Missing sort values go last unless requested first, independently of direction. Term facets count each value once per document, sort by count descending then term text, default to ten terms; size zero returns none. |
| Query and hit filter population | Query, query-side filters and minimum score select the facet population. Body-level `filter` only narrows hits and their total. Each `facet_filter` narrows its own facet population. Neither paging nor sorting changes facet counts. |
| Projections and highlights | Return nested, suffixed field structure, retaining arrays, nulls and empty objects. Multiple partial selections merge into `fields`. Default highlight markers are `|pre|`/`|post|` for client substitution; explicit tags are respected. Zero fragments returns the full matching value. Fragment selection and substring highlighting are simple local approximations. |
| Routing, timeout and storage controls | Routing/preference/cache/client-feature headers are accepted as transport hints; they do not partition or filter content. Language routing supplies the recorded language list. Refresh does not delay visibility. TTL, version preconditions, parent/percolation, replication and consistency options are rejected on writes. |
| Multi-search errors and limits | Preserve component order; an invalid component fails the entire request, because the specified response model has no component error contract. No inferred ten-search limit; framed requests are bounded by the body/record limits. |

## Supported evaluator scope

The evaluator handles `query_string`, field text queries, match-all, constant-score, filtered, term/terms, prefix/wildcard, IDs, exists/missing, and/or/not/bool, query/fquery wrappers and basic nested isolation. Numeric `function_score`, `custom_filters_score` and `dis_max` compose local scores. All scoring is approximate. Wildcards operate on tokens in text queries and whole values in wildcard predicates.

Not implemented: fuzzy queries/options, child relations, more-like-this, boosting queries, custom/script scoring, native auto-boost/decay/hit-count presets, script filters/fields, geo predicates, histogram/date/range/statistical/geo/nested facets, all-terms facet expansion, nested/geo sorting and external attachment extraction. Unsupported query members are rejected even on an empty index. Broad text grammar is limited to words, phrases, parentheses, field selection, AND/OR/NOT and wildcards; it is not a complete query-string parser.

## Operational limits and acceptance still required

Requests have a 16 MiB body limit, framed requests at most 20,000 records, headers a 15-second timeout and complete requests a 30-second timeout. The evaluator scans the in-memory corpus on one JavaScript thread. Persistence rewrites the complete JSON state on a mutation. Use small development corpora; these are resource limits, not hosted quota emulation. A failed save returns HTTP 500; this build does not inject 429 responses or reproduce client retry scheduling.

Before claiming CMS compatibility, run the target CMS 12 version through startup/settings, multilingual publish/edit/delete, full reindex including external-best-bet behavior, real visitor/UI queries, repository hydration and fault recovery. Runtime evidence is also needed for settings language conversion, actual analyzer names, enabled extensions, reserved/non-ASCII URL behavior, caching and queue policies. Tests of this service alone cannot close those gaps.

Part 1 does not add an admin UI, request capture, Windows service management, release packaging or public publishing. No telemetry or external service calls are present. Documentation and tests contain synthetic keys only.
