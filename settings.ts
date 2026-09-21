/**
 * self-compact.json loading — the OMP-specific addition (upstream only had CLI flags).
 *
 * Lookup order (first file found wins, whole file):
 *   1. <cwd>/.omp/self-compact.json        (project)
 *   2. <cwd>/.pi/self-compact.json         (upstream-Pi layout, parity)
 *   3. ~/.omp/agent/self-compact.json      (user-global)
 *   4. ~/.pi/agent/self-compact.json       (upstream-Pi global, parity)
 *
 * Keys (all optional; CLI flags still win over file values):
 *   enabled               — master switch: false = extension fully hands-off
 *   compactSoftAt         — notice threshold: "10%", "100k", "270000"
 *   compactAt             — warning threshold: ask the agent to write its note and compact
 *   compactBuffer         — allowance above compactAt before other tools are blocked
 *   compactPrompt         — literal text replacing the compaction summary prompt
 *   compactDisabledRoles  — modelRoles names whose resolved model never self-compacts
 *   compactDisabledModels — "provider/model" or "provider/*" entries that never self-compact
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface FileSettings {
	enabled?: boolean;
	compactSoftAt?: string;
	compactAt?: string;
	compactBuffer?: string;
	compactPrompt?: string;
	compactDisabledRoles?: string[];
	compactDisabledModels?: string[];
}

export interface LoadedSettings {
	values: FileSettings;
	/** Absolute path of the file in effect, or undefined when none was found. */
	source?: string;
	/** Parse/type error — the extension goes inert rather than guess. */
	error?: string;
}

const FILE_NAME = "self-compact.json";

export function settingsSearchPaths(cwd: string): string[] {
	const agentDir = process.env.OMP_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	const paths = [
		resolve(cwd, ".omp", FILE_NAME),
		resolve(cwd, ".pi", FILE_NAME),
		join(agentDir, FILE_NAME),
		join(homedir(), ".pi", "agent", FILE_NAME),
	];
	return paths.filter((p, index) => paths.indexOf(p) === index);
}

type StringKey = "compactSoftAt" | "compactAt" | "compactBuffer" | "compactPrompt";
type BoolKey = "enabled";
type ListKey = "compactDisabledRoles" | "compactDisabledModels";

/** camelCase keys plus the dashed CLI spellings, so either style works in the file. */
const KEY_ALIASES: Record<string, StringKey | BoolKey | ListKey> = {
	enabled: "enabled",
	compactSoftAt: "compactSoftAt",
	"compact-soft-at": "compactSoftAt",
	compactAt: "compactAt",
	"compact-at": "compactAt",
	compactBuffer: "compactBuffer",
	"compact-buffer": "compactBuffer",
	compactPrompt: "compactPrompt",
	"compact-prompt": "compactPrompt",
	compactDisabledRoles: "compactDisabledRoles",
	"compact-disabled-roles": "compactDisabledRoles",
	compactDisabledModels: "compactDisabledModels",
	"compact-disabled-models": "compactDisabledModels",
};

const BOOL_KEYS: Record<string, BoolKey> = { enabled: "enabled" };
const LIST_KEYS: Record<string, ListKey> = {
	compactDisabledRoles: "compactDisabledRoles",
	compactDisabledModels: "compactDisabledModels",
};

export function loadSettingsFile(cwd: string): LoadedSettings {
	for (const path of settingsSearchPaths(cwd)) {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return { values: {}, source: path, error: `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			return { values: {}, source: path, error: `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { values: {}, source: path, error: `${path} must contain a JSON object.` };
		}
		const values: FileSettings = {};
		for (const [key, value] of Object.entries(parsed)) {
			const canonical = KEY_ALIASES[key];
			if (!canonical) continue; // comments/unknown keys are ignored
			if (canonical in BOOL_KEYS) {
				if (typeof value !== "boolean") {
					return { values: {}, source: path, error: `${path}: "${key}" must be a boolean, got ${typeof value}.` };
				}
				values[canonical as BoolKey] = value;
			} else if (canonical in LIST_KEYS) {
				if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
					return { values: {}, source: path, error: `${path}: "${key}" must be an array of strings.` };
				}
				values[canonical as ListKey] = value as string[];
			} else {
				if (typeof value !== "string") {
					return { values: {}, source: path, error: `${path}: "${key}" must be a string, got ${typeof value}.` };
				}
				values[canonical as StringKey] = value;
			}
		}
		return { values, source: path };
	}
	return { values: {} };
}

/**
 * Merge `patch` into the settings file at `path` (created when missing) and write it back.
 * `undefined` leaves a key untouched; `null` deletes it. Unknown keys (comments) survive.
 * Returns an error string instead of throwing so menus can show it inline.
 */
export function writeSettingsFile(path: string, patch: Partial<Record<keyof FileSettings, unknown>>): string | undefined {
	let existing: Record<string, unknown> = {};
	try {
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		if (value === null) delete existing[key];
		else existing[key] = value;
	}
	try {
		writeFileSync(path, `${JSON.stringify(existing, null, "\t")}\n`);
	} catch (error) {
		return `Cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
	return undefined;
}

/** Where the settings menu writes: the file already in effect, else the user-global path. */
export function settingsWritePath(cwd: string, currentSource?: string): string {
	if (currentSource) return currentSource;
	const agentDir = process.env.OMP_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	return join(agentDir, FILE_NAME);
}
