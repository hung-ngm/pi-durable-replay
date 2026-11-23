# Bun-only toolchain, with Vitest kept as a library

Status: accepted, 23 Nov 2026

The fork ships pnpm 11 and Node 22. We migrate it to Bun as the only package manager, lockfile, script runner, and local runtime, because the operator's whole stack is Bun and a second toolchain is permanent friction. One exception: Vitest stays as the test runner, invoked through `bun run`, because the Cloudflare workers pool provides `evictDurableObject`, `runDurableObjectAlarm`, and `runInDurableObject`, and `bun test` has no equivalent. Deleting the recovery tests to satisfy a toolchain rule would trade proof for purity. The deployed runtime is workerd either way, so Bun is a development toolchain decision, never a production runtime claim. The migration is its own commit, gated on `bun install`, `bun run check`, and the full suite green. If the workers pool breaks under Bun, we stop and report rather than keeping a silent Node path.
