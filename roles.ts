/**
 * Role → model resolution for the compactDisabledRoles setting.
 *
 * OMP's extension API exposes only the resolved `ctx.model` ({provider, id}); the role that
 * produced it lives in `modelRoles` in ~/.omp/agent/config.yml (and optionally a project
 * .omp/config.yml). This module parses just that one flat mapping — a full YAML dependency
 * cannot be assumed inside the extension sandbox — and turns a list of disabled role names
 * into the set of "provider/model" keys they resolve to.
 *
 * config.yml shape handled:
 *   modelRoles:
 *     default: devin/swe-2:max        # role: provider/model[:effort]
 *     TOP-DOG: devin/claude-fable-5-1:low
 *   enabledModels:                    # next top-level key ends the block
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

/** config.yml locations, project first (project values win on duplicate role names). */
export function configSearchPaths(cwd: string): string[] {
	const agentDir = process.env.OMP_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	return [resolve(cwd, ".omp", "config.yml"), join(agentDir, "config.yml")];
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

/** Read every config.yml in search order and merge modelRoles (project wins). */
export function loadModelRoles(cwd: string): ResolvedRoles {
	const byRole: Record<string, string> = {};
	const sources: string[] = [];
	// Later paths are lower precedence, so read global first and let project overwrite.
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

export interface DisabledModels {
	/** "provider/model" keys that must never be self-compacted. */
	keys: Record<string, true>;
	/** Disabled role names that resolved to a model (for display). */
	roles: Record<string, string>;
	/** Disabled role names that matched nothing in modelRoles (for display/warnings). */
	unknownRoles: string[];
	/** Disabled model specs that needed no role lookup. */
	direct: string[];
}

/**
 * Combine compactDisabledRoles (resolved through modelRoles) and compactDisabledModels
 * (matched directly, `provider/*` wildcard allowed) into one lookup set.
 */
export function resolveDisabledModels(
	disabledRoles: string[],
	disabledModels: string[],
	cwd: string,
): DisabledModels {
	const keys: Record<string, true> = {};
	const roles: Record<string, string> = {};
	const unknownRoles: string[] = [];
	const direct: string[] = [];

	const resolved = disabledRoles.length > 0 ? loadModelRoles(cwd) : undefined;
	for (const role of disabledRoles) {
		const key = resolved?.byRole[role];
		if (key) {
			keys[key] = true;
			roles[role] = key;
		} else {
			unknownRoles.push(role);
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
	return { keys, roles, unknownRoles, direct };
}

/** True when the session's current model is covered by the disabled set. */
export function isModelDisabled(model: { provider?: string; id?: string } | undefined, disabled: DisabledModels): boolean {
	const key = modelKey(model);
	if (!key) return false;
	if (disabled.keys[key]) return true;
	const provider = model!.provider!;
	return disabled.keys[`${provider}/*`] === true;
}
