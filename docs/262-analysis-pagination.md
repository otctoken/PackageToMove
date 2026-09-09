# Large dependency graph analysis regression

Package: `0x2622964a414ca9e9b25fb8448fd2c915d161bdba699e8a5dd594a665c7e3ef1b`

Network: mainnet. Measured locally against live GraphQL on 2026-09-09.

## Failure mechanism

The root is a version 1 package with one module, `m`. Its linkage contains
20 dependencies (including two skipped system packages). The transitive graph
contains 21 packages, 231 modules and 3,822 functions. Analysis needs 58 upstream
module-page requests.

The old frontend waited for the entire graph in a single `/api/analyze` call.
The combined JSON is approximately 7.57 MB, exceeding Vercel's 4.5 MB function
response limit. Network delays also accumulate within that invocation's 60-second
budget. A platform error may be plain text starting with `An error occurred`;
calling `response.json()` then obscures the underlying error with a SyntaxError.

Platform reference: https://vercel.com/docs/errors/function_response_payload_too_large

The production site could not be reached from the test host (connection timeout),
so its exact HTTP status and platform logs were not observed. The size failure
is established by the live graph data, not inferred from a production log.

## Change and verification

The frontend now requests one GraphQL module page per server invocation, first
loading the root and then traversing dependencies with bounded concurrency.
Each continuation pins the package version; address, digest, linkage, duplicate
module names, bytecode hashes and cursor progress are checked. System addresses
`0x1` through `0x8` remain skipped. Incomplete graphs cannot be exported as
complete projects. There is no truncation of source or bytecode to fit a response.

Actual local Next.js route + live mainnet test:

| Measurement | Result |
| --- | --- |
| Root ready | 1,758 ms |
| Complete graph | 26,802 ms |
| Page requests | 58 |
| Largest page response | 630,427 bytes |
| Slowest page request | 2,339 ms |
| Aggregated result JSON | 7,570,063 bytes |
| Package/module/function totals | 21 / 231 / 3,822 |
| Unavailable packages / warnings | 0 / 0 |

These timings are one local measurement, not a production performance guarantee.
Two of the 21 packages are skipped system metadata records, not decompiled modules.

The root module independently passed the existing Rust verification/decompilation
path in about 145 ms (9 functions, 75 bytecode instructions). Its bytecode SHA-256:
`3f1f7cd2f93bb8076c880f6139fa06120ba4e3a48b605963ed4c5551320ea76a`.
This does not certify the semantic equivalence of all dependency source output.

Automated regressions cover graph results larger than 4.5 MB assembled from
smaller pages, one upstream request per page, identity/linkage drift, duplicate
modules, repeated cursors, skipped systems, incomplete export rejection,
cancellation, timeouts, and non-JSON platform errors. Run `npm test`.

JSON responses have a server-side 4 MB guard. Exceptionally large individual
pages still fail explicitly; the code does not silently omit modules. Legacy
non-paged API callers remain supported but should migrate to `mode: "page"`.
The decompiler implementation and fail-closed audit policy are unchanged.
