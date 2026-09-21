/**
 * /self-compact-settings — interactive settings menu over ctx.ui dialogs.
 *
 * Every change is written to the active self-compact.json and re-applied to the live
 * runtime immediately (thresholds re-resolve, disabled roles re-match the current model),
 * so the menu doubles as the kill switch: "Enabled: off" makes the extension fully
 * hands-off without a restart.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { validateSpecs, SPEC_HELP, type ThresholdSpecs } from "./thresholds.ts";

/** Effective values as the menu displays them (file values merged over defaults). */
export interface MenuValues {
	enabled: boolean;
	compactSoftAt: string;
	compactAt: string;
	compactBuffer: string;
	compactPrompt?: string;
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
			{ label: `Enabled: ${v.enabled ? "on" : "OFF"}`, description: "Master switch. Off = fully hands-off: no guidance, no lock, native compaction untouched." },
			{ label: `Notice threshold: ${v.compactSoftAt}`, description: `First heads-up to the agent. ${SPEC_HELP}` },
			{ label: `Warning threshold: ${v.compactAt}`, description: "Agent is asked to write its note and compact." },
			{ label: `Forced buffer: ${v.compactBuffer}`, description: "Allowance above the warning line before every other tool is blocked." },
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
		} else if (choice.startsWith("Notice threshold:")) {
			await editSpec(ctx, deps, "compactSoftAt", "Notice threshold", v);
		} else if (choice.startsWith("Warning threshold:")) {
			await editSpec(ctx, deps, "compactAt", "Warning threshold", v);
		} else if (choice.startsWith("Forced buffer:")) {
			await editSpec(ctx, deps, "compactBuffer", "Forced buffer", v);
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
	const text = await ctx.ui.input(`${title} — ${SPEC_HELP}`, v[key]);
	if (text === undefined) return;
	const trimmed = text.trim();
	if (!trimmed) return;
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
