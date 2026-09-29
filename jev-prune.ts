/**
 * jev-prune — optional Jev (TypeSafe System One) pre-stage for OMP compaction.
 *
 * Runs tamaratran/fast-jev-compaction (vendored under vendor/fast-jev/, MIT) over
 * `preparation.messagesToSummarize` (+ turnPrefixMessages): every tool call is
 * scored keep/drop, dropped results are truncated in place, dropped calls are
 * removed in place — so the LLM summarizer sees a much smaller, less noisy input.
 *
 * Transport ladder (first working wins, sticky per compaction):
 *   1. OpenRouter  POST https://openrouter.ai/api/alpha/decisions  model typesafe/jev-1.13
 *   2. OpenLux     POST <models.yml baseUrl>/systemone             model jev-1.13.0
 *   3. TypeSafe    POST https://api.typesafe.ai/v1/systemone       model jev-latest
 * If no transport has credentials, or every transport fails, the caller falls
 * back to plain native compaction — entries are left untouched.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { compact } from "./vendor/fast-jev/compact.ts";
import { collectToolCalls } from "./vendor/fast-jev/state.ts";
import type {
	CompactResult,
	JevAsker,
	JevQuestions,
	JevResponse,
	JevState,
	Message,
	ToolCall,
	ToolUse,
} from "./vendor/fast-jev/types.ts";

export interface JevPruneSettings {
	/** Master switch; file `compactJev`, flag `--compact-jev off`. */
	enabled: boolean;
	/** Minimum keep probability for a call/result to stay (compactJevThreshold). */
	keepThreshold: number;
	/** Tail of the summarize list never touched (compactJevPreserve). */
	preserveRecentMessages: number;
	/** Characters of a dropped result to retain (compactJevHeadChars). */
	truncateHeadChars: number;
	/** Transport order (compactJevTransports). */
	transports: string[];
	/** Abort the whole Jev stage after this long (compactJevTimeoutMs). */
	timeoutMs: number;
}

export const DEFAULT_JEV: JevPruneSettings = {
	enabled: true,
	keepThreshold: 0.5,
	preserveRecentMessages: 3,
	truncateHeadChars: 300,
	transports: ["openrouter", "openlux", "typesafe"],
	timeoutMs: 60_000,
};

export interface JevPruneStats {
	transport: string;
	requests: number;
	calls: number;
	kept: number;
	resultsDropped: number;
	callsDropped: number;
	charsBefore: number;
	charsAfter: number;
	ms: number;
}

/** Items inside preparation.messagesToSummarize / turnPrefixMessages: OMP passes
 * normalized messages (`{role, content, …}`) directly, while raw transcript
 * entries wrap them as `{type:"message", message:…}` — accept both. */
interface EntryLike {
	type?: string;
	role?: string;
	content?: unknown;
	toolCallId?: string;
	isError?: boolean;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		isError?: boolean;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

type NormalizedMessage = { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; [key: string]: unknown };

/** The normalized message inside an entry wrapper, or the item itself when OMP passes bare messages. */
function msgOf(entry: EntryLike): NormalizedMessage | undefined {
	if (entry?.message && typeof entry.message === "object") return entry.message;
	return entry?.role !== undefined ? entry : undefined;
}

interface ContentBlock {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	[key: string]: unknown;
}

// ---------- transport ladder ----------

interface Transport {
	id: string;
	url: string;
	model: string;
	key: string;
}

function agentDir(): string {
	return process.env.OMP_AGENT_DIR ?? join(homedir(), ".omp", "agent");
}

function agentDbKey(provider: string): string | undefined {
	const dbPath = join(agentDir(), "agent.db");
	if (!existsSync(dbPath)) return undefined;
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const row = db
				.query("SELECT data FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY updated_at DESC LIMIT 1")
				.get(provider) as { data?: string } | null;
			if (!row?.data) return undefined;
			const parsed = JSON.parse(row.data) as Record<string, unknown>;
			const key = parsed.key ?? parsed.apiKey;
			return typeof key === "string" && key.length > 0 ? key : undefined;
		} finally {
			db.close();
		}
	} catch {
		return undefined;
	}
}

/** `!cat '/path'` / `!sed -n '/re/p' '/path'` directives in models.yml resolve to the file's first matching line. */
function modelsYmlKey(provider: string): { key?: string; baseUrl?: string } {
	const path = join(agentDir(), "models.yml");
	if (!existsSync(path)) return {};
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	const block = text.split("\n  ").find((chunk) => chunk.startsWith(`${provider}:`));
	if (!block) return {};
	const out: { key?: string; baseUrl?: string } = {};
	const urlMatch = block.match(/baseUrl:\s*(\S+)/);
	if (urlMatch) out.baseUrl = urlMatch[1];
	const catMatch = block.match(/apiKey:\s*"?!cat '?([^'"]+)'?"?/);
	if (catMatch) {
		try {
			out.key = readFileSync(catMatch[1], "utf8").trim().split("\n")[0]?.trim();
		} catch { /* unreadable */ }
	}
	const sedMatch = block.match(/apiKey:\s*"?!sed -n '?\/([^'"]+)\/p'? '?([^'"]+)'?"?/);
	if (!out.key && sedMatch) {
		try {
			out.key = readFileSync(sedMatch[2], "utf8")
				.split("\n")
				.find((line) => new RegExp(sedMatch[1]).test(line))
				?.trim();
		} catch { /* unreadable */ }
	}
	return out;
}

const TRANSPORT_DEFS: Record<string, () => Transport | undefined> = {
	openrouter: () => {
		const key = process.env.OPENROUTER_API_KEY ?? agentDbKey("openrouter");
		if (!key) return undefined;
		return { id: "openrouter", url: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13", key };
	},
	openlux: () => {
		const fromYml = modelsYmlKey("openlux");
		const key = process.env.OPENLUX_API_KEY ?? fromYml.key;
		if (!key) return undefined;
		const base = (fromYml.baseUrl ?? "https://api.openlux.ai/v1").replace(/\/$/, "");
		return { id: "openlux", url: `${base}/systemone`, model: "jev-1.13.0", key };
	},
	typesafe: () => {
		const key = process.env.TYPESAFE_API_KEY ?? agentDbKey("typesafe");
		if (!key) return undefined;
		return { id: "typesafe", url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", key };
	},
};

/** Ladder asker: the first working transport answers; on failure the next one takes over and stays active. */
function ladderAsker(transports: Transport[], onSwitch: (from: string, to: string, error: string) => void, onActive: (id: string) => void): JevAsker {
	let active = 0;
	return {
		async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
			let lastError: unknown;
			for (let i = active; i < transports.length; i++) {
				const t = transports[i]!;
				try {
					const res = await fetch(t.url, {
						method: "POST",
						headers: { authorization: `Bearer ${t.key}`, "content-type": "application/json" },
						body: JSON.stringify({ model: t.model, state, questions }),
						signal: AbortSignal.timeout(30_000),
					});
					const text = await res.text();
					if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 160)}`);
					const parsed = JSON.parse(text) as JevResponse;
					if (!parsed.answers || typeof parsed.answers !== "object") throw new Error("missing answers");
					active = i;
					onActive(t.id);
					return parsed;
				} catch (error) {
					lastError = error;
					if (i + 1 < transports.length) {
						onSwitch(t.id, transports[i + 1]!.id, error instanceof Error ? error.message : String(error));
					}
				}
			}
			throw lastError instanceof Error ? lastError : new Error(String(lastError));
		},
	};
}

// ---------- entry mapping ----------

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text!)
		.join("\n");
}

function mapEntries(owners: EntryLike[][]): Message[] {
	const messages: Message[] = [];
	for (const owner of owners) {
		for (const entry of owner) {
			const m = msgOf(entry);
			const role = m?.role;
			const content = Array.isArray(m?.content) ? (m!.content as ContentBlock[]) : [];
			if (role === "assistant") {
				const toolUses: ToolUse[] = [];
				let text = "";
				for (const c of content) {
					if (c?.type === "text" && typeof c.text === "string") text += (text ? "\n" : "") + c.text;
					else if (c?.type === "toolCall" && c.id) {
						toolUses.push({ tool_use_id: String(c.id), tool: String(c.name ?? "?"), input: c.arguments ?? {} });
					}
				}
				messages.push({ role: "assistant", text, toolUses });
			} else if (role === "toolResult") {
				messages.push({
					role: "user",
					text: "",
					toolUses: [],
					toolResults: [{ tool_use_id: String(m!.toolCallId ?? ""), text: textOf(content), isError: m!.isError === true }],
				});
			} else if (role === "user" || role === "developer") {
				messages.push({ role: "user", text: textOf(content), toolUses: [] });
			}
			// other entry shapes (custom/system) are not part of the summarize input.
		}
	}
	return messages;
}

// ---------- applying decisions back onto the entries ----------

function truncateResult(text: string, headChars: number): string {
	if (text.length <= headChars + 120) return text;
	const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
	return `${head}[self-compact jev-prune truncated ${text.length - headChars} chars of this tool result; re-run the tool if needed]`;
}

/** Rewrite one owner array in place (identity preserved: engines concat it later). */
function applyToOwner(owner: EntryLike[], dropCalls: ReadonlySet<string>, dropResults: ReadonlySet<string>, headChars: number): void {
	const kept: EntryLike[] = [];
	for (const entry of owner) {
		const m = msgOf(entry);
		const content = Array.isArray(m?.content) ? (m!.content as ContentBlock[]) : [];
		if (m?.role === "assistant") {
			const filtered = content.filter((c) => !(c?.type === "toolCall" && c.id && dropCalls.has(String(c.id))));
			if (filtered.length !== content.length) {
				const hasCall = filtered.some((c) => c?.type === "toolCall");
				const hasText = filtered.some((c) => c?.type === "text" && typeof c.text === "string" && c.text.trim().length > 0);
				if (!hasCall && !hasText) continue; // upstream parity: call-only messages disappear
				m.content = filtered;
			}
			kept.push(entry);
		} else if (m?.role === "toolResult") {
			const id = String(m.toolCallId ?? "");
			if (dropCalls.has(id)) continue; // dropped call takes its result with it
			if (dropResults.has(id)) {
				for (const c of content) {
					if (c?.type === "text" && typeof c.text === "string") c.text = truncateResult(c.text, headChars);
				}
			}
			kept.push(entry);
		} else {
			kept.push(entry);
		}
	}
	owner.length = 0;
	owner.push(...kept);
}

export interface JevPruneOutcome {
	pruned: boolean;
	reason?: string;
	stats?: JevPruneStats;
	switchNote?: string;
}

/**
 * Run Jev pruning over a preparation object in place. Returns the outcome for
 * logging; on any failure the preparation is untouched and `pruned` is false,
 * so the caller can let native compaction proceed unchanged.
 */
export async function jevPrunePreparation(
	preparation: { messagesToSummarize?: EntryLike[]; turnPrefixMessages?: EntryLike[] },
	settings: JevPruneSettings,
	onNote: (text: string) => void,
): Promise<JevPruneOutcome> {
	const owners = [preparation.messagesToSummarize ?? [], preparation.turnPrefixMessages ?? []];
	if (owners[0].length === 0 && owners[1].length === 0) return { pruned: false, reason: "nothing to prune" };

	const transports: Transport[] = [];
	for (const name of settings.transports) {
		const t = TRANSPORT_DEFS[name]?.();
		if (t) transports.push(t);
	}
	if (transports.length === 0) return { pruned: false, reason: "no Jev transport credentials (openrouter/openlux/typesafe)" };

	const messages = mapEntries(owners);
	const calls = collectToolCalls(messages, settings.preserveRecentMessages);
	const candidates = calls.filter((c) => !c.pinned);
	if (candidates.length === 0) return { pruned: false, reason: "no unpinned tool calls" };
	const callById = new Map<string, ToolCall>(calls.map((c) => [c.id, c]));

	let switchNote: string | undefined;
	let activeTransport = transports[0]!.id;
	const asker = ladderAsker(
		transports,
		(from, to, error) => {
			switchNote = `jev transport ${from} failed (${error.slice(0, 120)}), using ${to}`;
			onNote(switchNote);
		},
		(id) => {
			activeTransport = id;
		},
	);

	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error(`jev-prune timed out after ${settings.timeoutMs}ms`)), settings.timeoutMs),
	);
	let result: CompactResult;
	try {
		result = await Promise.race([
			compact(messages, asker, {
				keepThreshold: settings.keepThreshold,
				preserveRecentMessages: settings.preserveRecentMessages,
			}),
			timeout,
		]);
	} catch (error) {
		return { pruned: false, reason: `jev failed: ${error instanceof Error ? error.message : String(error)}` };
	}

	const dropCalls = new Set<string>();
	const dropResults = new Set<string>();
	for (const d of result.decisions) {
		const call = callById.get(d.id);
		if (!call) continue;
		if (d.action === "drop_call") dropCalls.add(call.tool_use_id);
		else if (d.action === "drop_result") dropResults.add(call.tool_use_id);
	}
	for (const owner of owners) applyToOwner(owner, dropCalls, dropResults, settings.truncateHeadChars);

	const charsAfter = owners.flat().reduce((sum, entry) => {
		const content = msgOf(entry)?.content;
		if (!Array.isArray(content)) return sum;
		return (
			sum +
			(content as ContentBlock[]).reduce(
				(s, b) => s + (typeof b?.text === "string" ? b.text.length : 0) + (b?.type === "toolCall" ? JSON.stringify(b.arguments ?? {}).length : 0),
				0,
			)
		);
	}, 0);

	return {
		pruned: true,
		switchNote,
		stats: {
			transport: activeTransport,
			requests: result.stats.requests,
			calls: result.stats.calls,
			kept: result.stats.kept,
			resultsDropped: result.stats.resultsDropped,
			callsDropped: result.stats.callsDropped,
			charsBefore: result.stats.charsBefore,
			charsAfter,
			ms: result.stats.ms,
		},
	};
}
