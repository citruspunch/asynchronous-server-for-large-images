# AGENTS.md — presentation/

A separate Vite + React slide deck about UltraTile. **Not part of the
server.** `build.sh` does not touch it, `src/main/java` does not reference it,
and its `dist/` is gitignored and rebuilt from source.

If your task involves the server, the protocol, the viewer, or the import path,
you are in the wrong directory: use the root `AGENTS.md` instead.

## Stack

- Vite 6, React 18, Recharts 3
- `npm run dev` (dev server), `npm run build` (single-file output to `dist/`),
  `npm run preview`
- ES modules and JSX; no TypeScript in this app

## Rules that differ from the repository root

- **Node and npm are required here.** They are forbidden for the server build,
  so do not let a habit from the server side leak in.
- **Dependencies may be added** from npm, unlike the server runtime, which must
  stay JDK-only.
- **`dist/` is generated.** Never hand-edit it and never commit it; it is
  gitignored. Edit `src/` and rebuild.
- **Content is about the system but lives here.** If a slide makes a claim about
  UTP behavior, limits, or measurements, that claim has the same owner as
  everywhere else: `docs/protocol/UTP-1.0.md` for wire semantics and
  `docs/implementation/configuration-and-limits.md` for current constants. If a
  slide drifts from those, the slide is wrong.

## Before finishing

- `npm run build` succeeds.
- Figures on slides that state a limit or a measurement match the owning
  document in `docs/`.
