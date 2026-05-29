# Product

## Register

product

## Users

Developers who already work inside an IDE coding agent (Cursor, Claude Code, Codex, or any MCP-compatible client) and want that agent to do grounded research before it edits.

Their context: a real, multi-repo application where behavior crosses boundaries (frontend to backend, shared types to generated clients, service to worker, schema to tests). They are technical, comfortable with terminals, Docker, env files, and MCP config. They run Agent Bridge locally as a sidecar and care about privacy, cost, and not sending code to hosted models unless they choose to.

The job to be done: stand up a local research instance, attach repos and knowledge files, wire up model providers, build or configure an agent, and expose it over the MCP bridge so their IDE agent can call it. On any given screen the primary task is configuration and verification, not consumption: connect a provider, watch a clone/index job finish, attach resources to an agent, confirm an agent is ready, read a run log to see what the agent actually did.

## Product Purpose

Agent Bridge is a local-first agent workbench and MCP bridge. It gives IDE coding agents a single grounded research interface over a codebase instead of a shallow grep loop, and it doubles as a workbench for building custom MCP-exposed agents with their own skills, tools, memory, and knowledge files.

It exists because coding agents edit well but research poorly: they see the current file and nearby snippets but do not naturally understand how an application is split across repos. Agent Bridge indexes the attached repos, understands the relationships between them, and wraps low-level graph and embedding queries behind higher-level workflows (find_in_codebase, trace_flow, assess_change_impact, debug_help, understand_module, list_repos).

Success looks like: a developer installs it, gets a repo indexed and an agent exposed over MCP in minutes, and their IDE agent starts returning answers grounded in the real shape of the codebase with citations back to file, page, and section. The app's job is to make that setup and verification path obvious, honest about state, and never in the way.

## Brand Personality

Precise, technical, honest. No hype.

Three words: grounded, exact, trustworthy.

Voice and tone: matches the README. Plain nouns and verbs that describe what the product literally does. Confidence comes from specificity and from being honest about limits ("local-first, not local-only"; "sidecar-first, not sidecar-only"; a whole "What Agent Bridge is not" section). The interface should read like a serious developer tool that respects the user's expertise: state clearly shown, no false reassurance, no marketing varnish. Emotional goal is calm confidence, not excitement.

## Anti-references

- **Hype-y AI product.** No glowing orbs, neon gradients, "supercharge your workflow" energy, or marketing buzzwords (streamline, empower, leverage, seamless, next-generation). This product is anti-hype by design and the UI must not undercut that.
- **Cluttered enterprise tool / devtools chrome.** No dense, every-feature-visible IDE chrome that overwhelms. Configuration is the work, but it should feel composed and progressive, not like a control panel with a hundred knobs exposed at once.
- **Generic SaaS dashboard.** Avoid the cookie-cutter template look: identical card grids, the hero-metric block (big number + small label + gradient accent), and decorative widgets that exist to fill space. Layout should follow the actual task, not a dashboard template.

## Design Principles

- **Show real state, honestly.** Clone, index, ingest, and run status are the core information surface. Live status pills, run logs, and readiness signals must be accurate and legible. Never imply success that has not happened; never hide a failure behind a spinner.
- **Practice what you preach.** This is a tool for grounded, precise research. The interface itself should be grounded and precise: specific labels, real evidence, citations that resolve, no vague affordances.
- **Configuration as a guided path, not a wall of options.** The work is setup (providers, repos, agents, resources, MCP config). Reveal complexity progressively, lead the user to the next concrete step, and keep the ready/not-ready state obvious. Power is available; it is not all on screen at once.
- **Quiet by default, loud only where it matters.** Restrained surface, one violet accent used deliberately. Save emphasis for the few moments that carry meaning: an agent becoming ready, a job failing, a destructive action.
- **Earn the user's trust on privacy and cost.** Be explicit where it counts: what runs locally, what leaves the machine, when a hosted provider will consume tokens. Surfaces that touch external providers or secrets should state the trade-off plainly.

## Accessibility & Inclusion

Target WCAG 2.2 AA.

- Body text meets >=4.5:1 contrast; large text >=3:1. The existing token system already shows contrast care (the light variant explicitly retunes semantic tones so they do not fail on white surfaces); keep that discipline.
- Full keyboard operability. The audience is keyboard-heavy developers; a command palette and shortcuts already exist and should stay first-class.
- Respect prefers-reduced-motion on every animation, with a crossfade or instant fallback rather than no consideration.
- Do not rely on color alone to convey state (clone/index/run status, success/danger/warn): pair color with text, icon, or shape.
