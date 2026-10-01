/**
 * Role-resolution tests: the lane-7 defect contract.
 *
 * compactDisabledRoles disables the model a role resolves to in the SESSION's
 * config stack — the same stack OMP itself resolves `--model pi/<role>` against.
 * OMP puts the session's agent dir in PI_CODING_AGENT_DIR (set under --profile);
 * OMP_AGENT_DIR is an operator-level override that still wins nothing over it.
 *
 * Acceptance arms from the defect report:
 *  - active model ≠ disabled role's model → compaction stays ON
 *  - active model == disabled role's model → compaction OFF
 * plus the profile case that motivated the report:
 *  - a profile config remapping the disabled role must win over the global map.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isModelDisabled, loadModelRoles, resolveDisabledModels } from "../roles.ts";

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_AGENT_DIR"] as const;
const savedEnv = new Map<string, string | undefined>();
for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);

afterEach(() => {
	for (const k of ENV_KEYS) {
		const v = savedEnv.get(k);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function writeConfig(dir: string, roles: Record<string, string>): void {
	mkdirSync(dir, { recursive: true });
	const lines = Object.entries(roles).map(([k, v]) => `  ${k}: ${v}`);
	writeFileSync(join(dir, "config.yml"), `modelRoles:\n${lines.join("\n")}\n`);
}

function agentDir(base: string): string {
	const dir = join(base, "agent");
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("compactDisabledRoles resolution", () => {
	test("global map: role resolves and disables only that model", () => {
		const home = mkdtempSync(join(tmpdir(), "sc-global-"));
		const agent = agentDir(home);
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.OMP_AGENT_DIR;
		// point "global" at the fixture via the legacy fallback is impossible
		// without homedir(); instead verify the env-var global slot directly.
		process.env.OMP_AGENT_DIR = agent;
		writeConfig(agent, { TOPDOG: "devin/claude-opus-5-5:high", default: "devin/swe-2:max" });

		const disabled = resolveDisabledModels(["TOPDOG"], [], home);
		expect(disabled.roles["TOPDOG"]).toBe("devin/claude-opus-5-5");

		// Arm 1: active model differs from the disabled role's model → not disabled.
		expect(isModelDisabled({ provider: "devin", id: "swe-2" }, disabled)).toBe(false);
		// Arm 2: active model IS the disabled role's model → disabled.
		expect(isModelDisabled({ provider: "devin", id: "claude-opus-5-5" }, disabled)).toBe(true);
	});

	test("PI_CODING_AGENT_DIR wins over the operator-global map", () => {
		const base = mkdtempSync(join(tmpdir(), "sc-profile-"));
		const profileAgent = agentDir(join(base, "profile"));
		const globalAgent = agentDir(join(base, "global"));
		writeConfig(profileAgent, { TOPDOG: "devin/swe-2:max", default: "devin/swe-2:max" });
		writeConfig(globalAgent, { TOPDOG: "devin/claude-opus-5-5:high", default: "devin/swe-2:max" });

		process.env.PI_CODING_AGENT_DIR = profileAgent;
		process.env.OMP_AGENT_DIR = globalAgent;

		// The session resolves TOP-DOG through its profile: swe-2. Disabling the
		// role must therefore disable swe-2 for THIS session — the operator-global
		// mapping (claude-opus-5-5) must not leak in.
		const resolved = loadModelRoles(base);
		expect(resolved.byRole["TOPDOG"]).toBe("devin/swe-2");

		const disabled = resolveDisabledModels(["TOPDOG"], [], base);
		expect(disabled.roles["TOPDOG"]).toBe("devin/swe-2");
		expect(isModelDisabled({ provider: "devin", id: "swe-2" }, disabled)).toBe(true);
		// A session on a different model stays enabled even under the profile.
		expect(isModelDisabled({ provider: "devin", id: "kimi-k3" }, disabled)).toBe(false);
	});

	test("roles present only in the global map still resolve under a profile", () => {
		const base = mkdtempSync(join(tmpdir(), "sc-overlay-"));
		const profileAgent = agentDir(join(base, "profile"));
		const globalAgent = agentDir(join(base, "global"));
		writeConfig(profileAgent, { TOPDOG: "devin/swe-2:max" });
		writeConfig(globalAgent, { IMPROVER: "devin/gpt-6-1-sol:high", TOPDOG: "devin/claude-opus-5-5:high" });

		process.env.PI_CODING_AGENT_DIR = profileAgent;
		process.env.OMP_AGENT_DIR = globalAgent;

		const resolved = loadModelRoles(base);
		// Profile shadow: TOPDOG from profile; IMPROVER falls through to global.
		expect(resolved.byRole["TOPDOG"]).toBe("devin/swe-2");
		expect(resolved.byRole["IMPROVER"]).toBe("devin/gpt-6-1-sol");
	});

	test("project .omp/config.yml outranks the profile map", () => {
		const base = mkdtempSync(join(tmpdir(), "sc-project-"));
		const project = join(base, "proj");
		const profileAgent = agentDir(join(base, "profile"));
		writeConfig(profileAgent, { TOPDOG: "devin/swe-2:max" });
		process.env.PI_CODING_AGENT_DIR = profileAgent;
		delete process.env.OMP_AGENT_DIR;
		writeConfig(join(project, ".omp"), { TOPDOG: "devin/kimi-k3:max" });

		const resolved = loadModelRoles(project);
		expect(resolved.byRole["TOPDOG"]).toBe("devin/kimi-k3");
	});
});
