# Fork pi-durable-cloudflare as the base

Status: accepted, 23 Nov 2026

This project starts as a fork of earendil-works/pi-durable-cloudflare (MIT), not a fresh repo and not a copy of its storage adapter. The adapter, `openDurableObjectSqliteStorage`, is upstream pi-durable's own export, so copying it copies one import line. The fork's real value is `src/session.ts`, the Durable Object host with hibernating WebSockets, serialized alarm arming, and view restore after eviction, plus `test/recovery.test.ts`, which already proves resume after eviction against `cloudflare:test`. A fresh start would re-derive roughly 2,500 lines of failure behaviour by failing. Forking also gives us upstream's own fix to diff against each time experimental pi-durable breaks its API, which it has done once per recent release. We keep the upstream remote and the MIT notice, pin our dependency versions, and delete the demo tools and chat branding in a separate commit after the base is verified green.
