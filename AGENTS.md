# omp-compaction DOX

This folder owns the `omp-compaction` repository: an OMP extension that lets a long-running agent manage its own context window (self-compact). It is a port of `disler/self-compact-pi-agent` (MIT, IndyDevDan) adapted to the OMP extension API.

## Layout

- Repo root IS the extension root: `index.ts` plus `state.ts`, `thresholds.ts`, `context-bar.ts`, `prompts.ts`, `settings.ts`, `roles.ts`, `menu.ts`, `defaults.ts`, and `prompts/` (upstream prompt files, verbatim).
- `upstream/self-compact-pi-agent/` — the upstream Pi clone, kept for reference and diffing. Gitignored; never commit it.
- `self-compact.example.json` — documented settings example; the live file is `~/.omp/agent/self-compact.json` (not in this repo).
- Remote: `https://github.com/demetre19/omp-compaction` (public, `main`).

## Boundaries

- The extension is NOT installed globally. `~/.omp/agent/extensions/` must not contain it unless the user explicitly installs it. Test per-invocation: `omp -e /Users/apple/Documents/UNCLUTTER-NEW/CLAUDE-DEV/omp-compaction`.
- `~/.omp/agent/self-compact.json` is the live settings file; it seeds `compactDisabledRoles: ["default"]` and `compactDisabledModels: ["devin/swe-2"]` so SWE-2 sessions are hands-off.
- Credit upstream (disler/self-compact-pi-agent, MIT) in README and LICENSE; keep the copyright lines intact.

## Verification

- Syntax: `bun build index.ts menu.ts roles.ts settings.ts prompts.ts state.ts thresholds.ts context-bar.ts defaults.ts --outdir /tmp/sc-build --external '@earendil-works/*' --external 'typebox'` must exit 0.
- Load: `cd /tmp/<scratch> && omp -p -e <this folder> "reply with exactly: ok"` must print no `Extension error`.
- Full behavior (menu, compaction cycle) requires an interactive TUI session; verify on the actual surface before claiming it works.
