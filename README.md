# omp-compaction — self-compact for Oh My Pi

**An OMP extension that lets a long-running, autonomous agent manage its own context window.** Ported from [disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent) (Pi, v0.85.1) — all credit for the design and the original implementation goes to IndyDevDan ([@disler](https://github.com/disler)). This repo is the OMP adaptation; upstream remains the canonical source for the concept and the Pi version.

## What it does

The agent watches its own context gauge:

- **Notice threshold** — a transient heads-up message reaches the model on the next LLM call.
- **Warning threshold** — the agent is told to write a `note_to_self` and call `self_compact`.
- **Forced threshold** — every tool except `self_compact` and `view_context` is blocked until compaction succeeds.

`self_compact({ note_to_self })` saves the note, ends the run, and compacts once the agent is idle — using a summary prompt you control. The note comes back **verbatim** as the next message, so the agent resumes its `NEXT ACTION` with no human message and no lost intent. Failures keep the note and the lock, retry automatically (up to 3×), and survive reloads, tree navigation, and crashes.

A one-line footer replaces the default: model id on the left, a 20-cell context bar with threshold markers and phase tag on the right.

## Install

```bash
# Global (every session):
git clone https://github.com/demetre19/omp-compaction ~/.omp/agent/extensions/omp-compaction

# Or per-invocation (testing):
omp -e /path/to/omp-compaction
```

Then configure via `~/.omp/agent/self-compact.json` (created on first write, or copy the example below) — or just run `/self-compact-settings` inside OMP.

## Settings

`/self-compact-settings` opens an interactive menu: enable/disable, thresholds, disabled roles (checkbox list over your `modelRoles`), disabled models, and the compaction prompt. Changes write `self-compact.json` and apply **live** — including turning the extension off mid-session.

`self-compact.json` lookup order (first file wins): `<cwd>/.omp/self-compact.json` → `<cwd>/.pi/self-compact.json` → `~/.omp/agent/self-compact.json` → `~/.pi/agent/self-compact.json`.

```json
{
	"enabled": true,
	"compactSoftAt": "10%",
	"compactAt": "20%",
	"compactBuffer": "5%",
	"compactReferenceWindow": "1m",
	"compactDisabledRoles": ["default"],
	"compactDisabledModels": ["devin/swe-2"]
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
| `compactDisabledRoles` | `modelRoles` names whose resolved model never self-compacts (e.g. `default` → `devin/swe-2`). |
| `compactDisabledModels` | `provider/model` or `provider/*` entries that never self-compact. |

CLI flags (`--compact-soft-at`, `--compact-at`, `--compact-buffer`, `--compact-prompt`, `--compact-disable-role`, `--compact-disable-model`, `--compact-reference-window`) override file values. Thresholds resolve against `compactReferenceWindow` (or the model's own window when unset), capped at 90% of the real window.

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
| `self_compact` (tool) | Save `note_to_self`, end the run, compact when idle, return the note verbatim. |
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
- No `agent_settled`/`model_select`/`registerEntryRenderer`: `session_stop` + a deferred `agent_end` check cover settling, model changes are detected lazily, and phase crossings go through `ctx.ui.notify`.
- `AgentToolResult` has no `terminate`: the result tells the model to stop, and a safety valve aborts the run after several consecutive locked tool blocks.
- New in this port: `self-compact.json` settings file, `compactDisabledRoles`/`compactDisabledModels`/`enabled`, and the `/self-compact-settings` menu.

## License

MIT — same as upstream. See [LICENSE](LICENSE). Original work © 2026 IndyDevDan; OMP port adaptations © 2026 demetre19.
