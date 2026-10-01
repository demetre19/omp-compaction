/**
 * The session's agent-dir chain.
 *
 * OMP resolves config (modelRoles, enabledModels, …) against the session's own
 * agent dir: `PI_CODING_AGENT_DIR` is set for every `omp --profile <name>` pane
 * (e.g. crew's prd-lane profile), an explicit `OMP_AGENT_DIR` export still
 * overrides for custom setups, and bare sessions fall back to ~/.omp/agent.
 * Extensions that read ~/.omp/agent directly resolve a DIFFERENT config than
 * the session they run inside — the compaction-role-scope defect: a lane under
 * --profile had its `compactDisabledRoles` resolved against the operator's
 * global modelRoles map while OMP had resolved its model from the profile's.
 *
 * Precedence is highest-first: profile → explicit override → global default.
 * Readers that merge (modelRoles) apply later entries over earlier ones;
 * readers that pick the first existing file (self-compact.json, prompts)
 * take entries in order.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Agent dirs in effect for this session, most specific first. */
export function agentDirs(): string[] {
	const dirs = [process.env.PI_CODING_AGENT_DIR, process.env.OMP_AGENT_DIR, join(homedir(), ".omp", "agent")]
		.filter((d): d is string => typeof d === "string" && d.trim() !== "");
	return dirs.filter((d, i) => dirs.indexOf(d) === i);
}

/** The dir that owns session config — where per-session settings are written. */
export function primaryAgentDir(): string {
	return agentDirs()[0]!;
}
