/**
 * Role-selection tests: the compact-role-match defect contract.
 *
 * compactDisabledRoles must disable only sessions that SELECTED the role — via the
 * launch `--model` spec (`pi/<role>`, `@<role>`, or a bare modelRoles name) or a
 * stamped `model_change.role` (role cycling, `/model`, spawned sessions). A session
 * whose resolved model merely equals the disabled role's model stays live — the
 * operator's `default` and `TOP-DOG` both point at devin/swe-2, so model-key matching
 * disabled self-compact fleet-wide.
 *
 * OMP puts the session's agent dir in PI_CODING_AGENT_DIR (set under --profile);
 * OMP_AGENT_DIR is an operator-level override that still wins nothing over it.
 * modelRoles is still read for display and to recognize bare role names in specs.
 *
 * Acceptance arms from the defect report:
 *  - default-launched session on the disabled role's model → compaction stays ON
 *  - session launched `--model pi/<role>` (or stamped into the role) → OFF
 *  - a role absent from modelRoles contributes no model — and can't be selected
 *    by spec — so it disables nothing it wasn't actually launched under.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	isModelDisabled,
	launchModelSpec,
	loadModelRoles,
	resolveDisabledModels,
	roleFromModelSpec,
	sessionRole,
	type SessionEntryLike,
} from "../roles.ts";

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
	test("global map: role is known, its model is not disabled", () => {
		const home = mkdtempSync(join(tmpdir(), "sc-global-"));
		const agent = agentDir(home);
		delete process.env.PI_CODING_AGENT_DIR;
		// point "global" at the fixture via the env-var slot (homedir fallback is untestable).
		process.env.OMP_AGENT_DIR = agent;
		writeConfig(agent, { TOPDOG: "devin/claude-opus-5-5:high", default: "devin/swe-2:max" });

		const disabled = resolveDisabledModels(["TOPDOG"], [], home);
		expect(disabled.roles["TOPDOG"]).toBe("devin/claude-opus-5-5");
		expect(disabled.roleNames.has("TOPDOG")).toBe(true);
		expect(disabled.knownRoles.has("TOPDOG")).toBe(true);

		// Roles never disable a model key — even the role's own resolved model.
		expect(isModelDisabled({ provider: "devin", id: "claude-opus-5-5" }, disabled)).toBe(false);
		expect(isModelDisabled({ provider: "devin", id: "swe-2" }, disabled)).toBe(false);
	});

	test("PI_CODING_AGENT_DIR wins over the operator-global map", () => {
		const base = mkdtempSync(join(tmpdir(), "sc-profile-"));
		const profileAgent = agentDir(join(base, "profile"));
		const globalAgent = agentDir(join(base, "global"));
		writeConfig(profileAgent, { TOPDOG: "devin/swe-2:max", default: "devin/swe-2:max" });
		writeConfig(globalAgent, { TOPDOG: "devin/claude-opus-5-5:high", default: "devin/swe-2:max" });

		process.env.PI_CODING_AGENT_DIR = profileAgent;
		process.env.OMP_AGENT_DIR = globalAgent;

		// The session resolves TOP-DOG through its profile: swe-2. Display and
		// bare-name spec recognition must use the same stack — not the global map.
		const resolved = loadModelRoles(base);
		expect(resolved.byRole["TOPDOG"]).toBe("devin/swe-2");

		const disabled = resolveDisabledModels(["TOPDOG"], [], base);
		expect(disabled.roles["TOPDOG"]).toBe("devin/swe-2");
		expect(isModelDisabled({ provider: "devin", id: "swe-2" }, disabled)).toBe(false);
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

describe("roleFromModelSpec", () => {
	const known = new Set(["TOPDOG", "SUMMARISER", "task"]);

	test("prefixed and bare selectors resolve", () => {
		expect(roleFromModelSpec("pi/TOPDOG", known)).toBe("TOPDOG");
		expect(roleFromModelSpec("@TOPDOG", known)).toBe("TOPDOG");
		expect(roleFromModelSpec("TOPDOG", known)).toBe("TOPDOG");
		expect(roleFromModelSpec("pi/SUMMARISER:max", known)).toBe("SUMMARISER");
		expect(roleFromModelSpec("*", known)).toBe("default");
		expect(roleFromModelSpec("@task", known)).toBe("task");
	});

	test("plain model specs resolve to no role", () => {
		expect(roleFromModelSpec("devin/swe-2", known)).toBe(undefined);
		expect(roleFromModelSpec("devin/swe-2:max", known)).toBe(undefined);
		expect(roleFromModelSpec("openrouter/google/gemini-2.5-pro", known)).toBe(undefined);
		expect(roleFromModelSpec(undefined, known)).toBe(undefined);
	});

	test("prefixed names absent from modelRoles resolve to no role", () => {
		// OMP could not have selected a role from `pi/GONE`; nothing to disable.
		expect(roleFromModelSpec("pi/GONE", known)).toBe(undefined);
		expect(roleFromModelSpec("@GONE", known)).toBe(undefined);
	});
});

describe("launchModelSpec", () => {
	test("finds --model in argv, last wins, -- ends flag parsing", () => {
		expect(launchModelSpec(["omp", "--model", "pi/TOPDOG", "prompt"])).toBe("pi/TOPDOG");
		expect(launchModelSpec(["omp", "--model=pi/TOPDOG"])).toBe("pi/TOPDOG");
		expect(launchModelSpec(["omp", "-m", "pi/TOPDOG"])).toBe("pi/TOPDOG");
		expect(launchModelSpec(["omp", "--model", "a/b", "--model", "pi/TOPDOG"])).toBe("pi/TOPDOG");
		expect(launchModelSpec(["omp", "prompt", "--", "--model", "pi/TOPDOG"])).toBe(undefined);
		expect(launchModelSpec(["omp", "--models", "pi/TOPDOG"])).toBe(undefined);
		expect(launchModelSpec(["omp", "chat"])).toBe(undefined);
		expect(launchModelSpec(undefined)).toBe(undefined);
	});
});

function branchWith(...entries: SessionEntryLike[]): { getBranch(): SessionEntryLike[] } {
	return { getBranch: () => entries };
}

describe("sessionRole", () => {
	const known = new Set(["TOPDOG", "SUMMARISER", "task", "default"]);

	test("no session records: the launch spec decides", () => {
		expect(sessionRole(branchWith(), { knownRoles: known }, "pi/TOPDOG")).toBe("TOPDOG");
		expect(sessionRole(branchWith(), { knownRoles: known }, "devin/swe-2:max")).toBe("default");
		expect(sessionRole(branchWith(), { knownRoles: known }, undefined)).toBe("default");
	});

	test("role-less ROOT model_change is the launch record: launch spec decides", () => {
		// Bootstrap writes model_change without a role even for --model pi/<role>.
		const root = branchWith({ type: "model_change", parentId: null });
		expect(sessionRole(root, { knownRoles: known }, "pi/TOPDOG")).toBe("TOPDOG");
		expect(sessionRole(root, { knownRoles: known }, "devin/swe-2")).toBe("default");
	});

	test("a stamped model_change wins over the launch spec", () => {
		const entries = branchWith(
			{ type: "model_change", parentId: null },
			{ type: "model_change", parentId: "a", role: "TOPDOG" },
		);
		expect(sessionRole(entries, { knownRoles: known }, "devin/swe-2")).toBe("TOPDOG");
	});

	test("a stamped model_change survives an older unroled launch", () => {
		const entries = branchWith(
			{ type: "model_change", parentId: null },
			{ type: "model_change", parentId: "a", role: "smol" },
		);
		expect(sessionRole(entries, { knownRoles: known }, "pi/TOPDOG")).toBe("smol");
	});

	test("a non-root unroled model_change clears the role to default", () => {
		// Ctrl+P cycling / session-init model writes stamp no role: getLastModelChangeRole
		// treats them as "default", and they must override the launch spec.
		const entries = branchWith(
			{ type: "model_change", parentId: null },
			{ type: "model_change", parentId: "a" },
		);
		expect(sessionRole(entries, { knownRoles: known }, "pi/TOPDOG")).toBe("default");
	});

	test("session_init.modelRole covers spawned sessions", () => {
		const entries = branchWith(
			{ type: "session_init", parentId: null, modelRole: "TOPDOG" },
			{ type: "model_change", parentId: null },
		);
		expect(sessionRole(entries, { knownRoles: known }, undefined)).toBe("TOPDOG");
	});

	test("undefined/absent session manager falls back to the launch spec", () => {
		expect(sessionRole(undefined, { knownRoles: known }, "pi/TOPDOG")).toBe("TOPDOG");
		expect(sessionRole(undefined, { knownRoles: known }, undefined)).toBe("default");
	});
});

describe("role-disabled matching (the reported defect)", () => {
	test("default-launched session on the disabled role's model stays enabled", () => {
		// defect: default and TOPDOG both resolve to devin/swe-2 — model-key matching
		// disabled every session. Selector matching keeps default launches live.
		const base = mkdtempSync(join(tmpdir(), "sc-defect-"));
		const agent = agentDir(base);
		process.env.PI_CODING_AGENT_DIR = agent;
		delete process.env.OMP_AGENT_DIR;
		writeConfig(agent, { default: "devin/swe-2:max", TOPDOG: "devin/swe-2:max" });

		const disabled = resolveDisabledModels(["TOPDOG"], [], base);
		// Role-less root = default launch; the model is the disabled role's model,
		// but the session never selected TOPDOG → not disabled.
		const role = sessionRole(branchWith({ type: "model_change", parentId: null }), disabled, "devin/swe-2");
		expect(disabled.roleNames.has(role)).toBe(false);
	});

	test("session launched under the disabled role is disabled", () => {
		const base = mkdtempSync(join(tmpdir(), "sc-defect2-"));
		const agent = agentDir(base);
		process.env.PI_CODING_AGENT_DIR = agent;
		delete process.env.OMP_AGENT_DIR;
		writeConfig(agent, { default: "devin/swe-2:max", TOPDOG: "devin/swe-2:max" });

		const disabled = resolveDisabledModels(["TOPDOG"], [], base);
		const role = sessionRole(branchWith({ type: "model_change", parentId: null }), disabled, "pi/TOPDOG");
		expect(role).toBe("TOPDOG");
		expect(disabled.roleNames.has(role)).toBe(true);
	});

	test("a role absent from modelRoles cannot be spec-selected and disables nothing", () => {
		const base = mkdtempSync(join(tmpdir(), "sc-gone-"));
		const agent = agentDir(base);
		process.env.PI_CODING_AGENT_DIR = agent;
		delete process.env.OMP_AGENT_DIR;
		writeConfig(agent, { default: "devin/swe-2:max" }); // TOPDOG removed

		const disabled = resolveDisabledModels(["TOPDOG"], [], base);
		expect(disabled.roleNames.has("TOPDOG")).toBe(true);
		expect(disabled.unknownRoles).toEqual(["TOPDOG"]);
		expect(disabled.keys["devin/swe-2"]).toBeUndefined();

		// --model pi/TOPDOG on a removed role resolves no role → session default → not disabled.
		const role = sessionRole(branchWith({ type: "model_change", parentId: null }), disabled, "pi/TOPDOG");
		expect(role).toBe("default");
		expect(disabled.roleNames.has(role)).toBe(false);
	});

	test("a stamped disabled role still disables after the role leaves modelRoles", () => {
		// The session genuinely selected the role while it existed; the stamp survives
		// the role's removal from the map (name matching, not model resolution).
		const base = mkdtempSync(join(tmpdir(), "sc-gone2-"));
		const agent = agentDir(base);
		process.env.PI_CODING_AGENT_DIR = agent;
		delete process.env.OMP_AGENT_DIR;
		writeConfig(agent, { default: "devin/swe-2:max" });

		const disabled = resolveDisabledModels(["TOPDOG"], [], base);
		const role = sessionRole(
			branchWith(
				{ type: "model_change", parentId: null },
				{ type: "model_change", parentId: "a", role: "TOPDOG" },
			),
			disabled,
			"devin/swe-2",
		);
		expect(disabled.roleNames.has(role)).toBe(true);
	});
});
