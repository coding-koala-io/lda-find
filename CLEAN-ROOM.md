# How this software was built (clean-room record)

LDA Local Find is published by Coding Koalas Pty Ltd.

This document records how the compatible behaviour was worked out and written. It follows the structure of the LDA Local Graph clean-room record.

## 1. Sources of knowledge

Behaviour was worked out from three sources:

1. **Public documentation:** public developer documentation, SDK documentation and API references.
2. **Observed requests from our own local site:** the licensed CMS 12 Foundation sample, its own indexing job and search page, and original local SDK interoperability probes. This release's real-site acceptance results are the project owner's report of 17 November 2026, recorded in the README. No client site or client content is required by the implementation or its published tests.
3. **Private interoperability analysis of the licensed client library:** analysis to establish the request and response contracts needed for compatibility. Research notes and decompiled material belong only in the private research folder, outside the published repository, and are never published.

### Permission record — 17 November 2026

Optimizely gave a written go-ahead for local-development use, on file privately.

## 2. Separation between research and code

Functional specifications describe endpoints, fields, status codes and required behaviour in original words. Short protocol identifiers retain the spellings needed to interoperate.

The work used separate model roles: **one model wrote the specifications, another wrote the code, and a third reviewed it**. The initial implementation used the functional specifications. Later authorised interoperability corrections also used private client analysis and original local SDK probes, as recorded in the existing compatibility report; this record does not claim that every correction was made without research access.

Implementation, comments, application messages and regression fixtures are original. Published tests reproduce functional request shapes with synthetic values, not copied vendor implementation or captured site documents. LDA Local Graph supplied project and documentation patterns, not its protocol implementation.

Round 7 used our own functional specifications and observed HTTP request contracts only; no Optimizely implementation code was copied or consulted for these fixes.

## 3. What this repository does and does not contain

The release files contain original JavaScript, original documentation and synthetic test data. **No Optimizely source code, decompiled code or binary is shipped.** No assemblies, NuGet packages, vendor logos, copied vendor documentation, raw traffic captures, client content or private research files belong in the release.

Diagnostic and probe artifacts from earlier experiments have been relocated outside this repository to private research storage. The whole-folder clean-room gate passes with **0 findings**. The private Foundation proof store remains in place, ignored and excluded from publication. See [docs/release-check.md](docs/release-check.md); a passing gate does not authorize publishing runtime data or private research.

## 4. Audits

Release checks cover the current tracked/untracked release files, reachable Git history and ignored local artifacts separately. They check for credentials without displaying values, client names, decompilation markers, vendor binaries, captures and private research material. Pattern checks cannot certify the absence of every unknown client name or verbatim fragment.

| Date | Scope | Checked by | Result |
| --- | --- | --- | --- |
| 2026-11-17 | Current whole folder including ignored files, excluding Git internals | Round-7 implementation check | Clean-room gate passes with 0 findings; diagnostics relocated. Earlier content/history audit scope is preserved in the [release check](docs/release-check.md). No commit or publication performed. |

The project owner completed the real CMS 12 Foundation proof: the site's built-in job reported 811 items, with 809 stored documents in the later admin-screen run; jacket and shoes searches displayed six and eight products; a no-match search displayed "No products matched". `CartPage` and `LayoutSettings` fail within the sample before a request is sent. This acceptance evidence is distinct from the synthetic test suite and was not rerun during round 7.

## 5. Retention of private research

Private interoperability analysis is retained only in the private research folder under the internal research-handling policy, never published. Permission evidence remains on file privately. Do not move research or correspondence into this repository to support this record.

Runtime stores and opt-in search recordings can contain private content. Exclude them from releases and keep diagnostic evidence outside repository folders. Legacy diagnostic artifacts have been relocated; the gate checks for recurrence.

## 6. Questions

legal@codingkoala.io
