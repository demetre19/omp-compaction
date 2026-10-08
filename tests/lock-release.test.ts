/**
 * Lock-release contract — the model-switch permanent-brick defect.
 *
 * state.locked is journaled: once the forced threshold engages it, a model/role
 * switch (or a settings edit, or a restart) into a context that cannot compact
 * used to leave every tool except self_compact/view_context blocked forever.
 * The fix releases the lock wherever the hands-off verdict is re-evaluated,
 * retires handoffs that can never compact, and re-evaluates the lock on a
 * still-enabled model whose usage sits below the new forced line.
 *
 * Acceptance arms from the defect report:
 *  - locked → role switch to a compactDisabledRoles role → tools pass
 *  - recover under hands-off → unlocked (and the saved note retired)
 *  - locked → compactable model with usage below forced → unlocked
 *  - locked + pending handoff + still-enabled model → lock HOLDS (no regression)
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STATE_TYPE } from "../state.ts";

// ---------------------------------------------------------------------------
// Module mocks (same as reload.test.ts): index.ts imports OMP internals that
// don't exist outside the extension host.
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

mock.module("@earendil-works/pi-agent-core/compaction", () => ({}));

const { default: selfCompact } = await import("../index.ts");

// ---------------------------------------------------------------------------
// Fake pi / ctx (mirrors reload.test.ts conventions)
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
	tokens?: number;
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
	tokens: number;
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
	};
	const ctx: FakeCtx = {
		mode: o.mode ?? "rpc",
		hasUI: o.hasUI ?? true,
		cwd: o.cwd,
		model: o.model,
		isIdle: () => true,
		abort: () => {},
		setInterval: () => 0,
		clearTimer: () => {},
		getContextUsage: () => ({ tokens: ctx.tokens, percent: null, contextWindow: ctx.model?.contextWindow ?? 0 }),
		sessionManager: { getBranch: () => o.branch ?? [] },
		compact: async () => {},
		ui,
		notifications,
		statuses,
		tokens: o.tokens ?? 0,
	};
	return ctx;
}

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_AGENT_DIR"] as const;
const savedEnv = new Map<string, string | undefined>();
for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);

let dirs: string[] = [];
beforeEach(() => {
	dirs = [];
});
afterEach(() => {
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
	const base = mkdtempSync(join(tmpdir(), "sc-lock-"));
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
const MODEL_B: FakeModel = { provider: "test", id: "big-3", contextWindow: 1_000_000 };

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

async function startSession(pi: FakePi, ctx: FakeCtx) {
	await handler(pi, "session_start")({}, ctx);
}

interface ToolCallResult {
	block: boolean;
	reason: string;
}

/** Fire a tool_call for a non-exempt tool; returns {block:true} when locked. */
async function callTool(pi: FakePi, ctx: FakeCtx, toolName = "read"): Promise<ToolCallResult | undefined> {
	const out: unknown = await handler(pi, "tool_call")({ toolName, toolCallId: "tc-1" }, ctx);
	if (!out) return undefined;
	return out as ToolCallResult;
}

/** A journaled locked state entry, as save() would have appended it. */
function lockedState(handoff?: { id: string; note: string; status: string; attempts: number; savedAt: number }) {
	return { type: "custom", customType: STATE_TYPE, data: { version: 1, cycle: 0, locked: true, handoff } };
}

const PENDING_HANDOFF = { id: "h-1", note: "resume the fix", status: "pending", attempts: 0, savedAt: 1 };

// ---------------------------------------------------------------------------
describe("lock release on context change", () => {
	test("locked → role switch to a compactDisabledRoles role → tools pass and the note retires", async () => {
		const f = fixture();
		writeFileSync(join(f.agentDir, "config.yml"), "modelRoles:\n  TOP-DOG: test/swe-2\n  default: test/swe-2\n");
		f.writeSettings({ ...BASE_SETTINGS, compactDisabledRoles: ["TOP-DOG"] });
		const pi = makePi();
		selfCompact(extensionPi(pi));
		const entries: unknown[] = [
			{ type: "model_change", parentId: null },
			lockedState(PENDING_HANDOFF),
		];
		const ctx = makeCtx({ cwd: f.cwd, model: MODEL, branch: entries, tokens: 300_000 });
		await startSession(pi, ctx);
		expect((await callTool(pi, ctx))?.block).toBe(true);

		// Mid-session role switch into the disabled role (stamped model_change).
		entries.push({ type: "model_change", parentId: "a", role: "TOP-DOG" });
		expect(await callTool(pi, ctx)).toBeUndefined();
	});

	test("recover under hands-off unlocks instead of re-bricking", async () => {
		const f = fixture();
		f.writeSettings({ ...BASE_SETTINGS, compactDisabledModels: ["test/swe-2"] });
		const pi = makePi();
		selfCompact(extensionPi(pi));
		const ctx = makeCtx({
			cwd: f.cwd,
			model: MODEL,
			branch: [lockedState(PENDING_HANDOFF)],
			tokens: 300_000,
		});
		await startSession(pi, ctx);
		expect(await callTool(pi, ctx)).toBeUndefined();

		// The released state was journaled: latest state entry is unlocked/done.
		const last = pi.entries.filter((e) => e.type === STATE_TYPE).at(-1)!.data as { locked: boolean; handoff?: { status: string } };
		expect(last.locked).toBe(false);
		expect(last.handoff?.status).toBe("done");
	});

	test("locked → still-enabled model with usage below its forced line → unlocked", async () => {
		const f = fixture();
		f.writeSettings(BASE_SETTINGS);
		const pi = makePi();
		selfCompact(extensionPi(pi));
		const ctx = makeCtx({
			cwd: f.cwd,
			model: MODEL,
			branch: [lockedState()],
			tokens: 300_000,
		});
		await startSession(pi, ctx);
		// Locked, no handoff: the recover-time release is deferred to the first
		// decision point that sees fresh usage — 300k ≥ 250k forced, still locked.
		expect((await callTool(pi, ctx))?.block).toBe(true);

		// Model switch (same forced line) with usage below it: lock is orphaned.
		ctx.model = MODEL_B;
		ctx.tokens = 50_000;
		expect(await callTool(pi, ctx)).toBeUndefined();
	});

	test("locked + pending handoff + still-enabled model → lock HOLDS", async () => {
		const f = fixture();
		f.writeSettings(BASE_SETTINGS);
		const pi = makePi();
		selfCompact(extensionPi(pi));
		const ctx = makeCtx({
			cwd: f.cwd,
			model: MODEL,
			branch: [lockedState(PENDING_HANDOFF)],
			tokens: 300_000,
		});
		await startSession(pi, ctx);
		expect((await callTool(pi, ctx))?.block).toBe(true);

		// Usage drops below forced on a model switch, but the pending note keeps the lock.
		ctx.model = MODEL_B;
		ctx.tokens = 50_000;
		const result = await callTool(pi, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("self_compact");
	});
});
