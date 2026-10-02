/**
 * Mid-session settings reload — the lane-12 defect contract.
 *
 * The settings-write path (and any external write to self-compact.json) must
 * re-resolve the live runtime: handsOff()/handsOffReason() must reflect the NEW
 * file without a session restart — same semantics as session start.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INFO_ENTRY_TYPE } from "../state.ts";

// ---------------------------------------------------------------------------
// Module mocks: index.ts imports OMP internals that don't exist outside the
// extension host. Everything it uses at load/registration time is stubbed.
// ---------------------------------------------------------------------------

mock.module("typebox", () => ({
	Type: { Object: (v: unknown) => ({ type: "object", v }), String: (v: unknown) => ({ type: "string", v }) },
}));

mock.module("@earendil-works/pi-tui", () => ({
	Text: class Text {
		constructor(
			public text: string,
			public a = 0,
			public b = 0,
		) {}
	},
}));

mock.module("@earendil-works/pi-coding-agent", () => ({
	SettingsManager: {
		create: async () => ({ getGroup: () => ({}) }),
	},
}));

// probePrepareCompaction does `await import(...)` internally; force its
// "not available" arm so tests never touch OMP's compaction engine.
mock.module("@earendil-works/pi-agent-core/compaction", () => ({}));

// Dynamic import is required: the mock.module registrations above must run
// before index.ts's module body executes or the real (missing) packages load.
const { default: selfCompact } = await import("../index.ts");

// ---------------------------------------------------------------------------
// Fake pi / ctx
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: FakeCtx) => unknown;

interface CommandDef {
	handler: (args: string, ctx: FakeCtx) => Promise<void>;
}

interface FakePi {
	handlers: Map<string, Handler>;
	commands: Map<string, CommandDef>;
	entries: { type: string; data: unknown }[];
	flags: Map<string, unknown>;
	sent: { message: unknown; options?: unknown }[];
	userMessages: { text: string; options?: unknown }[];
}

function makePi(flags: Record<string, unknown> = {}): FakePi {
	return {
		handlers: new Map(),
		commands: new Map(),
		entries: [],
		flags: new Map(Object.entries(flags)),
		sent: [],
		userMessages: [],
	};
}

/** The subset of ExtensionAPI index.ts registers against. */
interface PiApi {
	getFlag(name: string): unknown;
	registerFlag(name: string, def: unknown): void;
	on(name: string, handler: Handler): void;
	registerCommand(name: string, def: CommandDef): void;
	registerShortcut(name: string, def: unknown): void;
	registerTool(def: unknown): void;
	registerMessageRenderer(type: string, fn: unknown): void;
	appendEntry(type: string, data: unknown): void;
	sendMessage(message: unknown, options?: unknown): void;
	sendUserMessage(text: string, options?: unknown): void;
}

function extensionPi(pi: FakePi): PiApi {
	return {
		getFlag: (name) => pi.flags.get(name),
		registerFlag: () => {},
		on: (name, handler) => pi.handlers.set(name, handler),
		registerCommand: (name, def) => pi.commands.set(name, def),
		registerShortcut: () => {},
		registerTool: () => {},
		registerMessageRenderer: () => {},
		appendEntry: (type, data) => pi.entries.push({ type, data }),
		sendMessage: (message, options) => pi.sent.push({ message, options }),
		sendUserMessage: (text, options) => pi.userMessages.push({ text, options }),
	};
}

interface FakeModel {
	provider: string;
	id: string;
	contextWindow: number;
}

interface CtxOpts {
	cwd: string;
	model?: FakeModel;
	mode?: "tui" | "rpc" | "print";
	hasUI?: boolean;
	ui?: Partial<FakeUi>;
	tokens?: number;
	/** Session-branch entries exposed via sessionManager.getBranch() (model_change stamps). */
	branch?: unknown[];
}

interface FakeUi {
	notify(message: string, type?: string): void;
	setStatus(key: string, value?: string): void;
	setWidget(key: string, value?: unknown): void;
	theme: { fg(color: string, s: string): string; bold(s: string): string };
	select(title: string, options: { label: string }[], opts?: unknown): Promise<string | undefined>;
	input(title: string, initial?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	editor(title: string, initial?: string): Promise<string | undefined>;
}

interface FakeCtx {
	mode: "tui" | "rpc" | "print";
	hasUI: boolean;
	cwd: string;
	model: FakeModel | undefined;
	isIdle(): boolean;
	abort(): void;
	setInterval(fn: () => void, ms: number): number;
	clearTimer(t: unknown): void;
	getContextUsage(): { tokens: number; percent: null; contextWindow: number };
	sessionManager: { getBranch(): unknown[] };
	compact(): Promise<void>;
	ui: FakeUi;
	notifications: { message: string; type: string }[];
	statuses: (string | undefined)[];
}

function makeCtx(o: CtxOpts): FakeCtx {
	const notifications: { message: string; type: string }[] = [];
	const statuses: (string | undefined)[] = [];
	const noop = async () => undefined;
	const ui: FakeUi = {
		notify: (message, type = "info") => notifications.push({ message, type }),
		setStatus: (_key, value) => statuses.push(value),
		setWidget: () => {},
		theme: { fg: (_c, s) => s, bold: (s) => s },
		select: noop,
		input: noop,
		confirm: async () => false,
		editor: noop,
		...(o.ui ?? {}),
	};
	return {
		mode: o.mode ?? "rpc",
		hasUI: o.hasUI ?? true,
		cwd: o.cwd,
		model: o.model,
		isIdle: () => true,
		abort: () => {},
		setInterval: () => 0,
		clearTimer: () => {},
		getContextUsage: () => ({ tokens: o.tokens ?? 0, percent: null, contextWindow: o.model?.contextWindow ?? 0 }),
		sessionManager: { getBranch: () => o.branch ?? [] },
		compact: async () => {},
		ui,
		notifications,
		statuses,
	};
}

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_AGENT_DIR"] as const;
const savedEnv = new Map<string, string | undefined>();
for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);

let dirs: string[] = [];
const savedArgv = process.argv;
beforeEach(() => {
	dirs = [];
});
afterEach(() => {
	process.argv = savedArgv;
	for (const k of ENV_KEYS) {
		const v = savedEnv.get(k);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
	agentDir: string;
	cwd: string;
	writeSettings(values: Record<string, unknown>): void;
}

function fixture(): Fixture {
	const base = mkdtempSync(join(tmpdir(), "sc-reload-"));
	dirs.push(base);
	const agentDir = join(base, "agent");
	mkdirSync(agentDir, { recursive: true });
	const cwd = join(base, "project");
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.OMP_AGENT_DIR;
	const settingsPath = join(agentDir, "self-compact.json");
	return {
		agentDir,
		cwd,
		writeSettings: (values) => writeFileSync(settingsPath, `${JSON.stringify(values, null, "\t")}\n`),
	};
}

const MODEL: FakeModel = { provider: "test", id: "swe-2", contextWindow: 1_000_000 };

const BASE_SETTINGS: Record<string, unknown> = {
	enabled: true,
	compactSoftAt: "10%",
	compactAt: "20%",
	compactBuffer: "5%",
	compactReferenceWindow: "1m",
};

function handler(pi: FakePi, name: string): Handler {
	const h = pi.handlers.get(name);
	if (!h) throw new Error(`handler not registered: ${name}`);
	return h;
}

function command(pi: FakePi, name: string): CommandDef {
	const c = pi.commands.get(name);
	if (!c) throw new Error(`command not registered: ${name}`);
	return c;
}

/** Start the extension and run the session_start recovery. */
async function startSession(pi: FakePi, ctx: FakeCtx) {
	await handler(pi, "session_start")({}, ctx);
}

interface BeforeAgentStartResult {
	systemPrompt: string[];
}

/** before_agent_start returns { systemPrompt } when live, undefined when hands-off. */
async function liveViaSystemPrompt(pi: FakePi, ctx: FakeCtx): Promise<boolean> {
	const out: unknown = await handler(pi, "before_agent_start")({ systemPrompt: ["base"] }, ctx);
	if (!out || typeof out !== "object" || !("systemPrompt" in out)) return false;
	const result = out as BeforeAgentStartResult; // named cast: the handler's declared result shape
	return result.systemPrompt.some((line) => line.startsWith("self-compact:"));
}

interface InfoData {
	disabled?: { active?: string | null };
}

/** The `disabled.active` verdict from the latest /self-compact-info entry. */
function infoDisabledReason(pi: FakePi): string | null | undefined {
	for (let i = pi.entries.length - 1; i >= 0; i--) {
		const e = pi.entries[i]!;
		if (e.type !== INFO_ENTRY_TYPE) continue;
		if (!e.data || typeof e.data !== "object") return undefined;
		const data = e.data as InfoData; // named cast: appendEntry payload shape authored by index.ts
		return data.disabled?.active;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
describe("mid-session settings reload", () => {
	test("external write to self-compact.json re-resolves handsOff without restart", async () => {
		const f = fixture();
		f.writeSettings(BASE_SETTINGS);
		const pi = makePi();
		selfCompact(extensionPi(pi));
		const ctx = makeCtx({ cwd: f.cwd, model: MODEL });
		await startSession(pi, ctx);

		// Live: before_agent_start appends the self-compact line.
		expect(await liveViaSystemPrompt(pi, ctx)).toBe(true);

		// An external writer disables the active model mid-session.
		f.writeSettings({ ...BASE_SETTINGS, compactDisabledModels: ["test/swe-2"] });

		// The next decision point must see the new verdict — no restart.
		expect(await liveViaSystemPrompt(pi, ctx)).toBe(false);
		await command(pi, "self-compact-info").handler("", ctx);
		expect(infoDisabledReason(pi)).toBe("model test/swe-2 is disabled");

		// Re-enabling mid-session brings it back.
		f.writeSettings({ ...BASE_SETTINGS, compactDisabledModels: [] });
		expect(await liveViaSystemPrompt(pi, ctx)).toBe(true);
	});

	test("role-scoped disable applies only when the session selected the role", async () => {
		const f = fixture();
		// modelRoles maps BOSS-ROLE to the SAME model the session runs — the reported
		// defect config: disabling the role must not follow the shared model.
		writeFileSync(join(f.agentDir, "config.yml"), "modelRoles:\n  BOSS-ROLE: test/swe-2\n  default: test/swe-2\n");
		f.writeSettings({ ...BASE_SETTINGS, compactDisabledRoles: ["BOSS-ROLE"] });
		const pi = makePi();
		selfCompact(extensionPi(pi));
		// Default launch: role-less root model_change, no --model → role is "default",
		// not BOSS-ROLE → stays live even though the model matches.
		const entries: unknown[] = [{ type: "model_change", parentId: null }];
		const ctx = makeCtx({ cwd: f.cwd, model: MODEL, branch: entries });
		await startSession(pi, ctx);
		expect(await liveViaSystemPrompt(pi, ctx)).toBe(true);

		// Selecting the role mid-session (stamped model_change) disables live.
		entries.push({ type: "model_change", parentId: "a", role: "BOSS-ROLE" });
		expect(await liveViaSystemPrompt(pi, ctx)).toBe(false);
		await command(pi, "self-compact-info").handler("", ctx);
		expect(infoDisabledReason(pi)).toBe(
			"role BOSS-ROLE is disabled (compactDisabledRoles matches the role the session selected, not the resolved model)",
		);

		// Switching back out of the role re-enables.
		entries.push({ type: "model_change", parentId: "b", role: "default" });
		expect(await liveViaSystemPrompt(pi, ctx)).toBe(true);
	});

	test("launch --model pi/<role> disables a session whose model matches the default", async () => {
		const f = fixture();
		writeFileSync(join(f.agentDir, "config.yml"), "modelRoles:\n  TOPDOG: test/swe-2\n  default: test/swe-2\n");
		f.writeSettings({ ...BASE_SETTINGS, compactDisabledRoles: ["TOPDOG"] });
		const pi = makePi();
		// Launch spec is captured when the extension factory runs.
		process.argv = [...savedArgv, "--model", "pi/TOPDOG"];
		selfCompact(extensionPi(pi));
		const ctx = makeCtx({
			cwd: f.cwd,
			model: MODEL,
			branch: [{ type: "model_change", parentId: null }],
		});
		await startSession(pi, ctx);
		expect(await liveViaSystemPrompt(pi, ctx)).toBe(false);
	});

	test("settings file created mid-session applies without restart", async () => {
		const f = fixture();
		// No self-compact.json anywhere: the extension loads defaults.
		const pi = makePi();
		selfCompact(extensionPi(pi));
		const ctx = makeCtx({ cwd: f.cwd, model: MODEL });
		await startSession(pi, ctx);
		expect(await liveViaSystemPrompt(pi, ctx)).toBe(true);

		f.writeSettings({ ...BASE_SETTINGS, enabled: false });

		expect(await liveViaSystemPrompt(pi, ctx)).toBe(false);
	});

	test("settings-menu apply path re-resolves handsOff live", async () => {
		const f = fixture();
		f.writeSettings({ ...BASE_SETTINGS, compactDisabledModels: ["test/swe-2"] });
		const pi = makePi();
		selfCompact(extensionPi(pi));

		// TUI context: the settings menu requires it. Drive it: open "Disabled
		// models:", submit an empty list, then Done to close.
		let cleared = false;
		const ui: Partial<FakeUi> = {
			select: async (_title, options) => {
				const target = options.find((o) => o.label.startsWith(cleared ? "Done" : "Disabled models:"));
				return target?.label;
			},
			input: async () => {
				cleared = true;
				return "";
			},
		};
		const ctx = makeCtx({ cwd: f.cwd, model: MODEL, mode: "tui", ui });
		await startSession(pi, ctx);
		expect(await liveViaSystemPrompt(pi, ctx)).toBe(false);

		await command(pi, "self-compact-settings").handler("", ctx);
		expect(cleared).toBe(true);

		expect(await liveViaSystemPrompt(pi, ctx)).toBe(true);
		await command(pi, "self-compact-info").handler("", ctx);
		expect(infoDisabledReason(pi) ?? null).toBeNull();
	});

	test("enabled=false written mid-session turns the extension hands-off", async () => {
		const f = fixture();
		f.writeSettings(BASE_SETTINGS);
		const pi = makePi();
		selfCompact(extensionPi(pi));
		const ctx = makeCtx({ cwd: f.cwd, model: MODEL });
		await startSession(pi, ctx);
		expect(await liveViaSystemPrompt(pi, ctx)).toBe(true);

		f.writeSettings({ ...BASE_SETTINGS, enabled: false });
		expect(await liveViaSystemPrompt(pi, ctx)).toBe(false);
		await command(pi, "self-compact-info").handler("", ctx);
		expect(infoDisabledReason(pi)).toBe("disabled in self-compact.json");
	});
});
