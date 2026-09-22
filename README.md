# omp-compaction — self-compact for Oh My Pi

**An OMP extension that lets a long-running, autonomous agent manage its own context window.** Ported from [disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent) (Pi, v0.85.1) — all credit for the design and the original implementation goes to IndyDevDan ([@disler](https://github.com/disler)). This repo is the OMP adaptation; upstream remains the canonical source for the concept and the Pi version.

## What it does

The agent watches its own context gauge:

- **Notice threshold** — a transient heads-up message reaches the model once per crossing (re-armed when usage drops back below the soft line, on session recover, and after each compaction). Warning and forced guidance still inject on every call until the agent acts — they demand action; the notice doesn't.
- **Warning threshold** — the agent is told to write a `note_to_self` and call `self_compact`.
- **Forced threshold** — every tool except `self_compact` and `view_context` is blocked until compaction succeeds.

`self_compact({ note_to_self })` saves the note, ends the run, and compacts once the agent is idle — using a summary prompt you control. The note comes back as the next message under a `[self-compact · handoff]` status line carrying the post-compaction numbers and an all-clear/still-high verdict, so the agent resumes its `NEXT ACTION` with no human message, no lost intent, and no blind re-compaction of a clean context. Failures keep the note and the lock, retry automatically (up to 3×), and survive reloads, tree navigation, and crashes.

A colored one-line gauge sits below the editor: a 20-cell context bar (`#` cached, `=` used, `-` free; `~`/`!`/`|` threshold markers) whose fill heats up with the phase — green at idle, accent at notice, orange at warning, red at forced — plus used/window tokens, the phase tag, and the threshold legend. OMP's `setFooter` is a no-op stub, so the gauge renders through `setWidget` (ANSI-preserving); non-TUI modes fall back to a plain `setStatus` line.

## Install

```bash
# Global (every session) — clone into the extensions dir, or symlink a checkout:
git clone https://github.com/demetre19/omp-compaction ~/.omp/agent/extensions/omp-compaction
# or: ln -s /path/to/omp-compaction ~/.omp/agent/extensions/omp-compaction

# Per-invocation (testing):
omp -e /path/to/omp-compaction

# Auto-load when cwd is the repo (committed .omp/config.yml):
cd omp-compaction && omp
```

Then configure via `~/.omp/agent/self-compact.json` (created on first write, or copy the example below) — or just run `/self-compact-settings` inside OMP.

## Settings

`/self-compact-settings` opens an interactive menu: enable/disable, a session-only toggle, thresholds (preset picker), disabled roles (checkbox list over your `modelRoles`), disabled models, and the compaction prompt. Changes write `self-compact.json` and apply **live** — including turning the extension off mid-session.

**Quick toggle:** `/self-compact-toggle` (or `ctrl+shift+k`) flips self-compact off/on for the current session only — nothing is written to disk, so it's the fast way to ride out a PRD approval phase and turn protection back on after. `/self-compact-toggle off` / `on` set it explicitly. To start a run already hands-off, launch with `--compact-off`.

`self-compact.json` lookup order (first file wins): `<cwd>/.omp/self-compact.json` → `<cwd>/.pi/self-compact.json` → `~/.omp/agent/self-compact.json` → `~/.pi/agent/self-compact.json`.

```json
{
	"enabled": true,
	"compactSoftAt": "10%",
	"compactAt": "20%",
	"compactBuffer": "5%",
	"compactReferenceWindow": "1m",
	"compactDisabledRoles": [],
	"compactDisabledModels": []
}
```

| Key | Meaning |
| --- | --- |
| `enabled` | Master switch. `false` = fully hands-off (no guidance, no lock, native compaction untouched). |
| `compactSoftAt` | Notice threshold: `"10%"`, `"100k"`, `"270000"`. |
| `compactAt` | Warning threshold — agent asked to write its note and compact. |
| `compactBuffer` | Allowance above `compactAt` before other tools are blocked (`0` = immediate). |
| `compactPrompt` | Literal text replacing the compaction summary prompt. |
| `compactReferenceWindow` | Fixed window that `%` thresholds resolve against (e.g. `"1m"`). With `"1m"`, `10%`/`20%`/`5%` mean notice at 100k, warning at 200k, forced at 250k **absolute tokens on every model** — a 500k model compacts at the same ~250k mark as a 1M model, and a 250k/262k model compacts at its 90% cap (~225k/236k). Windows too small to fit the warning plus ~20k wrap headroom under the cap (~245k and below) stay hands-off. Unset = the model's own window (upstream behavior). |
| `compactDisabledRoles` | `modelRoles` names whose resolved model never self-compacts (e.g. `["default"]`). |
| `compactDisabledModels` | `provider/model` or `provider/*` entries that never self-compact. |
| `compactModelThresholds` | Per-model threshold overrides: `{ "provider/model" | "provider/*": { "compactSoftAt"?, "compactAt"?, "compactBuffer"? } }`. Exact model keys beat `provider/*` wildcards; CLI flags still win. Use it to raise the bar only on big-window models — e.g. `"devin/claude-fable-5-1": { "compactAt": "60%" }` warns at ~600k of a 1M window while every other model keeps the defaults. |

CLI flags (`--compact-soft-at`, `--compact-at`, `--compact-buffer`, `--compact-prompt`, `--compact-disable-role`, `--compact-disable-model`, `--compact-reference-window`, `--compact-off`) override file values. Thresholds resolve against `compactReferenceWindow` (or the model's own window when unset), capped at 90% of the real window.

**Same absolute trigger on every model.** Set `compactReferenceWindow` once and percentages become fixed token counts: `20%` of a 1M reference = 200k whether the model's window is 1M or 500k. With the defaults above, every model large enough compacts at ~250k absolute (or its 90% cap, whichever is lower); windows under ~245k never self-compact.

**Why disable a model?** Some models shouldn't self-compact at all — e.g. a provider whose compaction endpoint is unreliable, or a model you want on native compaction only. Disabled models are fully hands-off: no guidance, no lock, native compaction untouched.

## Recommended OMP settings

The extension intercepts native auto-compaction on engaged models (`session_before_compact` → cancel + defer into the self-compact flow). Set native compaction so it never preempts the extension's warning phase:

| OMP setting | Recommended | Why |
| --- | --- | --- |
| Auto-Compact | **ON** | Required — it's the trigger the extension intercepts on engaged models, and the only compaction for hands-off ones. Off = small models overflow. |
| Compaction Threshold | **90** | At 60 (default) native fires at ~157k on a 262k window — before the extension's 200k warning — and the cancel+lock path would lock the session before the agent writes its note. At 90 it becomes a pure backstop. |
| Idle Compaction | **OFF** | Would fire idle compactions the extension cancels anyway; noise. |
| Mid-Turn Compaction | ON | Emergency safety net, orthogonal to the extension. |
| Snapcompact / TTSR / token-reduction settings | your choice | Unrelated to the self-compact flow; TTSR-style reduction slows context growth and helps. |

## Commands & tools

| Surface | What it does |
| --- | --- |
| `/self-compact-info` | Settings, resolved thresholds, usage, state, prompt sources, pending note — no LLM turn. |
| `/self-compact-now` | Ask the agent to write its note and compact now (reuses a saved note on retry). |
| `/self-compact-settings` | Interactive settings menu (TUI). |
| `/self-compact-toggle` | Session-only on/off switch — no file write. `ctrl+shift+k` does the same. |
| `self_compact` (tool) | Save `note_to_self`, end the run, compact when idle, return the note under a post-compaction status line. |
| `view_context` (tool) | The agent's own view of the gauge: used tokens, percent, level, thresholds, lock state as JSON. |

## Prompt files

The three prompt files ship in `prompts/` and are re-read on every use. Override any of them by dropping a same-named file in `<cwd>/.omp/self-compact/` or `~/.omp/agent/self-compact/`:

- `USER_PROMPT_SOFT_SELF_COMPACT.md` — notice-phase guidance
- `USER_PROMPT_WARNING_SELF_COMPACT.md` — warning-phase guidance
- `USER_PROMPT_COMPACTION_MESSAGE.md` — the summarizer prompt
- `USER_PROMPT_SUMMARY_INSTRUCTIONS.md` — optional extra instructions appended to the summarizer prompt

Placeholders like `{{used_tokens}}`, `{{forced_tokens}}`, `{{note_max_chars}}` are templated at send time.

## Differences from upstream (Pi → OMP)

- Custom summary prompt rides OMP's `session.compacting` hook (`prompt` + `preserveData`) — upstream's custom summarization transport is gone.
- `session_before_compact` has no `reason`: own compactions are recognized by an in-flight flag, native auto-compaction by the `auto_compaction_start`/`_end` pair (cancelled and deferred to the self-compact flow), anything else is a manual `/compact` and proceeds with our prompt.
- No `session_compact_failed` event: our compactions report through `ctx.compact`'s `onError`; external compactions are tracked and a stale "compacting" handoff fails at settle time.
- No `agent_settled`/`model_select`/`registerEntryRenderer`: `session_stop` + a deferred `agent_end` check cover settling, and phase crossings go through `ctx.ui.notify`. Model/role switches (`/model`, Ctrl+P) emit `model_changed` only on OMP's internal bus — extensions can't subscribe — so a managed 2s `ctx.setInterval` poll watches the model key and repaints the gauge, re-reads `self-compact.json`, and re-resolves thresholds against the new window on change.
- `AgentToolResult` has no `terminate`: the result tells the model the turn is complete, and `agent_end` aborts the run when a handoff is pending and OMP scheduled a continuation (`willContinue`) — the abort bumps `promptGeneration`, staling the nudge-continue, and the deferred settle check starts compaction (abort suppresses `session_stop`, so that deferred `onSettled` is the only post-abort compaction path). A safety valve aborts after several consecutive locked tool blocks as backstop.
- New in this port: `self-compact.json` settings file, `compactDisabledRoles`/`compactDisabledModels`/`enabled`, `compactReferenceWindow` (fixed-window % resolution → same absolute trigger on every model), and the `/self-compact-settings` menu.

## License

MIT — same as upstream. See [LICENSE](LICENSE). Original work © 2026 IndyDevDan; OMP port adaptations © 2026 demetre19.
