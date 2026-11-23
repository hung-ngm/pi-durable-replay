# Client chat surfaces on assistant-ui

Status: accepted, 24 Nov 2026

The transcript, composer, message actions, tool cards, and conversation list render through assistant-ui primitives (`@assistant-ui/react`) instead of hand-written components. SPEC said the client would be kept with no redesign. That held while the chat surfaces were small, but they grew their own scroll following, tool-result correlation, and keyboard handling, and the plain-Enter bug showed the cost of owning each of those. assistant-ui provides them as tested primitives.

The runtime is `useExternalStoreRuntime` over the existing `usePiSession` reducer. The Session Durable Object stays the only source of truth: the reducer projects each conversation view into assistant-ui messages, and user actions go back as the same protocol commands as before. assistant-ui's other runtimes own the message list themselves or speak HTTP, and either would make the client a second source of truth.

The Activity and Control panels stay plain React. assistant-ui has no primitives for a task graph or an operator dashboard. Styling stays in `styles.css` against the unstyled primitives, because `assistant-ui init` brings in shadcn and Tailwind, a second styling system for a client this small.
