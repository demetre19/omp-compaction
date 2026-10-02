/**
 * Role matching for the compactDisabledRoles setting.
 *
 * OMP's extension API exposes only the resolved `ctx.model` ({provider, id}) — never
 * the selector that produced it. Disabling a role's resolved MODEL is wrong: when a
 * role and `default` point at the same model (the operator's cost-control config has
 * every slot on devin/swe-2), every session inherits that key and self-compact would
 * go hands-off everywhere. compactDisabledRoles must match the ROLE SELECTED for the
 * session, not the model it resolved to.
 *
 * Where the session's role lives (observed in the @oh-my-pi runtime):
 *  - `model_change` session entries carry `role` when the model was chosen through a
 *    role (`--model @<role>`/`pi/<role>`/bare role launches that stamp it, role cycling,
 *    `/model` — which writes `"default"`). `getLastModelChangeRole()` treats an
 *    unroled change as `"default"`; this module mirrors that, with one carve-out: the
 *    branch's ROOT model_change is the launch record and is written without a role even
 *    for `--model pi/<role>` launches, so for a role-less root the launch `--model`
 *    spec from process.argv is consulted instead.
 *  - `session_init` entries carry `modelRole` (subagent spawns record it there).
 *  - `process.argv`: the session's launch `--model`/`-m` spec. Role selectors are
 *    `@<role>`, `pi/<role>`, or a bare name present in modelRoles/builtin roles;
 *    `provider/model` specs are direct model selections and carry no role. `*` maps
 *    to "default" (OMP's default-resolution alias).
 *
 * Role names match compactDisabledRoles by NAME — a session launched under a role that
 * was later removed from modelRoles still disables (the selection did happen); a spec
 * that fails to resolve to a role names nothing and disables nothing.
 *
 * `modelRoles` is still read (config.yml chain: project `.omp/config.yml` first, then
 * the session's agent dirs — PI_CODING_AGENT_DIR under --profile → OMP_AGENT_DIR →
 * ~/.omp/agent, see agent-dir.ts) to recognize bare role names in launch specs and for
 * menu/info display of role → model.
 *
 * config.yml shape handled:
 *   modelRoles:
 *     default: devin/swe-2:max        # role: provider/model[:effort]
 *     TOP-DOG: devin/claude-fable-5-1:low
 *   enabledModels:                    # next top-level key ends the block
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentDirs } from "./agent-dir.ts";

/** Strip a trailing :effort suffix (low/medium/high/xhigh/max/…) — effort is not part of the model identity. */
const EFFORT_SUFFIX = /:(?:min|low|medium|high|xhigh|max|none)$/i;

/** Normalize a "provider/model[:effort]" spec to the "provider/model" key ctx.model produces. */
export function modelKeyOf(spec: string): string {
	return spec.trim().replace(EFFORT_SUFFIX, "");
}

export function modelKey(model: { provider?: string; id?: string } | undefined): string | undefined {
	if (!model?.provider || !model.id) return undefined;
	return `${model.provider}/${model.id}`;
}

/** config.yml locations, highest precedence first: the session's project dir, then its agent dirs. */
export function configSearchPaths(cwd: string): string[] {
	return [resolve(cwd, ".omp", "config.yml"), ...agentDirs().map((dir) => join(dir, "config.yml"))];
}

/**
 * Extract the flat `modelRoles:` mapping from a config.yml text.
 * Returns role → raw model spec. Unknown/malformed lines are skipped, never fatal.
 */
export function parseModelRoles(yaml: string): Record<string, string> {
	const roles: Record<string, string> = {};
	let inBlock = false;
	for (const line of yaml.split("\n")) {
		if (!inBlock) {
			if (/^modelRoles:\s*(?:#.*)?$/.test(line)) inBlock = true;
			continue;
		}
		// The block ends at the first non-indented, non-empty line.
		if (line.trim() !== "" && !/^\s/.test(line)) break;
		const m = /^\s+([^\s:#]+):\s*(.+?)\s*(?:#.*)?$/.exec(line);
		if (!m) continue;
		const value = m[2]!.replace(/^["']|["']$/g, "");
		if (value) roles[m[1]!] = value;
	}
	return roles;
}

export interface ResolvedRoles {
	/** role name → "provider/model" key (effort stripped). */
	byRole: Record<string, string>;
	/** Every "provider/model" key any role maps to. */
	models: Record<string, true>;
	/** config.yml files that were read. */
	sources: string[];
}

/** Read every config.yml in search order and merge modelRoles (earlier paths — project, then profile — win). */
export function loadModelRoles(cwd: string): ResolvedRoles {
	const byRole: Record<string, string> = {};
	const sources: string[] = [];
	// Paths are highest-precedence first, so read the chain in reverse: each
	// earlier entry then overwrites whatever the less specific dirs set.
	const paths = configSearchPaths(cwd);
	for (let i = paths.length - 1; i >= 0; i--) {
		const path = paths[i]!;
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		sources.push(path);
		for (const [role, spec] of Object.entries(parseModelRoles(text))) {
			byRole[role] = modelKeyOf(spec);
		}
	}
	const models: Record<string, true> = {};
	for (const key of Object.values(byRole)) models[key] = true;
	return { byRole, models, sources };
}

/** OMP's builtin modelRole names (the resolver accepts these even when modelRoles omits them). */
const BUILTIN_ROLES: readonly string[] = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"memory",
	"task",
	"advisor",
	"image",
	"web",
	"speech",
	"dictation",
	"judge",
];

/** Role selector prefixes accepted by OMP's model-spec grammar. */
const ROLE_PREFIXES = ["pi/", "@"] as const;

export interface DisabledModels {
	/** Role names that must never self-compact — matched against the session's selected role. */
	roleNames: Set<string>;
	/** "provider/model" keys that must never be self-compacted (compactDisabledModels only). */
	keys: Record<string, true>;
	/** Disabled role names that resolve to a model in modelRoles (for display). */
	roles: Record<string, string>;
	/** Disabled role names absent from modelRoles (display/warnings; still valid session-role names). */
	unknownRoles: string[];
	/** Role names the launch `--model` spec may name bare (modelRoles keys + builtins). */
	knownRoles: Set<string>;
	/** Disabled model specs that needed no role lookup. */
	direct: string[];
}

/**
 * Combine compactDisabledRoles (matched by role NAME against the session's selected
 * role) and compactDisabledModels (matched by resolved model key, `provider/*`
 * wildcard allowed) into one lookup set.
 */
export function resolveDisabledModels(
	disabledRoles: string[],
	disabledModels: string[],
	cwd: string,
): DisabledModels {
	const roleNames = new Set<string>();
	const keys: Record<string, true> = {};
	const roles: Record<string, string> = {};
	const unknownRoles: string[] = [];
	const direct: string[] = [];

	const resolved = disabledRoles.length > 0 ? loadModelRoles(cwd) : undefined;
	const knownRoles = new Set<string>([...BUILTIN_ROLES, ...Object.keys(resolved?.byRole ?? {})]);
	for (const role of disabledRoles) {
		const name = role.trim();
		if (!name) continue;
		roleNames.add(name);
		const key = resolved?.byRole[name];
		if (key) {
			roles[name] = key;
		} else {
			unknownRoles.push(name);
		}
	}
	for (const spec of disabledModels) {
		const key = spec.trim();
		if (!key) continue;
		// Wildcards stay as patterns; concrete specs normalize like role targets.
		const normalized = key.endsWith("/*") ? key : modelKeyOf(key);
		keys[normalized] = true;
		direct.push(normalized);
	}
	return { roleNames, keys, roles, unknownRoles, knownRoles, direct };
}

/** True when the session's current model is covered by the disabled set. */
export function isModelDisabled(model: { provider?: string; id?: string } | undefined, disabled: DisabledModels): boolean {
	const key = modelKey(model);
	if (!key) return false;
	if (disabled.keys[key]) return true;
	const provider = model!.provider!;
	return disabled.keys[`${provider}/*`] === true;
}

/**
 * The role a `--model` spec selects, or undefined for plain model specs.
 * Accepts `@<role>`/`pi/<role>` prefixes and bare role names present in
 * `knownRoles` (modelRoles keys + builtins); `*` resolves like OMP's "default".
 * An optional :effort suffix is stripped. Prefixed names not in `knownRoles`
 * resolve to nothing — OMP could not have selected a role from that spec.
 */
export function roleFromModelSpec(spec: string | undefined, knownRoles: ReadonlySet<string>): string | undefined {
	if (!spec) return undefined;
	let s = spec.trim();
	if (!s) return undefined;
	if (s === "*") return "default";
	for (const prefix of ROLE_PREFIXES) {
		if (s.startsWith(prefix)) {
			s = s.slice(prefix.length);
			break;
		}
	}
	const role = modelKeyOf(s);
	return knownRoles.has(role) ? role : undefined;
}

/** Extract the launch `--model` spec from an argv vector (supports `--model v`, `--model=v`, `-m v`; last wins). */
export function launchModelSpec(argv: readonly string[] | undefined): string | undefined {
	if (!argv) return undefined;
	let spec: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") break;
		if (arg === "--model" || arg === "-m") {
			if (i + 1 < argv.length && argv[i + 1] !== "--") spec = argv[++i];
		} else if (arg.startsWith("--model=")) {
			spec = arg.slice("--model=".length);
		}
	}
	return spec;
}

/** The shape of session entries this module reads (the fork stamps `role`/`modelRole` beyond the public types). */
export interface SessionEntryLike {
	type: string;
	parentId?: string | null;
	role?: string;
	modelRole?: string;
}

interface SessionBranchReader {
	getBranch(fromId?: string): unknown[];
}

/**
 * The role the session's model was selected under.
 *
 * Reads the session branch (ctx.sessionManager.getBranch()) newest-first:
 *  - the last `model_change` entry's `role` wins (role cycling, `/model`, spawned
 *    sessions stamp it); an unroled NON-root change cleared the role → "default"
 *    (OMP's getLastModelChangeRole normalizes the same way);
 *  - an unroled ROOT model_change is the launch record — the runtime never stamps
 *    a role there, so the launch `--model` spec from `launchSpec` decides;
 *  - `session_init.modelRole` covers spawned sessions whose only record is the
 *    init entry;
 *  - with no records at all, `launchSpec` applies (fresh print-mode sessions).
 * Returns "default" when nothing identifies a role.
 */
export function sessionRole(
	sessionManager: SessionBranchReader | undefined,
	disabled: Pick<DisabledModels, "knownRoles">,
	launchSpec?: string,
): string {
	const launchRole = roleFromModelSpec(launchSpec, disabled.knownRoles);
	let initRole: string | undefined;
	let entries: unknown[] = [];
	try {
		entries = sessionManager?.getBranch() ?? [];
	} catch {
		entries = [];
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e || typeof e !== "object") continue;
		const entry = e as SessionEntryLike;
		if (entry.type === "session_init") {
			if (!initRole && typeof entry.modelRole === "string" && entry.modelRole) initRole = entry.modelRole;
			continue;
		}
		if (entry.type !== "model_change") continue;
		if (typeof entry.role === "string" && entry.role) return entry.role;
		if (entry.parentId !== null && entry.parentId !== undefined) return "default"; // mid-session unroled change: cleared
		// Role-less ROOT model_change — the launch record; keep scanning for session_init.
	}
	return initRole ?? launchRole ?? "default";
}
