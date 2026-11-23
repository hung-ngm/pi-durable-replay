# Client styling on Tailwind v4 and copied shadcn components

Status: accepted, 24 Nov 2026. Supersedes the styling sentence of ADR 0005.

The client takes the look of assistant-ui's Generative UI example. ADR 0005 kept styling in hand-written CSS against the unstyled primitives, to avoid a second styling system in a small client. Matching the example changes that trade. Its components are Tailwind v4 class lists over shadcn buttons and tooltips, and porting them by hand into plain CSS would mean translating every class list and losing the ability to pull later upstream changes. So the client uses Tailwind v4 through `@tailwindcss/vite`, the shadcn zinc tokens in oklch, and the example's components copied into the repo as source, in their Radix variants. `styles.css` is deleted once nothing reads it.

The runtime, the projection, and the message ids do not change. The theme follows the system colour scheme, with no toggle. Fonts are the system stack.

## Considered options

- Hand-port the look into `styles.css`. No new toolchain, but every class list is translated by hand and drifts from upstream.
- Install through the shadcn CLI and the assistant-ui registry. The CLI exits with code 2 when an agent runs it and assumes Next.js.
- The example's default Base UI variants. Equivalent, but the Radix variants compose with `asChild` and their collapsible animation reads Radix's content-height variable, which made them the simpler port to Vite.
