# omp-compaction DOX

This folder owns the `omp-compaction` repository: an OMP extension that lets a long-running agent manage its own context window (self-compact). It is a port of `disler/self-compact-pi-agent` (MIT, IndyDevDan) adapted to the OMP extension API.

## Layout

- Repo root IS the extension root: `index.ts` plus `state.ts`, `thresholds.ts`, `context-bar.ts`, `prompts.ts`, `settings.ts`, `roles.ts`, `menu.ts`, `defaults.ts`, `jev-prune.ts`, `vendor/fast-jev/`, and `prompts/` (upstream prompt files — `USER_PROMPT_SOFT_SELF_COMPACT.md` is locally modified: the "For awareness" paragraph was replaced with a do-not-acknowledge/do-not-poll directive to stop notice-acknowledgment spam; keep `BUILTIN_PROMPTS.soft` in prompts.ts in sync when editing it).
- `upstream/self-compact-pi-agent/` — the upstream Pi clone, kept for reference and diffing. Gitignored; never commit it.
- `self-compact.example.json` — documented settings example; the live file is `~/.omp/agent/self-compact.json` (not in this repo).
- `vendor/fast-jev/` — vendored MIT sources from `tamaratran/fast-jev-compaction` (`compact.ts`, `state.ts`, `request.ts`, `types.ts` + `LICENSE`), used by `jev-prune.ts` for the optional verdict-prune pre-stage: it asks Jev (TypeSafe System One) to score every tool call in `messagesToSummarize`, drops/truncates losers in place, then the normal LLM summary runs on the smaller input. Transports ladder per compaction: openrouter (`typesafe/jev-1.13` via `api/alpha/decisions`) → openlux (`jev-1.13.0`) → typesafe (`jev-latest`); keys come from `OPENROUTER_API_KEY`/`OPENLUX_API_KEY`/`TYPESAFE_API_KEY` env, `~/.omp/agent/agent.db` `auth_credentials` rows, or `models.yml` secret directives — never stored by this extension. Any transport failure (including out-of-credits) falls through the ladder; total failure skips pruning silently (notify once) and native compaction proceeds unchanged. Settings: `compactJev*` keys in `self-compact.json` + `--compact-jev off` flag. `bun:sqlite` is used to read agent.db, so keep `--external 'bun:sqlite'` in the build check below.
- Remote: `https://github.com/demetre19/omp-compaction` (public, `main`).

## Machines

- Mac mini (this checkout): leader. The MacBook Pro keeps a clone at the same path (`~/Documents/UNCLUTTER-NEW/CLAUDE-DEV/omp-compaction`, cloned 2026-09-22 via `macbookpro-codex`, no `upstream/`); update it with `git pull` there or `sync-claude-dev push omp-compaction`. `~/.omp/agent/self-compact.json` is mirrored to the MacBook too — `model-sync` does not cover it, copy it manually when it changes.

## Boundaries

- The extension is NOT installed globally. `~/.omp/agent/extensions/` must not contain it unless the user explicitly installs it. Test per-invocation: `omp -e /Users/apple/Documents/UNCLUTTER-NEW/CLAUDE-DEV/omp-compaction`.
- `~/.omp/agent/self-compact.json` is the live settings file; it currently sets `compactReferenceWindow: "1m"` so every model compacts at the same absolute tokens (~200k warning). `compactDisabledRoles`/`compactDisabledModels` are empty — nothing is disabled by default.
- Credit upstream (disler/self-compact-pi-agent, MIT) in README and LICENSE; keep the copyright lines intact.

## Verification

- Syntax: `bun build index.ts menu.ts roles.ts settings.ts prompts.ts state.ts thresholds.ts context-bar.ts defaults.ts jev-prune.ts --outdir /tmp/sc-build --external '@earendil-works/*' --external 'typebox' --external 'bun:sqlite' --target bun` must exit 0 (Bun ≥1.3 defaults to browser target without `--target bun` and fails on `node:url`).
- Load: `cd /tmp/<scratch> && omp -p -e <this folder> "reply with exactly: ok"` must print no `Extension error`.
- Full behavior (menu, compaction cycle) requires an interactive TUI session; verify on the actual surface before claiming it works.
