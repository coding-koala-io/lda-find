# Independent implementation record

LDA Local Find is maintained by Coding Koalas Pty Ltd.

## Sources and separation

The interoperability research process permits three sources: public documentation, our own observed requests, and private interoperability analysis of the client library under licence. Private research, library analysis and request recordings are kept outside this repository.

Researchers express the resulting functional specifications in their own words. Implementation uses those specifications only. Source citations in a specification are evidence references, not permission for an implementer to inspect the cited material.

For this build, the only behavior sources supplied to the implementer were the five numbered specifications covering overview, endpoints, query language, open questions and the minimum server. The implementer did not access research folders, decompiled material, vendor packages, assemblies, NuGet caches or vendor source. The supplied specifications state that no running-site traffic was available; this record does not claim that observed requests were used in this build.

The sibling LDA Local Graph repository provided organizational patterns: Node.js ES modules, source/test folders, built-in tests, local operation and the documentation structure. Its Graph protocol implementation was not reused as behavior or code for this service.

## Original implementation

Code, explanations, comments, fixtures and application messages were written for this repository. Short protocol identifiers retain their required spellings. Tests construct synthetic documents from the specifications' endpoint and query shapes. They do not include recorded traffic or customer content.

This repository contains no vendor source, decompiled output, packages, assemblies, logos, copied vendor documentation, raw captures or private research specifications.

## Review and evidence

On 17 November 2026, another model reviewed the implementation against the same permitted specifications. Its reported defects were corrected and covered by tests. This was a working-tree review, not a public-release history audit or a live CMS acceptance test. No commits were made for this build.

Public release requires a separate review of repository contents and history. Live compatibility still requires the synthetic CMS scenarios described in the private observation checklist; that evidence must remain outside this repository.

## Contact

Questions about independent creation: legal@codingkoala.io.
