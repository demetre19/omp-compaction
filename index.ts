/**
 * self-compact — OMP port of disler's self-compact Pi extension (upstream: Pi v0.85.1).
 * Lets a long-running, autonomous agent manage its own context window.
 *
 *   omp --compact-soft-at 10% --compact-at 20% --compact-buffer 10% --compact-prompt "..."
 *   or self-compact.json (see settings.ts for lookup order and keys)
 *
 * - Three thresholds (notice / warning / forced) resolved against the active model window, capped at 90%.
 * - Guidance reaches the model as a transient message on each LLM call while a phase is active
 *   (the `context` hook); it is never persisted into the model's context. Each threshold crossing
 *   is also shown once via ctx.ui.notify (OMP has no custom-entry renderer).
 * - `view_context()` returns used tokens, percent, level, and the thresholds as JSON, since the model
 *   cannot see the footer.
 * - At the forced threshold every tool except `self_compact` and `view_context` is blocked in
 *   `tool_call` with an explicit reason.
 * - `self_compact({ note_to_self })` saves the note, ends the run, compaction runs once the agent is
 *   idle with the replacement summary prompt (via the `session.compacting` hook's `prompt` override),
 *   and the note is returned verbatim as a handoff message that starts the next turn.
 * - Failure or cancellation keeps the note and the lock; retries, /self-compact-now, reload and
 *   tree/branch recovery.
 * - One-line replacement footer: model id on the left, the 20-cell context bar and phase on the right.
 *
 * OMP API adaptations vs upstream Pi:
 * - `session.compacting` hook supplies the custom summary prompt (`prompt` + `preserveData`),
 *   replacing upstream's summary.ts transport override entirely.
 * - `session_before_compact` has no `reason`: our own compactions are recognized by
 *   `R.compactionInFlight`, native auto-compaction by the `auto_compaction_start`/`_end` pair
 *   (cancelled and deferred to the self-compact flow, same as upstream), anything else is a manual
 *   `/compact` and proceeds with our prompt.
 * - No `session_compact_failed` event: our compactions report through `ctx.compact`'s onError;
 *   external compactions are tracked with `externalCompactionActive` and a stale-"compacting" check
 *   in the settle path marks the handoff failed.
 * - No `agent_settled` event: `session_stop` plus a deferred check after `agent_end` cover it.
 * - No `model_select` event: the model key is compared inside refreshUi and thresholds re-resolve
 *   on change.
 * - No `registerEntryRenderer`: custom entries never render in OMP, so phase crossings and
 *   /self-compact-info go through `ctx.ui.notify`; state stays in invisible `appendEntry` records.
 * - `AgentToolResult` has no `terminate`: the tool result tells the model to stop, and a safety
 *   valve aborts the run after several consecutive locked tool blocks.
 * - `message_end` does not fire for custom messages: a journaled handoff is detected by scanning
 *   the branch when the next assistant message ends (and in the settle path).
 * - `before_agent_start` systemPrompt is a string array: our line is appended as an element.
 * - `SettingsManager.create` is async and compaction settings live in the "compaction" group.
 */
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatPct, formatTokens, renderContextBar } from "./context-bar.ts";
import {
	FORCED_PROMPT,
	BUILTIN_PROMPTS,
	loadPromptFile,
	NOTE_MAX_CHARS,
	promptSearchDirs,
	renderTemplate,
	type TemplateValues,
} from "./prompts.ts";
import { loadSettingsFile, settingsWritePath, writeSettingsFile } from "./settings.ts";
import { isModelDisabled, loadModelRoles, resolveDisabledModels, type DisabledModels } from "./roles.ts";
import { runSettingsMenu, type MenuValues } from "./menu.ts";
import {
	HANDOFF_TYPE,
	INFO_ENTRY_TYPE,
	PHASE_ENTRY_TYPE,
	STATE_TYPE,
	emptyState,
	latestAssistantUsage,
	recoverState,
	type EntryLike,
	type Handoff,
	type PersistedState,
} from "./state.ts";
import {
	DEFAULT_SPECS,
	LEVEL_ORDER,
	levelFor,
	parseTokenSpec,
	resolveThresholds,
	SPEC_HELP,
	validateSpecs,
	type ResolvedThresholds,
	type SpecSource,
	type ThresholdSpecs,
	type UsageLevel,
} from "./thresholds.ts";

export const TOOL_NAME = "self_compact";
export const VIEW_TOOL_NAME = "view_context";
export { HANDOFF_TYPE, STATE_TYPE };
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_AUTO_RETRIES = 3;
const GUIDANCE_TYPE = "self-compact-guidance";
/** Consecutive locked tool blocks before the run is aborted outright (OMP has no `terminate`). */
const LOCKED_BLOCK_ABORT_AFTER = 5;
/** Custom message types that must never reach the LLM context. */
const CONTEXT_FILTERED_TYPES = new Set([GUIDANCE_TYPE, PHASE_ENTRY_TYPE, INFO_ENTRY_TYPE]);

/** Static system-prompt line: never changes between calls so the prompt-cache prefix stays stable. */
const SYSTEM_PROMPT_LINE = `self-compact: when context usage crosses a threshold you receive a transient [self-compact · …] message with live numbers. You cannot see your own context usage otherwise: call view_context (no arguments) whenever you need the current numbers as JSON, for example after a compaction or before deciding to compact; do not poll it every turn. After a compaction, your own saved note_to_self is returned to you verbatim as the next message (exactly the note text, nothing else); resume its NEXT ACTION without another user message and never restart work the note marks as done. If no work remains, report completion and stop.`;

interface UsageSnapshot {
	tokens: number | null;
	percent: number | null;
	cachedTokens: number;
	window: number;
}

interface Runtime {
	compactPromptFlag?: string;
	compactPromptFile?: string;
	/** Master switch from self-compact.json `enabled`; undefined = on. */
	disabled: boolean;
	/** Roles/models that never self-compact (compactDisabledRoles resolved via modelRoles + compactDisabledModels). */
	disabledModels: DisabledModels;
	/** Fixed window percentage specs resolve against (tokens); undefined = model's own window. */
	referenceWindow?: number;
	settingsFile?: string;
	sources: { softAt: SpecSource; at: SpecSource; buffer: SpecSource };
	fromDefaults: boolean;
	configError?: string;
	resolveError?: string;
	thresholds?: ResolvedThresholds;
	searchDirs: string[];
	usage: UsageSnapshot;
	level: UsageLevel;
	state: PersistedState;
	/** Context epoch: bumps on every compaction and session start so per-epoch guidance re-arms. */
	epoch: number;
	announcedLevel: UsageLevel;
	compactionInFlight: boolean;
	/** True between auto_compaction_start and auto_compaction_end (OMP's auto/manual discriminator). */
	autoCompactionActive: boolean;
	/** True while a manual /compact we did not start is running (no session_compact_failed in OMP). */
	externalCompactionActive: boolean;
	/** Consecutive tool blocks while locked; trips the abort safety valve. */
	lockedBlocks: number;
	/** Last model key thresholds were resolved against (OMP has no model_select event). */
	lastModelKey: string;
	/** /compact instructions captured in session_before_compact for the session.compacting prompt. */
	pendingCustomInstructions?: string;
	lastCompactionError?: string;
	retryTimer?: ReturnType<typeof setTimeout>;
	deliveryTimer?: ReturnType<typeof setTimeout>;
	/** Deferred session-start work (resume nudge or pending-note compaction); cancelled on shutdown / tree switch. */
	recoveryTimer?: ReturnType<typeof setTimeout>;
	requestRender?: () => void;
	alive: boolean;
	idleRequestEpoch: number;
	promptErrors: Set<string>;
}

function nowPrompt(saved?: string): string {
	const base = `Compact now: write your note_to_self (max ${NOTE_MAX_CHARS} chars: goal, DONE with exact paths and commands, IN PROGRESS, key decisions, verified test results, exact NEXT ACTION last) and call ${TOOL_NAME} as your only tool call.`;
	if (!saved) return base;
	return `${base}\n\nA note is already saved from a previous attempt. Pass it to ${TOOL_NAME} verbatim instead of inventing a new one. Saved note, verbatim:\n\n${saved}\n\n---\nCall ${TOOL_NAME} now with exactly that note.`;
}

function guidanceMessage(text: string) {
	return { role: "custom" as const, customType: GUIDANCE_TYPE, content: text, display: false, timestamp: Date.now() };
}

function levelColor(level: UsageLevel): "dim" | "accent" | "warning" | "error" | "muted" {
	if (level === "notice") return "accent";
	if (level === "warning") return "warning";
	if (level === "forced") return "error";
	return level === "idle" ? "dim" : "muted";
}

function levelTag(level: UsageLevel): string {
	if (level === "notice") return "NOTICE";
	if (level === "warning") return "WARNING";
	if (level === "forced") return "FORCED";
	return level === "idle" ? "" : "n/a";
}

function handoffTag(status: Handoff["status"]): string {
	if (status === "failed") return "COMPACTION FAILED";
	if (status === "ready") return "COMPACTED";
	return "COMPACTING";
}

/** `id` inside a custom_message entry's details, narrowed instead of cast. */
function entryDetailsId(entry: EntryLike): string | undefined {
	const d = entry.details;
	if (d && typeof d === "object" && "id" in d && typeof d.id === "string") return d.id;
	return undefined;
}

export default function selfCompact(pi: ExtensionAPI) {
	pi.registerFlag("compact-soft-at", { description: `Soft notice threshold (default ${DEFAULT_SPECS.softAt}). ${SPEC_HELP}`, type: "string" });
	pi.registerFlag("compact-at", { description: `Warning threshold: ask the agent to write its note and compact (default ${DEFAULT_SPECS.at}).`, type: "string" });
	pi.registerFlag("compact-buffer", { description: `Extra allowance above --compact-at before other tools are blocked (default ${DEFAULT_SPECS.buffer}; 0 = immediate).`, type: "string" });
	pi.registerFlag("compact-prompt", { description: "Literal text that replaces the compaction summary prompt.", type: "string" });
	pi.registerFlag("compact-disable-role", { description: "modelRoles name whose model never self-compacts (repeatable or comma-separated).", type: "string" });
	pi.registerFlag("compact-disable-model", { description: "provider/model (or provider/*) that never self-compacts (repeatable or comma-separated).", type: "string" });
	pi.registerFlag("compact-reference-window", { description: "Fixed window that percentage thresholds resolve against (e.g. 1m): every model compacts at the same absolute tokens; windows too small for warn+buffer stay hands-off.", type: "string" });

	const R: Runtime = {
		specs: { ...DEFAULT_SPECS },
		sources: { softAt: "default", at: "default", buffer: "default" },
		fromDefaults: true,
		disabled: false,
		disabledModels: { keys: {}, roles: {}, unknownRoles: [], direct: [] },
		searchDirs: promptSearchDirs(process.cwd(), EXTENSION_DIR),
		usage: { tokens: null, percent: null, cachedTokens: 0, window: 0 },
		level: "unknown",
		state: emptyState(),
		epoch: 0,
		announcedLevel: "idle",
		compactionInFlight: false,
		autoCompactionActive: false,
		externalCompactionActive: false,
		lockedBlocks: 0,
		lastModelKey: "",
		alive: true,
		idleRequestEpoch: -1,
		promptErrors: new Set(),
	};

	const flag = (name: string): string | undefined => {
		const value = pi.getFlag(name);
		return typeof value === "string" && value.trim() !== "" ? value : undefined;
	};

	/** A flag may be passed repeatedly or as a comma-separated list. */
	const flagList = (name: string): string[] => {
		const value = pi.getFlag(name);
		if (Array.isArray(value)) return value.flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean);
		if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
		return [];
	};

	/** CLI flag values are applied after extensions load, so settings are read at session start. */
	function loadSettings(cwd: string) {
		const file = loadSettingsFile(cwd);
		R.settingsFile = file.source;
		const softFlag = flag("compact-soft-at");
		const atFlag = flag("compact-at");
		const bufferFlag = flag("compact-buffer");
		R.specs = {
			softAt: softFlag ?? file.values.compactSoftAt ?? DEFAULT_SPECS.softAt,
			at: atFlag ?? file.values.compactAt ?? DEFAULT_SPECS.at,
			buffer: bufferFlag ?? file.values.compactBuffer ?? DEFAULT_SPECS.buffer,
		};
		R.sources = {
			softAt: softFlag ? "flag" : file.values.compactSoftAt !== undefined ? "file" : "default",
			at: atFlag ? "flag" : file.values.compactAt !== undefined ? "file" : "default",
			buffer: bufferFlag ? "flag" : file.values.compactBuffer !== undefined ? "file" : "default",
		};
		R.fromDefaults =
			!softFlag && !atFlag && !bufferFlag &&
			file.values.compactSoftAt === undefined && file.values.compactAt === undefined && file.values.compactBuffer === undefined;
		R.compactPromptFlag = flag("compact-prompt");
		R.compactPromptFile = file.values.compactPrompt;
		R.disabled = file.values.enabled === false;
		R.disabledModels = resolveDisabledModels(
			[...(file.values.compactDisabledRoles ?? []), ...flagList("compact-disable-role")],
			[...(file.values.compactDisabledModels ?? []), ...flagList("compact-disable-model")],
			cwd,
		);
		R.configError = file.error;
		const refSpec = flag("compact-reference-window") ?? file.values.compactReferenceWindow;
		R.referenceWindow = undefined;
		if (refSpec !== undefined) {
			try {
				const parsed = parseTokenSpec(refSpec, "compactReferenceWindow");
				if (parsed.kind !== "tokens") throw new Error(`Invalid compactReferenceWindow: "${refSpec}" must be a token count, not a percentage.`);
				R.referenceWindow = parsed.value;
			} catch (error) {
				R.configError = error instanceof Error ? error.message : String(error);
				process.stderr.write(`[self-compact] REJECTED: ${R.configError}\n`);
			}
		}
		try {
			for (const name of ["compact-soft-at", "compact-at", "compact-buffer", "compact-prompt"]) {
				const value = pi.getFlag(name);
				if (typeof value === "string" && !value.trim()) throw new Error(`--${name} must not be empty.`);
			}
			validateSpecs(R.specs);
		} catch (error) {
			R.configError = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[self-compact] REJECTED: ${R.configError}\n`);
		}
	}

	/** The uncapped forced target: warn + buffer before the 90%-of-window clamp. */
	function forcedTarget(): number | undefined {
		const t = R.thresholds;
		return t ? t.warnTokens + t.bufferTokens : undefined;
	}

	/** True when the model's window cannot even reach the forced threshold (e.g. a 262k window with a 300k target). */
	function windowTooSmall(ctx: ExtensionContext): boolean {
		const target = forcedTarget();
		const window = ctx.model?.contextWindow ?? 0;
		return target !== undefined && window > 0 && window <= target;
	}

	/** Fully hands-off: master switch off, model disabled by role/model, or window too small for the thresholds. */
	function handsOff(ctx: ExtensionContext): boolean {
		return R.disabled || isModelDisabled(ctx.model, R.disabledModels) || windowTooSmall(ctx);
	}

	/** Why the extension is hands-off right now, for display. */
	function handsOffReason(ctx: ExtensionContext): string | undefined {
		if (R.disabled) return "disabled in self-compact.json";
		const key = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		if (key && isModelDisabled(ctx.model, R.disabledModels)) {
			const role = Object.entries(R.disabledModels.roles).find(([, k]) => k === key)?.[0];
			return `model ${key} is disabled${role ? ` (role ${role})` : ""}`;
		}
		if (windowTooSmall(ctx)) {
			return `window ${(ctx.model?.contextWindow ?? 0).toLocaleString("en-US")} tokens is smaller than the forced threshold ${forcedTarget()!.toLocaleString("en-US")} tokens`;
		}
		return undefined;
	}

	const inert = (): string | undefined => R.configError ?? R.resolveError;
	const handoff = (): Handoff | undefined => R.state.handoff;
	/** A handoff that still needs work; a completed ("done") handoff is history and must not disable guidance or locking. */
	const activeHandoff = (): Handoff | undefined => {
		const h = R.state.handoff;
		return h && h.status !== "done" ? h : undefined;
	};
	const locked = (): boolean => R.state.locked;

	// ---------------------------------------------------------------- helpers

	/** Info toasts stay out of the TUI (the footer and phase notifications already show them); warnings and errors show everywhere. */
	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
		if (!ctx.hasUI) return;
		if (type === "info" && ctx.mode === "tui") return;
		ctx.ui.notify(message, type);
	}

	function save() {
		pi.appendEntry(STATE_TYPE, structuredClone(R.state));
	}

	/** Every deferred callback belongs to one session epoch; a new session, tree switch, or shutdown cancels them all. */
	function clearTimers() {
		for (const key of ["retryTimer", "deliveryTimer", "recoveryTimer"] as const) {
			clearTimeout(R[key]);
			R[key] = undefined;
		}
	}

	/** Run `fn` after `delayMs` only if the session epoch is unchanged and the runtime is alive. */
	function deferInEpoch(key: "retryTimer" | "recoveryTimer", delayMs: number, fn: () => void) {
		const epoch = R.epoch;
		R[key] = setTimeout(() => {
			R[key] = undefined;
			if (!R.alive || epoch !== R.epoch) return;
			fn();
		}, delayMs);
	}

	function setLocked(value: boolean) {
		if (R.state.locked === value) return;
		R.state.locked = value;
		if (!value) R.lockedBlocks = 0;
	}

	function resolve(ctx: ExtensionContext) {
		const result = resolveThresholds(R.specs, ctx.model?.contextWindow ?? 0, { fromDefaults: R.fromDefaults, referenceWindow: R.referenceWindow });
		if (result.ok) {
			R.thresholds = result.thresholds;
			R.resolveError = undefined;
			if (result.thresholds.notes.length > 0) notify(ctx, `self-compact: ${result.thresholds.notes.join(" ")}`, "warning");
		} else {
			R.thresholds = undefined;
			R.resolveError = result.error;
		}
	}

	function snapshotUsage(ctx: ExtensionContext): UsageSnapshot {
		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const tokens = usage?.tokens ?? null;
		const percent = usage?.percent ?? (tokens !== null && window > 0 ? (tokens / window) * 100 : null);
		let cachedTokens = 0;
		if (tokens !== null) {
			const last = latestAssistantUsage(ctx.sessionManager.getBranch() as EntryLike[]);
			cachedTokens = Math.min(tokens, last?.cacheRead ?? 0);
		}
		return { tokens, percent, cachedTokens, window };
	}

	function templateValues(): TemplateValues {
		const t = R.thresholds;
		const u = R.usage;
		const tokens = u.tokens ?? 0;
		return {
			used_tokens: tokens.toLocaleString("en-US"),
			context_tokens: tokens.toLocaleString("en-US"),
			context_percent: u.percent?.toFixed(1) ?? "unknown",
			remaining_tokens: Math.max(0, u.window - tokens).toLocaleString("en-US"),
			used_percent: formatPct(u.percent, 1),
			cached_tokens: u.cachedTokens.toLocaleString("en-US"),
			context_window: u.window.toLocaleString("en-US"),
			soft_tokens: (t?.softTokens ?? 0).toLocaleString("en-US"),
			soft_percent: formatPct(t?.softPct ?? null, 1),
			warning_tokens: (t?.warnTokens ?? 0).toLocaleString("en-US"),
			warning_percent: formatPct(t?.warnPct ?? null, 1),
			forced_tokens: (t?.forcedTokens ?? 0).toLocaleString("en-US"),
			forced_percent: formatPct(t?.forcedPct ?? null, 1),
			remaining_to_forced: Math.max(0, (t?.forcedTokens ?? 0) - tokens).toLocaleString("en-US"),
			cycle: R.state.cycle,
			note_max_chars: NOTE_MAX_CHARS,
		};
	}

	function contextBarText(): string {
		const t = R.thresholds;
		const u = R.usage;
		if (!t) return "[--------------------] --%";
		const cachedPct = u.window > 0 ? (u.cachedTokens / u.window) * 100 : 0;
		return renderContextBar({ usedPct: u.percent, cachedPct, softPct: t.softPct, warnPct: t.warnPct, forcedPct: t.forcedPct }).text;
	}

	/** Footer tag: REJECTED > OFF (disabled model/master switch) > handoff in flight > phase. */
	function statusTag(ctx: ExtensionContext): string {
		if (inert()) return "REJECTED";
		if (handsOff(ctx)) return "OFF";
		const h = handoff();
		if (h && h.status !== "done") return handoffTag(h.status);
		return levelTag(R.level);
	}

	function refreshUi(ctx: ExtensionContext) {
		// OMP has no model_select event: a changed model key re-resolves the thresholds lazily.
		const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
		if (modelKey !== R.lastModelKey) {
			R.lastModelKey = modelKey;
			resolve(ctx);
		}
		R.usage = snapshotUsage(ctx);
		R.level = R.thresholds ? levelFor(R.usage.tokens, R.thresholds) : "unknown";
		if (ctx.mode === "tui") R.requestRender?.();
		else if (ctx.hasUI) ctx.ui.setStatus("self-compact", [contextBarText(), statusTag(ctx)].filter(Boolean).join(" "));
	}

	// -------------------------------------------------------- compaction checks

	let keepRecentCache: { cwd: string; value: number } | undefined;

	/** OMP's retained recent history for this working directory (global settings merged with the project's). */
	async function keepRecentTokens(cwd: string): Promise<number> {
		if (keepRecentCache?.cwd === cwd) return keepRecentCache.value;
		try {
			const settings = await SettingsManager.create(cwd);
			const group = settings.getGroup("compaction") as { keepRecentTokens?: number };
			const value = typeof group?.keepRecentTokens === "number" ? group.keepRecentTokens : 20_000;
			keepRecentCache = { cwd, value };
			return value;
		} catch {
			return 20_000;
		}
	}

	type PrepareCompaction = (
		entries: EntryLike[],
		settings: Record<string, unknown>,
		model?: unknown,
	) => unknown | Promise<unknown>;
	/** undefined = not probed yet, null = unavailable in this OMP build. */
	let prepareCompactionImpl: PrepareCompaction | null | undefined;

	async function probePrepareCompaction(): Promise<PrepareCompaction | null> {
		if (prepareCompactionImpl !== undefined) return prepareCompactionImpl;
		try {
			// Dynamic import is required: a static import would crash the whole extension at load
			// on any OMP build where the legacy-Pi specifier shim does not expose this subpath.
			// The shim rewrites it to @oh-my-pi/pi-agent-core when available; otherwise we fall
			// back to the keepRecentTokens heuristic below.
			const mod = (await import("@earendil-works/pi-agent-core/compaction")) as Record<string, unknown>;
			prepareCompactionImpl = typeof mod.prepareCompaction === "function" ? (mod.prepareCompaction as PrepareCompaction) : null;
		} catch {
			prepareCompactionImpl = null;
		}
		return prepareCompactionImpl;
	}

	async function compactionSettings(ctx: ExtensionContext): Promise<Record<string, unknown>> {
		try {
			const settings = await SettingsManager.create(ctx.cwd);
			const group = settings.getGroup("compaction") as Record<string, unknown>;
			// remoteEnabled off: remote-replay payloads must count as unreadable so the check
			// measures real summarizable history, matching what a local summary would cover.
			return { enabled: true, keepRecentTokens: 20_000, ...group, remoteEnabled: false, remoteStreamingV2Enabled: false };
		} catch {
			return { enabled: true, keepRecentTokens: 20_000, remoteEnabled: false, remoteStreamingV2Enabled: false };
		}
	}

	/**
	 * False when OMP would answer "Nothing to compact": the whole session still fits inside
	 * keepRecentTokens. Locking tools or asking for a note would then strand the agent, so the
	 * extension stays quiet instead. Exact when the engine's prepareCompaction is importable;
	 * otherwise a keepRecentTokens heuristic, with the onError escape hatch in startCompaction.
	 */
	async function compactable(ctx: ExtensionContext): Promise<boolean> {
		const branch = ctx.sessionManager.getBranch() as EntryLike[];
		const prepare = await probePrepareCompaction();
		if (prepare) {
			try {
				return (await prepare(branch, await compactionSettings(ctx), ctx.model)) !== undefined;
			} catch {
				// fall through to the heuristic
			}
		}
		if (branch.length === 0 || branch[branch.length - 1]!.type === "compaction") return false;
		const tokens = ctx.getContextUsage()?.tokens ?? 0;
		return tokens > (await keepRecentTokens(ctx.cwd));
	}

	/** Called whenever usage may have changed: records crossings (notify + journal entry) and engages the forced lock. */
	async function trackLevel(ctx: ExtensionContext) {
		refreshUi(ctx);
		if (inert() || handsOff(ctx) || !R.thresholds) return;
		const level = R.level;
		if (level === "unknown" || level === "idle") return;
		if (level === "forced" && !locked() && !activeHandoff() && (await compactable(ctx))) {
			setLocked(true);
			save();
		}
		if (LEVEL_ORDER[level] > LEVEL_ORDER[R.announcedLevel]) {
			R.announcedLevel = level;
			// The crossing record carries the full guidance message the model will receive.
			let text: string | undefined;
			try { text = renderGuidance(level); }
			catch { text = renderTemplate(level === "forced" ? FORCED_PROMPT : BUILTIN_PROMPTS[level === "notice" ? "soft" : "warning"], templateValues()); }
			pi.appendEntry(PHASE_ENTRY_TYPE, { level, tokens: R.usage.tokens, percent: R.usage.percent, text, at: Date.now() });
			// OMP has no entry renderer: notify shows the crossing (full text) in every mode.
			ctx.ui.notify(text ?? `self-compact: ${levelTag(level).toLowerCase()} threshold crossed`, level === "forced" ? "error" : level === "warning" ? "warning" : "info");
		}
	}

	/** The guidance message for a level, rendered from the prompt files with current usage. */
	function renderGuidance(level: UsageLevel): string {
		if (level === "notice") return renderTemplate(loadPromptFile("soft", R.searchDirs).text, templateValues());
		if (level === "forced") return renderTemplate(FORCED_PROMPT, templateValues());
		return renderTemplate(loadPromptFile("warning", R.searchDirs).text, templateValues());
	}

	/** One transient guidance message is rebuilt from current usage for every LLM call. */
	async function guidanceText(ctx: ExtensionContext): Promise<string | undefined> {
		if (inert() || handsOff(ctx) || !R.thresholds || activeHandoff()) return undefined;
		const level = locked() ? "forced" : R.level;
		if (level === "unknown" || level === "idle") return undefined;
		if (!(await compactable(ctx))) return undefined;
		return renderGuidance(level);
	}

	/** True once the handoff message for `h` is journaled in the branch (OMP emits no message_end for it). */
	function handoffJournaled(ctx: ExtensionContext, h: Handoff): boolean {
		return (ctx.sessionManager.getBranch() as EntryLike[]).some(
			(e) => e.type === "custom_message" && e.customType === HANDOFF_TYPE && entryDetailsId(e) === h.id,
		);
	}

	/** The verbatim-note transaction completes when the handoff message is in the branch. */
	function markHandoffDoneIfJournaled(ctx: ExtensionContext) {
		const h = handoff();
		if (!h || h.status !== "ready" || !handoffJournaled(ctx, h)) return;
		R.state.handoff = { ...h, status: "done" };
		setLocked(false);
		save();
		refreshUi(ctx);
	}

	function deliverHandoff(ctx: ExtensionContext) {
		const h = handoff();
		if (!R.alive || !h || h.status !== "ready") return;
		if (!ctx.isIdle()) {
			if (!R.deliveryTimer) {
				const epoch = R.epoch;
				R.deliveryTimer = setTimeout(() => {
					R.deliveryTimer = undefined;
					if (epoch === R.epoch) deliverHandoff(ctx);
				}, 25);
			}
			return;
		}
		// Content is exactly the saved note (verbatim contract); the header lives in the renderer and details.
		pi.sendMessage({ customType: HANDOFF_TYPE, content: h.note, display: true, details: { id: h.id, cycle: R.state.cycle, note: h.note } }, { triggerTurn: true });
	}

	function startCompaction(ctx: ExtensionContext, trigger: string) {
		const h = handoff();
		if (R.compactionInFlight || !h || (h.status !== "pending" && h.status !== "failed")) return;
		R.compactionInFlight = true;
		h.status = "compacting";
		save();
		notify(ctx, `self-compact: compacting (${trigger}, note ${h.note.length} chars)…`, "info");
		refreshUi(ctx);
		void ctx.compact({
			onComplete: () => {
				R.compactionInFlight = false;
			},
			onError: (error) => {
				R.compactionInFlight = false;
				const message = error instanceof Error ? error.message : String(error);
				if (/nothing to compact|already compacted/i.test(message)) {
					// Nothing to summarize: the note still has to come back, so the handoff completes
					// without a compaction entry (recoverState also treats "ready" as landed).
					const current = handoff();
					if (current && current.status === "compacting") {
						R.state.cycle += 1;
						R.state.handoff = { ...current, status: "ready", error: undefined };
						setLocked(false);
						save();
						notify(ctx, `self-compact: nothing to compact; returning the note (${current.note.length} chars).`, "info");
						deliverHandoff(ctx);
					}
					refreshUi(ctx);
					return;
				}
				failHandoff(ctx, message, !/cancel|abort/i.test(message));
			},
		});
	}

	/** Shared failure path for compactions we started (ctx.compact onError) and stale external ones. */
	function failHandoff(ctx: ExtensionContext, error: string, canRetry: boolean) {
		const h = handoff();
		if (!h || (h.status !== "compacting" && h.status !== "pending")) {
			refreshUi(ctx);
			return;
		}
		R.state.handoff = { ...h, status: "failed", attempts: h.attempts + 1, error };
		setLocked(true);
		save();
		refreshUi(ctx);
		const current = handoff()!;
		if (canRetry && current.attempts < MAX_AUTO_RETRIES) {
			notify(ctx, `self-compact: compaction failed (attempt ${current.attempts}): ${current.error}. Note kept, tools stay locked, retrying automatically.`, "warning");
			scheduleRetry(ctx);
		} else {
			notify(ctx, `self-compact: compaction failed (attempt ${current.attempts}): ${current.error}. Note kept and tools stay locked. Run /self-compact-now or /compact to retry.`, "error");
		}
	}

	function scheduleRetry(ctx: ExtensionContext) {
		const delay = 2_000 * Math.max(1, handoff()?.attempts ?? 1);
		deferInEpoch("retryTimer", delay, () => {
			if (handoff()?.status === "failed" && ctx.isIdle()) startCompaction(ctx, `auto-retry ${(handoff()?.attempts ?? 0) + 1}`);
		});
	}

	/** OMP's agent_settled equivalent: runs on session_stop and deferred after agent_end. */
	async function onSettled(ctx: ExtensionContext) {
		if (!R.alive) return; // shutdown during compaction: the ctx is already stale
		refreshUi(ctx);
		if (inert() || handsOff(ctx)) return;
		if (!ctx.isIdle()) return;
		if (R.externalCompactionActive) {
			// A manual /compact we let through ended without session_compact: it failed or was cancelled.
			R.externalCompactionActive = false;
			const h = handoff();
			if (h && h.status === "compacting") {
				failHandoff(ctx, "Compaction was cancelled or failed.", false);
				return;
			}
		}
		const h = handoff();
		if (!h) return;
		if (h.status === "ready") {
			markHandoffDoneIfJournaled(ctx);
			if (handoff()?.status === "ready") deliverHandoff(ctx);
			return;
		}
		if (h.status === "compacting" && !R.compactionInFlight) {
			// The compaction that owned this handoff died without an event we can see.
			failHandoff(ctx, "Compaction was interrupted before completing.", true);
			return;
		}
		if (h.status === "pending" || (h.status === "failed" && h.attempts < MAX_AUTO_RETRIES && R.lastCompactionError)) {
			startCompaction(ctx, h.status === "pending" ? "agent idle" : "retry after failure");
		}
	}

	function infoLines(ctx: ExtensionContext): { lines: string[]; data: Record<string, unknown> } {
		R.usage = snapshotUsage(ctx);
		R.level = R.thresholds ? levelFor(R.usage.tokens, R.thresholds) : "unknown";
		const t = R.thresholds;
		const h = handoff();
		const describePrompt = (load: () => { text: string; source: string }) => {
			try { return load(); }
			catch (error) { return { text: "", source: `ERROR: ${error instanceof Error ? error.message : String(error)}` }; }
		};
		const soft = describePrompt(() => loadPromptFile("soft", R.searchDirs));
		const warning = describePrompt(() => loadPromptFile("warning", R.searchDirs));
		const compaction = describePrompt(() => resolveCompactionPrompt({ flag: R.compactPromptFlag, file: R.compactPromptFile, searchDirs: R.searchDirs }));
		const summaryInstructions = describePrompt(() => loadPromptFile("summaryInstructions", R.searchDirs));
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
		const fmt = (n: number) => n.toLocaleString("en-US");
		const problem = inert();
		const lines: string[] = ["self-compact info"];
		lines.push(`settings file: ${R.settingsFile ?? "(none — using defaults)"}`);
		lines.push(`settings: compactSoftAt ${R.specs.softAt} (${R.sources.softAt}), compactAt ${R.specs.at} (${R.sources.at}), compactBuffer ${R.specs.buffer} (${R.sources.buffer}), compactPrompt ${R.compactPromptFlag ? `flag (${R.compactPromptFlag.length} chars)` : R.compactPromptFile ? `file (${R.compactPromptFile.length} chars)` : "unset"}, referenceWindow ${R.referenceWindow !== undefined ? `${fmt(R.referenceWindow)} tokens` : "model's own"}`);
		const off = handsOffReason(ctx);
		if (off) lines.push(`OFF: ${off} — extension is hands-off for this session`);
		const dm = R.disabledModels;
		const disabledDesc = [
			...Object.entries(dm.roles).map(([role, key]) => `${role}→${key}`),
			...dm.unknownRoles.map((r) => `${r} (unknown role)`),
			...dm.direct,
		];
		if (disabledDesc.length > 0) lines.push(`disabled: ${disabledDesc.join(", ")}`);
		if (problem) lines.push(`REJECTED: ${problem} (extension is inert; every tool is blocked until fixed)`);
		lines.push(`model: ${model}, window ${fmt(R.usage.window)} tokens, cap ${t ? fmt(t.capTokens) : "?"} (90%)`);
		if (t) {
			lines.push(`resolved: soft ${fmt(t.softTokens)} (${formatPct(t.softPct, 1)}), warning ${fmt(t.warnTokens)} (${formatPct(t.warnPct, 1)}), buffer ${fmt(t.bufferTokens)}, forced ${fmt(t.forcedTokens)} (${formatPct(t.forcedPct, 1)})${t.clamped ? " [clamped]" : ""}`);
			for (const note of t.notes) lines.push(`note: ${note}`);
		}
		lines.push(`usage: ${R.usage.tokens === null ? "unknown" : `${fmt(R.usage.tokens)} tokens (${formatPct(R.usage.percent, 1)}), ${fmt(R.usage.cachedTokens)} cached`}  ${contextBarText()}`);
		lines.push(`state: level ${R.level}, tools ${locked() ? `LOCKED (only ${TOOL_NAME})` : "unlocked"}, handoff ${h?.status ?? "none"}, attempts ${h?.attempts ?? 0}, compaction ${R.compactionInFlight ? "in flight" : R.externalCompactionActive ? "external in flight" : "idle"}`);
		lines.push(`cycles completed: ${R.state.cycle}`);
		lines.push(`prompts: soft ${soft.source} (${soft.text.length} chars), warning ${warning.source} (${warning.text.length} chars), compaction ${compaction.source} (${compaction.text.length} chars)`);
		lines.push(`summary user instructions: ${summaryInstructions.source} (${summaryInstructions.text.length} chars)`);
		if (h) {
			const preview = h.note.length > 200 ? `${h.note.slice(0, 200)}…` : h.note;
			lines.push(`${h.status === "done" ? "last delivered note" : "pending note"} (${h.note.length} chars): ${preview.replace(/\s+/g, " ")}`);
			if (h.error) lines.push(`last error: ${h.error}`);
		}
		const data = {
			disabled: { master: R.disabled, roles: dm.roles, unknownRoles: dm.unknownRoles, models: dm.direct, active: off ?? null },
			settings: { ...R.specs, compactPrompt: R.compactPromptFlag ?? R.compactPromptFile ?? null, sources: R.sources, file: R.settingsFile ?? null },
			rejected: problem ?? null,
			model,
			thresholds: t ?? null,
			usage: R.usage,
			bar: contextBarText(),
			level: R.level,
			locked: locked(),
			handoff: h ? { id: h.id, status: h.status, attempts: h.attempts, noteChars: h.note.length, note: h.note, error: h.error ?? null } : null,
			cycle: R.state.cycle,
			prompts: {
				soft: { source: soft.source, chars: soft.text.length },
				warning: { source: warning.source, chars: warning.text.length },
				compaction: { source: compaction.source, chars: compaction.text.length },
				summaryInstructions: { source: summaryInstructions.source, chars: summaryInstructions.text.length },
			},
		};
		return { lines, data };
	}

	// ----------------------------------------------------------------- tools

	/** The agent's view of its own context: the same numbers as the footer, as plain JSON. */
	function contextView(ctx: ExtensionContext) {
		R.usage = snapshotUsage(ctx);
		R.level = R.thresholds ? levelFor(R.usage.tokens, R.thresholds) : "unknown";
		const t = R.thresholds;
		const u = R.usage;
		const pct = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(1)));
		const h = activeHandoff();
		return {
			used_tokens: u.tokens,
			used_percent: pct(u.percent),
			context_window: u.window,
			cached_tokens: u.cachedTokens,
			level: R.level,
			thresholds: t
				? {
						notice: { tokens: t.softTokens, percent: pct(t.softPct) },
						warning: { tokens: t.warnTokens, percent: pct(t.warnPct) },
						hard_cutoff: { tokens: t.forcedTokens, percent: pct(t.forcedPct) },
					}
				: null,
			tokens_until_warning: t && u.tokens !== null ? Math.max(0, t.warnTokens - u.tokens) : null,
			tokens_until_hard_cutoff: t && u.tokens !== null ? Math.max(0, t.forcedTokens - u.tokens) : null,
			tools_locked: locked(),
			pending_note: h ? { status: h.status, chars: h.note.length } : null,
			compaction_cycles: R.state.cycle,
			settings_error: inert() ?? null,
			self_compact_disabled: handsOff(ctx),
			disabled_reason: handsOffReason(ctx) ?? null,
		};
	}

	pi.registerTool({
		name: VIEW_TOOL_NAME,
		label: "View Context",
		description: `See your own context usage as JSON: used_tokens, used_percent, context_window, level, the self-compact thresholds (notice, warning, hard_cutoff) and the tokens left before each. You cannot see these numbers any other way. Call it when you need to decide something (after a compaction, before a large read, when judging whether to call ${TOOL_NAME}). Do not call it every turn: the extension sends you a message when a threshold is crossed.`,
		promptSnippet: "Show your current context usage, percent, and the self-compact thresholds as JSON",
		promptGuidelines: [
			`${VIEW_TOOL_NAME} takes no arguments and never changes anything; use it when you need your current context numbers, not on every turn.`,
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const view = contextView(ctx);
			refreshUi(ctx);
			return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }], details: view };
		},
		renderCall(_args, _options, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(VIEW_TOOL_NAME)), 0, 0);
		},
		renderResult(result, _options, theme) {
			const first = result.content[0];
			const text = first && first.type === "text" ? first.text : "";
			return new Text(theme.fg("text", text), 0, 0);
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Self Compact",
		description: `Hand off to yourself across a context compaction. Provide note_to_self (1 to ${NOTE_MAX_CHARS} characters): the goal, DONE work with exact file paths and commands, IN PROGRESS state, key decisions, verified test results, and the exact NEXT ACTION as the last line. Call it alone in a tool batch. The note is saved, this run ends, the context is compacted once you are idle, and the note is returned verbatim so you continue from NEXT ACTION. At the hard cutoff every other tool is blocked until this succeeds.`,
		promptSnippet: "Compact your own context: save a note_to_self, compaction runs when the turn ends, the note comes back verbatim",
		promptGuidelines: [
			`Use ${TOOL_NAME} alone in a tool batch when a [self-compact · …] message asks you to compact, or at a clean checkpoint when context is high.`,
			`A ${TOOL_NAME} note_to_self states the goal, DONE work with exact paths, IN PROGRESS state, key decisions, verified test results, and the exact NEXT ACTION as its last line; never list finished work as pending.`,
			`After a [self-compact · handoff] message, continue only the unfinished NEXT ACTION from your note; if the task is complete, report completion and stop.`,
		],
		parameters: Type.Object({
			note_to_self: Type.String({ description: `Your handoff note (1-${NOTE_MAX_CHARS} chars). Ends with the exact NEXT ACTION.` }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Self-compaction cancelled before saving the note.");
			const problem = inert();
			if (problem) throw new Error(`self-compact is inert because its settings were rejected: ${problem}`);
			if (handsOff(ctx)) throw new Error(`self-compact is disabled for this session (${handsOffReason(ctx)}). Re-enable it in /self-compact-settings or self-compact.json.`);
			// The note is preserved byte for byte; only the checks look at the trimmed form.
			const raw = typeof params.note_to_self === "string" ? params.note_to_self : "";
			if (raw.trim().length === 0) throw new Error("note_to_self must not be blank. Write the goal, DONE work, IN PROGRESS state, decisions, test results, and the NEXT ACTION.");
			if (raw.length > NOTE_MAX_CHARS) throw new Error(`note_to_self exceeds ${NOTE_MAX_CHARS} characters (${raw.length}). Shorten it and call ${TOOL_NAME} again.`);
			const existing = activeHandoff();
			if (existing && (existing.status === "compacting" || existing.status === "ready")) throw new Error("Compaction is already in progress for the saved note.");
			if (!(await compactable(ctx))) {
				R.usage = snapshotUsage(ctx);
				const keep = await keepRecentTokens(ctx.cwd);
				throw new Error(`Nothing to compact yet: OMP keeps the newest ${keep.toLocaleString("en-US")} tokens of messages untouched and this session does not reach past them (context ${R.usage.tokens?.toLocaleString("en-US") ?? "?"} tokens, ${formatPct(R.usage.percent, 1)}). No note was saved and no tool is blocked. Keep working and call ${TOOL_NAME} later.`);
			}
			if (existing && existing.note.trim() !== raw.trim()) {
				throw new Error(`A note is already saved (${existing.note.length} chars). Retry ${TOOL_NAME} with that saved note verbatim instead of a new one.`);
			}
			// A retry keeps the original bytes; a new cycle gets a fresh durable id.
			const note = existing ? existing.note : raw;
			R.state.handoff = { id: existing?.id ?? randomUUID(), note, status: "pending", attempts: 0, savedAt: Date.now() };
			R.lastCompactionError = undefined;
			setLocked(true);
			save();
			refreshUi(ctx);
			notify(ctx, `self-compact: note saved (${note.length} chars). Compaction runs when this turn ends.`, "info");
			const at = R.usage.tokens === null ? "unknown usage" : `${R.usage.tokens.toLocaleString("en-US")} tokens (${formatPct(R.usage.percent, 1)}), level ${R.level}`;
			return {
				content: [{ type: "text", text: `Note saved (${note.length} chars) at ${at}. Every other tool is blocked until compaction succeeds. Stop now: compaction runs when this turn ends and your note will be returned verbatim.` }],
				details: { handoffId: R.state.handoff.id, noteChars: note.length, cycle: R.state.cycle + 1, note, usedTokens: R.usage.tokens, usedPercent: R.usage.percent, level: R.level },
				// Ignored by OMP today (no terminate field); harmless if upstream semantics arrive.
				terminate: true,
			};
		},
		renderCall(args, _options, theme) {
			const note = typeof args?.note_to_self === "string" ? args.note_to_self : "";
			return new Text(`${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg("muted", `note ${note.length.toLocaleString("en-US")} chars`)}`, 0, 0);
		},
		renderResult(result, options, theme) {
			const first = result.content[0];
			const text = first && first.type === "text" ? first.text : "";
			// We author this details object in execute() above; the shape is ours.
			const details = result.details as { noteChars?: number; cycle?: number; note?: string; usedTokens?: number | null; usedPercent?: number | null; level?: string } | undefined;
			// Build the line from details (the text contains "21.1%", so splitting on "." would cut it short).
			const usage = details?.usedTokens !== undefined && details?.usedTokens !== null ? ` at ${details.usedTokens.toLocaleString("en-US")} tokens (${formatPct(details.usedPercent, 1)})` : "";
			const line = details?.noteChars !== undefined ? `Note saved (${details.noteChars.toLocaleString("en-US")} chars)${usage}. Compaction runs when this turn ends.` : text;
			let out = theme.fg("success", `✓ ${line}`);
			if (options.expanded && details?.note) out += `\n${theme.fg("dim", details.note)}`;
			return new Text(out, 0, 0);
		},
	});

	// -------------------------------------------------------------- commands

	pi.registerCommand("self-compact-info", {
		description: "Show self-compact settings, resolved thresholds, usage, state, cycle count, prompt sources, and pending notes (no LLM turn)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const info = infoLines(ctx);
			pi.appendEntry(INFO_ENTRY_TYPE, { ...info.data, lines: info.lines, at: Date.now() });
			if (ctx.hasUI) ctx.ui.notify(info.lines.join("\n"), "info");
			refreshUi(ctx);
		},
	});

	pi.registerCommand("self-compact-now", {
		description: "Ask the agent to write its note_to_self and call self_compact now (reuses a saved note on retry)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const problem = inert();
			if (problem) {
				notify(ctx, `self-compact: cannot compact, settings were rejected: ${problem}`, "error");
				return;
			}
			const h = handoff();
			if (h && (h.status === "compacting" || h.status === "ready")) {
				notify(ctx, "self-compact: compaction is already in progress.", "info");
				return;
			}
			const saved = h && (h.status === "pending" || h.status === "failed") ? h.note : undefined;
			const text = nowPrompt(saved);
			if (ctx.isIdle()) {
				pi.sendUserMessage(text);
				notify(ctx, saved ? "self-compact: asked the agent to compact now with its saved note." : "self-compact: asked the agent to write its note and compact now.", "info");
			} else {
				pi.sendUserMessage(text, { deliverAs: "steer" });
				notify(ctx, "self-compact: queued a steering request to compact now.", "info");
			}
		},
	});

	pi.registerCommand("self-compact-settings", {
		description: "Open the self-compact settings menu: enable/disable, thresholds, disabled roles/models, compaction prompt — saved to self-compact.json and applied live",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			await runSettingsMenu(ctx, {
				values: (): MenuValues => ({
					enabled: !R.disabled,
					compactSoftAt: R.specs.softAt,
					compactAt: R.specs.at,
					compactBuffer: R.specs.buffer,
					compactPrompt: R.compactPromptFile,
					compactReferenceWindow: R.referenceWindow !== undefined ? String(R.referenceWindow) : undefined,
					compactDisabledRoles: Object.keys(R.disabledModels.roles).concat(R.disabledModels.unknownRoles),
					compactDisabledModels: R.disabledModels.direct,
				}),
				knownRoles: () => loadModelRoles(ctx.cwd).byRole,
				settingsPath: () => settingsWritePath(ctx.cwd, R.settingsFile),
				apply: (patch) => {
					const error = writeSettingsFile(settingsWritePath(ctx.cwd, R.settingsFile), patch);
					if (error) return error;
					// Re-apply live: reload file settings, re-resolve thresholds and disabled models.
					loadSettings(ctx.cwd);
					resolve(ctx);
					refreshUi(ctx);
					return undefined;
				},
			});
		},
	});

	// ------------------------------------------------------------- renderers

	pi.registerMessageRenderer(HANDOFF_TYPE, (message, options, theme) => {
		// We author these details in deliverHandoff/recover; the shape is ours.
		const details = message.details as { cycle?: number; note?: string } | undefined;
		const note = details?.note ?? (typeof message.content === "string" ? message.content : "");
		// Always show the full note: this is exactly what was fed back into the agent after compaction.
		const header = theme.fg("success", theme.bold(`self-compact · handoff`)) + theme.fg("dim", ` cycle ${details?.cycle ?? "?"}, note_to_self returned verbatim to the agent (${note.length.toLocaleString("en-US")} chars):`);
		return new Text(`${header}\n${theme.fg("text", note)}`, options.outputPad ?? 1, 0);
	});

	function installFooter(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme) => {
			R.requestRender = () => tui.requestRender();
			return {
				dispose: () => {
					R.requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const t = R.thresholds;
					const u = R.usage;
					const level = R.level;
					const bar = renderContextBar({
						usedPct: t ? u.percent : null,
						cachedPct: u.window > 0 ? (u.cachedTokens / u.window) * 100 : 0,
						softPct: t?.softPct ?? 0,
						warnPct: t?.warnPct ?? 0,
						forcedPct: t?.forcedPct ?? 0,
					});
					const cells = bar.cells
						.map((c) => {
							if (c === "#") return theme.fg("success", c);
							if (c === "=") return theme.fg("accent", c);
							if (c === "~") return theme.fg("muted", c);
							if (c === "!") return theme.fg("warning", c);
							if (c === "|") return theme.fg("error", c);
							return theme.fg("dim", c);
						})
						.join("");
					const problem = inert();
					const tag = statusTag(ctx);
					const left = theme.fg("dim", ` ${ctx.model?.id ?? "no-model"}`) + (R.state.cycle > 0 ? theme.fg("dim", ` · cycle ${R.state.cycle}`) : "");
					const phase = tag ? ` ${theme.fg(problem ? "error" : locked() ? "error" : levelColor(level), tag)}` : "";
					const right = `${theme.fg("dim", "[")}${cells}${theme.fg("dim", `] ${bar.label}`)}${phase} `;
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width)];
				},
			};
		});
	}

	// ---------------------------------------------------------------- events

	const recover = async (event: { reason?: string }, ctx: ExtensionContext) => {
		clearTimers();
		R.alive = true;
		R.epoch += 1;
		R.announcedLevel = "idle";
		R.promptErrors.clear();
		R.compactionInFlight = false;
		R.autoCompactionActive = false;
		R.externalCompactionActive = false;
		R.lockedBlocks = 0;
		R.lastModelKey = "";
		R.searchDirs = promptSearchDirs(ctx.cwd, EXTENSION_DIR);
		loadSettings(ctx.cwd);
		resolve(ctx);
		const problem = inert();
		if (problem) notify(ctx, `self-compact REJECTED settings: ${problem}. Every tool is blocked until the flags are fixed.`, "error");
		const off = handsOffReason(ctx);
		if (off && ctx.hasUI) ctx.ui.notify(`self-compact: ${off} — hands-off for this session (native compaction still applies).`, "info");

		const recovered = recoverState(ctx.sessionManager.getBranch() as EntryLike[]);
		R.state = recovered.state;
		const h = handoff();
		if (h && recovered.journaledUnanswered) {
			// Crash between journaling the handoff and the model's answer: resume without a user prompt.
			R.state.handoff = { ...h, status: "done" };
			setLocked(false);
			save();
			notify(ctx, `self-compact: the returned note was never answered before ${event.reason}; resuming from it.`, "warning");
			const id = h.id;
			const cycle = R.state.cycle;
			const note = h.note;
			deferInEpoch("recoveryTimer", 500, () => {
				if (!ctx.isIdle()) return;
				pi.sendMessage(
					{ customType: HANDOFF_TYPE, content: `Continue from your saved note_to_self above (self-compact cycle ${cycle}). Perform only its unfinished NEXT ACTION.`, display: false, details: { id, cycle, note, resumed: true } },
					{ triggerTurn: true },
				);
			});
		} else if (h && h.status === "ready") {
			if (recovered.answered) {
				R.state.handoff = { ...h, status: "done" };
				setLocked(false);
				save();
			} else {
				setLocked(false);
				save();
				notify(ctx, `self-compact: compaction finished before ${event.reason}; returning the saved note.`, "info");
				deliverHandoff(ctx);
			}
		} else if (h && (h.status === "pending" || h.status === "failed" || h.status === "compacting")) {
			R.state.handoff = { ...h, status: h.status === "compacting" ? "failed" : h.status, attempts: 0, error: h.status === "compacting" ? "Compaction was interrupted (session reloaded)." : h.error };
			setLocked(true);
			save();
			notify(ctx, `self-compact: restored a saved note (${h.note.length} chars, ${event.reason}). Tools stay locked until compaction succeeds.`, "warning");
			deferInEpoch("recoveryTimer", 500, () => {
				const current = handoff();
				if (current && (current.status === "pending" || current.status === "failed") && ctx.isIdle()) startCompaction(ctx, `recovery after ${event.reason}`);
			});
		}
		installFooter(ctx);
		await trackLevel(ctx);
	};

	pi.on("session_start", async (event, ctx) => recover({ reason: (event as { reason?: string }).reason ?? "start" }, ctx));
	pi.on("session_switch", async (_event, ctx) => recover({ reason: "switch" }, ctx));
	pi.on("session_tree", async (_event, ctx) => recover({ reason: "tree" }, ctx));
	pi.on("session_branch", async (_event, ctx) => recover({ reason: "branch" }, ctx));

	pi.on("session_shutdown", async () => {
		R.alive = false;
		R.epoch += 1;
		clearTimers();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await trackLevel(ctx);
		if (handsOff(ctx)) return undefined; // no self-compact vocabulary on disabled models
		return { systemPrompt: [...event.systemPrompt, SYSTEM_PROMPT_LINE] };
	});

	pi.on("context", async (event, ctx) => {
		await trackLevel(ctx);
		const messages = event.messages.filter(
			(message) => !(message.role === "custom" && CONTEXT_FILTERED_TYPES.has((message as { customType?: string }).customType ?? "")),
		);
		try {
			const text = await guidanceText(ctx);
			if (text) messages.push(guidanceMessage(text));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!R.promptErrors.has(message)) {
				R.promptErrors.add(message);
				notify(ctx, `self-compact: ${message}`, "warning");
			}
			if (R.level === "warning") messages.push(guidanceMessage(renderTemplate(BUILTIN_PROMPTS.warning, templateValues())));
		}
		return { messages };
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") {
			// OMP emits no message_end for the custom handoff message: the assistant answer
			// after it is the first observable point where the journal must contain it.
			markHandoffDoneIfJournaled(ctx);
			await trackLevel(ctx);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		await trackLevel(ctx);
		const problem = inert();
		if (problem) return { block: true, reason: `self-compact rejected its settings, so this session is not protected: ${problem}. Fix the --compact-* flags or self-compact.json and restart.` };
		if (event.toolName === TOOL_NAME) return undefined;
		// Looking at the gauge is always allowed, even while every other tool is locked.
		if (event.toolName === VIEW_TOOL_NAME) return undefined;
		// Hands-off sessions (master switch off or disabled model) never block tools.
		if (handsOff(ctx)) return undefined;
		// Whole-batch preflight: siblings of a self_compact call in the same assistant message are blocked too.
		const branch = ctx.sessionManager.getBranch() as EntryLike[];
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			const calls = ((entry.message as AssistantMessage).content ?? []).filter((c) => c.type === "toolCall");
			const hasHandoff = calls.some((c) => c.type === "toolCall" && c.name === TOOL_NAME && typeof c.arguments?.note_to_self === "string" && c.arguments.note_to_self.trim().length > 0 && c.arguments.note_to_self.length <= NOTE_MAX_CHARS);
			if (hasHandoff && calls.some((c) => c.type === "toolCall" && c.id === event.toolCallId)) {
				return { block: true, reason: `Tool "${event.toolName}" is blocked by self-compact: ${TOOL_NAME} is in this tool batch, so the run must end here. Wait for the handoff.` };
			}
			break;
		}
		if (locked()) {
			const h = handoff();
			const u = R.usage;
			const t = R.thresholds;
			const why = h && (h.status === "pending" || h.status === "compacting")
				? `a ${TOOL_NAME} note is saved and compaction is ${h.status}`
				: h && h.status === "failed"
					? `the last compaction failed (${h.error ?? "unknown error"}) and the saved note is kept`
					: `context is at ${formatPct(u.percent, 1)} (${u.tokens?.toLocaleString("en-US") ?? "?"} tokens), at or above the forced threshold of ${formatPct(t?.forcedPct ?? null, 1)} (${t?.forcedTokens.toLocaleString("en-US") ?? "?"} tokens)`;
			R.lockedBlocks += 1;
			if (R.lockedBlocks >= LOCKED_BLOCK_ABORT_AFTER) {
				// Safety valve: OMP tool results cannot terminate a run, so a model that keeps
				// calling blocked tools would spin forever. Aborting unwinds to the settle path,
				// which starts the pending compaction.
				R.lockedBlocks = 0;
				ctx.abort();
			}
			return {
				block: true,
				reason: `Tool "${event.toolName}" is blocked by self-compact: ${why}. Every tool except ${TOOL_NAME} is blocked until compaction succeeds. Write your note_to_self and call ${TOOL_NAME} now.`,
			};
		}
		return undefined;
	});

	pi.on("turn_end", async (_event, ctx) => {
		await trackLevel(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await trackLevel(ctx);
		if (!inert() && !handsOff(ctx) && !activeHandoff() && R.idleRequestEpoch !== R.epoch && (locked() || R.level === "warning" || R.level === "forced")) {
			R.idleRequestEpoch = R.epoch;
			pi.sendMessage({ customType: GUIDANCE_TYPE, content: nowPrompt(), display: false }, { triggerTurn: true, deliverAs: "followUp" });
		}
		// OMP has no agent_settled: re-check the settle path shortly after the run ends.
		const epoch = R.epoch;
		setTimeout(() => {
			if (R.alive && epoch === R.epoch) void onSettled(ctx);
		}, 50);
	});

	pi.on("session_stop", async (_event, ctx) => {
		await onSettled(ctx);
	});

	pi.on("auto_compaction_start", async () => {
		R.autoCompactionActive = true;
	});
	pi.on("auto_compaction_end", async () => {
		R.autoCompactionActive = false;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		R.pendingCustomInstructions = event.customInstructions;
		if (handsOff(ctx)) return undefined; // disabled: native compaction proceeds untouched
		if (R.compactionInFlight) {
			// Our own ctx.compact(): validate the prompt early so a bad file cancels cleanly;
			// the session.compacting hook supplies the prompt itself.
			try {
				resolveCompactionPrompt({ flag: R.compactPromptFlag, file: R.compactPromptFile, searchDirs: R.searchDirs });
				R.lastCompactionError = undefined;
			} catch (error) {
				R.lastCompactionError = error instanceof Error ? error.message : String(error);
				notify(ctx, `self-compact: ${R.lastCompactionError}`, "error");
				return { cancel: true };
			}
			return undefined;
		}
		if (R.autoCompactionActive) {
			// Defer native auto-compaction to the self-compact flow (same as upstream's non-manual cancel).
			setLocked(true);
			save();
			refreshUi(ctx);
			return { cancel: true };
		}
		// A manual /compact we did not start: let it run with our prompt, tracked so a silent
		// failure (no session_compact_failed in OMP) still fails the handoff at settle time.
		try {
			resolveCompactionPrompt({ flag: R.compactPromptFlag, file: R.compactPromptFile, searchDirs: R.searchDirs });
			R.lastCompactionError = undefined;
		} catch (error) {
			R.lastCompactionError = error instanceof Error ? error.message : String(error);
			notify(ctx, `self-compact: ${R.lastCompactionError}`, "error");
			return { cancel: true };
		}
		R.externalCompactionActive = true;
		const h = activeHandoff();
		if (h && (h.status === "pending" || h.status === "failed")) {
			h.status = "compacting";
			save();
		}
		return undefined;
	});
	pi.on("session.compacting", async (_event, ctx) => {
		if (handsOff(ctx)) { R.pendingCustomInstructions = undefined; return undefined; }
		// Native summarization runs with our prompt; the agent's note rides in preserveData so
		// recovery can pair the compaction entry with the handoff (OMP has no details override).
		try {
			const prompt = resolveCompactionPrompt({ flag: R.compactPromptFlag, file: R.compactPromptFile, searchDirs: R.searchDirs });
			const instructions = loadPromptFile("summaryInstructions", R.searchDirs);
			const custom = R.pendingCustomInstructions?.trim();
			R.pendingCustomInstructions = undefined;
			const text = [prompt.text.trim(), instructions.text.trim(), custom].filter(Boolean).join("\n\n");
			const h = activeHandoff();
			return {
				prompt: text,
				preserveData: {
					handoffId: h?.id,
					selfCompact: {
						cycle: R.state.cycle + (h ? 1 : 0),
						promptSource: prompt.source,
						userPromptSource: instructions.source,
						noteChars: h?.note.length ?? 0,
					},
				},
			};
		} catch {
			return undefined; // before_compact already reported the error; native prompt runs
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		R.epoch += 1;
		R.announcedLevel = "idle";
		R.compactionInFlight = false;
		R.externalCompactionActive = false;
		const h = handoff();
		if (h && h.status !== "done") {
			R.state.cycle += 1;
			R.state.handoff = { ...h, status: "ready", error: undefined };
			setLocked(false);
			save();
			notify(ctx, `self-compact: compaction succeeded (cycle ${R.state.cycle}); returning the note (${h.note.length} chars) and restoring tools.`, "info");
			deliverHandoff(ctx);
		} else if (locked()) {
			// Context shrank through another path (e.g. /compact without a note): release the forced lock.
			setLocked(false);
			save();
		}
		refreshUi(ctx);
	});
}
