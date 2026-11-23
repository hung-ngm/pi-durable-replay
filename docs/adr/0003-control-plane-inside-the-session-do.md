# Control plane inside the Session Durable Object

Status: accepted, 23 Nov 2026

Kills, budgets, and replay live inside the Session Durable Object, in the same atomic commits as the transcript they govern, rather than in a separate control service watching sessions from outside. The alternative, a second Worker or DO acting as a WebSocket client of each session, buys a cross-session dashboard at the cost of a second source of truth, abort races against runs it does not own, and a server-side protocol client to build and test. V1 has one operator and no cross-session requirement, so the extra service earns nothing. Control state is a typed document beside the transcript (`ControlDoc`), which means a budget change and the run it affects can never disagree after a crash. A separate control service can still be added later without changing the protocol, because the client already issues kills and replays as protocol commands.
