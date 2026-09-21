/**
 * /self-compact-settings — interactive settings menu over ctx.ui dialogs.
 *
 * Every change is written to the active self-compact.json and re-applied to the live
 * runtime immediately (thresholds re-resolve, disabled roles re-match the current model),
 * so the menu doubles as the kill switch: "Enabled: off" makes the extension fully
 * hands-off without a restart.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseTokenSpec, validateSpecs, SPEC_HELP, type ThresholdSpecs } from "./thresholds.ts";

/** Effective values as the menu displays them (file values merged over defaults). */
export interface MenuValues {
	enabled: boolean;
	/** Session-only switch (/self-compact-toggle); shown separately because it never writes the file. */
	sessionDisabled: boolean;
	compactSoftAt: string;
	compactAt: string;
	compactBuffer: string;
	compactPrompt?: string;
	compactReferenceWindow?: string;
	compactDisabledRoles: string[];
	compactDisabledModels: string[];
}

export interface SettingsMenuDeps {
	/** Current effective values; re-read every loop iteration so the menu shows live state. */
	values(): MenuValues;
	/** role name → "provider/model" for every entry in modelRoles (for the multi-select). */
	knownRoles(): Record<string, string>;
	/** Persist a patch into self-compact.json and reload the runtime; returns an error string on failure. */
	apply(patch: Record<string, unknown>): string | undefined;
	/** Flip the session-only switch (no file write). */
	sessionToggle(): void;
	/** Absolute path of the file being written (for the header and non-TUI fallback message). */
	settingsPath(): string;
}

const DONE = "Done — close";

export async function runSettingsMenu(ctx: ExtensionCommandContext, deps: SettingsMenuDeps): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify(`self-compact settings need the interactive TUI. Edit ${deps.settingsPath()} directly.`, "warning");
		return;
	}

	for (;;) {
		const v = deps.values();
		const choice = await ctx.ui.select("self-compact settings", [
			{ label: `Enabled: ${v.enabled ? "on" : "OFF"}`, description: "Master switch, saved to self-compact.json. Off = fully hands-off: no guidance, no lock, native compaction untouched." },
			{ label: `This session: ${v.sessionDisabled ? "OFF" : "on"}`, description: "Session-only toggle — same as /self-compact-toggle or ctrl+shift+k. Never written to the file; ends with the pane." },
			{ label: `Notice threshold: ${v.compactSoftAt}`, description: `First heads-up to the agent. ${SPEC_HELP}` },
			{ label: `Warning threshold: ${v.compactAt}`, description: "Agent is asked to write its note and compact." },
			{ label: `Forced buffer: ${v.compactBuffer}`, description: "Allowance above the warning line before every other tool is blocked." },
			{ label: `Reference window: ${v.compactReferenceWindow ?? "model's own"}`, description: "Fixed window % thresholds resolve against (e.g. 1m): every model compacts at the same absolute tokens; smaller windows stay hands-off." },
			{ label: `Disabled roles: ${v.compactDisabledRoles.join(", ") || "none"}`, description: "modelRoles names whose model never self-compacts (e.g. default → devin/swe-2)." },
			{ label: `Disabled models: ${v.compactDisabledModels.join(", ") || "none"}`, description: "provider/model or provider/* entries that never self-compact." },
			{ label: `Compaction prompt: ${v.compactPrompt ? `${v.compactPrompt.length} chars (custom)` : "default file"}`, description: "Literal text replacing the compaction summary prompt." },
			{ label: DONE, description: "Close this menu." },
		]);
		if (!choice || choice === DONE) return;

		if (choice.startsWith("Enabled:")) {
			const target = !v.enabled;
			const ok = await ctx.ui.confirm("self-compact", target ? "Enable self-compaction management?" : "Disable self-compact? The agent keeps working; native compaction stays as the safety net.");
			if (!ok) continue;
			report(ctx, deps.apply({ enabled: target }));
		} else if (choice.startsWith("This session:")) {
			deps.sessionToggle();
		} else if (choice.startsWith("Notice threshold:")) {
			await editSpec(ctx, deps, "compactSoftAt", "Notice threshold", v);
		} else if (choice.startsWith("Warning threshold:")) {
			await editSpec(ctx, deps, "compactAt", "Warning threshold", v);
		} else if (choice.startsWith("Forced buffer:")) {
			await editSpec(ctx, deps, "compactBuffer", "Forced buffer", v);
		} else if (choice.startsWith("Reference window:")) {
			const text = await ctx.ui.input("Reference window for % thresholds — token count (1m, 500k) or empty for the model's own", v.compactReferenceWindow ?? "");
			if (text === undefined) continue;
			const trimmed = text.trim();
			if (trimmed) {
				try {
					const parsed = parseTokenSpec(trimmed, "compactReferenceWindow");
					if (parsed.kind !== "tokens") throw new Error("must be a token count, not a percentage");
				} catch (error) {
					ctx.ui.notify(`self-compact: ${error instanceof Error ? error.message : String(error)}`, "error");
					continue;
				}
			}
			report(ctx, deps.apply({ compactReferenceWindow: trimmed === "" ? null : trimmed }));
		} else if (choice.startsWith("Disabled roles:")) {
			await editRoles(ctx, deps, v);
		} else if (choice.startsWith("Disabled models:")) {
			const text = await ctx.ui.input("Disabled models (comma-separated provider/model or provider/*)", v.compactDisabledModels.join(", "));
			if (text === undefined) continue;
			report(ctx, deps.apply({ compactDisabledModels: parseList(text) }));
		} else if (choice.startsWith("Compaction prompt:")) {
			const text = await ctx.ui.editor("Compaction summary prompt (empty = default file)", v.compactPrompt ?? "");
			if (text === undefined) continue;
			report(ctx, deps.apply({ compactPrompt: text.trim() === "" ? null : text }));
		}
	}
}

async function editSpec(ctx: ExtensionCommandContext, deps: SettingsMenuDeps, key: "compactSoftAt" | "compactAt" | "compactBuffer", title: string, v: MenuValues) {
	// Presets cover the common cases so the user picks instead of typing; "Custom…" keeps
	// the free-form path for token counts and odd percentages.
	const presets = ["10%", "15%", "20%", "30%", "40%", "50%", "60%", "70%", "80%"];
	const current = v[key];
	const options = [...new Set([current, ...presets])];
	const CUSTOM = "Custom…";
	const choice = await ctx.ui.select(`${title} — current: ${current}`, [
		...options.map((p) => ({ label: p, description: p === current ? "current value" : undefined })),
		{ label: CUSTOM, description: `Type a value. ${SPEC_HELP}` },
	]);
	if (choice === undefined) return;
	let trimmed: string;
	if (choice === CUSTOM) {
		const text = await ctx.ui.input(`${title} — e.g. 45% or 500k`, "45%");
		if (text === undefined) return;
		trimmed = text.trim();
		if (!trimmed) return;
	} else {
		trimmed = choice;
	}
	const candidate: ThresholdSpecs = { softAt: v.compactSoftAt, at: v.compactAt, buffer: v.compactBuffer, [key]: trimmed };
	try {
		validateSpecs(candidate);
	} catch (error) {
		ctx.ui.notify(`self-compact: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	report(ctx, deps.apply({ [key]: trimmed }));
}

async function editRoles(ctx: ExtensionCommandContext, deps: SettingsMenuDeps, v: MenuValues) {
	const known = deps.knownRoles();
	const current = new Set(v.compactDisabledRoles);
	// Known modelRoles names plus any currently-set names that no longer resolve
	// (kept visible so they can be untoggled rather than silently dropped).
	const names = [...Object.keys(known), ...[...current].filter((r) => !(r in known))];
	if (names.length === 0) {
		ctx.ui.notify("self-compact: no modelRoles found in config.yml — use Disabled models instead.", "warning");
		return;
	}
	const selected = new Set(current);
	for (;;) {
		const checkedIndices = names.map((name, index) => (selected.has(name) ? index : -1)).filter((index) => index >= 0);
		const choice = await ctx.ui.select(
			"Roles that never self-compact",
			[...names.map((name) => ({ label: name, description: known[name] ?? "(not in modelRoles)" })), { label: "Done", description: "save and close" }],
			{
				selectionMarker: "checkbox",
				checkedIndices,
				markableCount: names.length,
				helpText: "enter toggle · Done saves · esc cancels",
			},
		);
		if (choice === undefined) return; // cancelled: nothing written
		if (choice === "Done") break;
		if (selected.has(choice)) selected.delete(choice);
		else selected.add(choice);
	}
	report(ctx, deps.apply({ compactDisabledRoles: [...selected] }));
}

function parseList(text: string): string[] {
	return text.split(",").map((s) => s.trim()).filter(Boolean);
}

function report(ctx: ExtensionCommandContext, error: string | undefined) {
	ctx.ui.notify(error ? `self-compact: ${error}` : "self-compact: settings saved and applied.", error ? "error" : "info");
}
