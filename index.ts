/**
 * Session Namer — pi extension that auto-names chat sessions based on content.
 *
 * Triggers when session file exceeds a size threshold (default 10KB),
 * or synchronously with compaction/recap. Generates a concise name via LLM.
 *
 * Command: /session-namer [action] [args]
 *   - (no args)         Show current config and session name
 *   - rename             Force rename now
 *   - config <key> <val> Update a config parameter
 *   - on / off           Enable / disable auto-renaming
 *
 * Syncs with recap plugin: triggers naming on the same agent_end event.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation, buildSessionContext } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---

interface NamerConfig {
	enabled: boolean;
	sizeThreshold: number;
	maxLength: number;
	separator: string;
	autoRename: boolean;
	compactRename: "lazy" | "medium" | "always";
	minIntervalSec: number;
}

const CONFIG_FILE = "session-namer.json";
const ENTRY_TYPE = "session-namer-v1";

const DEFAULT_CONFIG: NamerConfig = {
	enabled: true,
	sizeThreshold: 10240,
	maxLength: 40,
	separator: " | ",
	autoRename: true,
	compactRename: "lazy",
	minIntervalSec: 300,
};

let configWarnings: string[] = [];

function loadConfig(): NamerConfig {
	const paths = [
		join(__dirname, "config.default.json"),
		join(process.env.HOME || "~", ".pi/agent", CONFIG_FILE),
	];
	if (process.cwd()) {
		paths.push(join(process.cwd(), ".pi", CONFIG_FILE));
	}
	let merged = { ...DEFAULT_CONFIG };
	configWarnings = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const raw = JSON.parse(readFileSync(p, "utf-8"));
			merged = { ...merged, ...raw };
		} catch (e: any) {
			configWarnings.push(`Failed to parse ${p}: ${e.message}`);
		}
	}
	return merged;
}

function saveGlobalConfig(patch: Partial<NamerConfig>): { saved: boolean; reason?: string } {
	const globalPath = join(process.env.HOME || "~", ".pi/agent", CONFIG_FILE);
	let existing: Partial<NamerConfig> = {};
	if (existsSync(globalPath)) {
		try {
			existing = JSON.parse(readFileSync(globalPath, "utf-8"));
		} catch (e: any) {
			const msg = `Failed to parse ${globalPath}: ${e.message}. Save aborted — fix or remove the file first.`;
			configWarnings.push(msg);
			return { saved: false, reason: msg };
		}
	}
	writeFileSync(globalPath, JSON.stringify({ ...existing, ...patch }, null, 2), "utf-8");
	return { saved: true };
}

// --- Prompt ---

let namerPromptCache: string | null = null;

function getNamerPrompt(): string {
	if (namerPromptCache) return namerPromptCache;
	namerPromptCache = readFileSync(join(__dirname, "prompts", "namer.md"), "utf-8");
	return namerPromptCache;
}

// --- Helpers ---

function byteLength(s: string): number {
	return Buffer.byteLength(s, "utf-8");
}

function getSessionFileSize(ctx: ExtensionContext): number | null {
	const file = ctx.sessionManager.getSessionFile();
	if (!file || !existsSync(file)) return null;
	try { return statSync(file).size; } catch { return null; }
}

function extractConversationText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	const { messages } = buildSessionContext(entries);
	return serializeConversation(convertToLlm(messages));
}

async function generateName(
	ctx: ExtensionContext,
	cfg: NamerConfig,
	signal?: AbortSignal,
): Promise<string | null> {
	const model = ctx.model;
	if (!model) return null;

	const auth = ctx.modelRegistry.getApiKeyAndHeaders(model);
	const convText = extractConversationText(ctx);

	const input = convText.length > 8000
		? convText.slice(0, 4000) + "\n...\n" + convText.slice(-4000)
		: convText;

	const systemPrompt = getNamerPrompt()
		.replace("{{maxLength}}", String(cfg.maxLength))
		.replace(/{{separator}}/g, cfg.separator);

	const response = await completeSimple(model, {
		systemPrompt,
		messages: [{
			role: "user" as const,
			content: input,
			timestamp: Date.now(),
		}],
	}, {
		apiKey: auth.apiKey,
		headers: auth.headers,
		maxTokens: 2000,
		reasoning: "low",
		signal,
	});

	const rawText = response.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("")
		.trim();

	// Strip thinking blocks (some models wrap output in <thinking> tags)
	const text = rawText
		.replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
		.replace(/<think[\s\S]*?<\/think>/g, "")
		.trim();

	if (!text) return null;

	if (byteLength(text) > cfg.maxLength) {
		let truncated = text;
		while (byteLength(truncated) > cfg.maxLength && truncated.length > 0) {
			truncated = truncated.slice(0, -1);
		}
		return truncated.trim();
	}
	return text;
}

// --- State persistence ---

interface NamerState {
	lastNamedSize: number;
	nameCount: number;
	lastRenameTime: number;
}

function persistState(pi: ExtensionAPI, state: NamerState) {
	pi.appendEntry(ENTRY_TYPE, state);
}

function restoreState(entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>): NamerState {
	let state: NamerState = { lastNamedSize: 0, nameCount: 0, lastRenameTime: 0 };
	for (const entry of entries) {
		if (entry.type === "custom" && (entry as any).customType === ENTRY_TYPE) {
			const data = (entry as any).data as NamerState;
			if (data) state = data;
		}
	}
	return state;
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
	let cfg = loadConfig();
	let state: NamerState = { lastNamedSize: 0, nameCount: 0, lastRenameTime: 0 };
	let isRenaming = false;

	async function doRename(ctx: ExtensionContext, reason: string, signal?: AbortSignal) {
		if (isRenaming) return;
		const now = Date.now();
		const elapsed = (now - state.lastRenameTime) / 1000;
		if (reason !== "manual" && elapsed < cfg.minIntervalSec) {
			return;
		}
		isRenaming = true;
		try {
			if (ctx.hasUI) ctx.ui.notify(`[session-namer] Generating name (${reason})...`, "info");

			const name = await generateName(ctx, cfg, signal);
			if (!name) {
				if (ctx.hasUI) ctx.ui.notify("[session-namer] LLM returned empty name, skipped. Try /session-namer rename again or /session-namer rename <name>.", "warning");
				return;
			}

			pi.setSessionName(name);
			const fileSize = getSessionFileSize(ctx) ?? 0;
			state.lastRenameTime = Date.now();
			state.lastNamedSize = fileSize;
			state.nameCount++;
			persistState(pi, state);

			if (ctx.hasUI) ctx.ui.notify(`[session-namer] Session named: ${name}`, "info");
		} catch (e: any) {
			if (ctx.hasUI) ctx.ui.notify(`[session-namer] Rename failed: ${e.message}`, "error");
		} finally {
			isRenaming = false;
		}
	}

	function checkAndRename(ctx: ExtensionContext, reason: string) {
		if (!cfg.enabled || !cfg.autoRename) return;
		const fileSize = getSessionFileSize(ctx);
		if (fileSize === null) return;
		if (fileSize < cfg.sizeThreshold) return;
		if (fileSize <= state.lastNamedSize) return;
		doRename(ctx, reason);
	}

	// Restore state on session start
	pi.on("session_start", (_event, ctx) => {
		cfg = loadConfig();
		state = restoreState(ctx.sessionManager.getEntries());
	});

	// Sync with recap: trigger on agent_end
	pi.on("agent_end", (_event, ctx) => {
		if (!cfg.enabled) return;
		const cr = cfg.compactRename;
		if (cr === "always") {
			doRename(ctx, "recap (always)");
		} else if (cr === "medium" || cr === "lazy") {
			if (state.nameCount === 0) doRename(ctx, "recap (first)");
		} else if (cfg.autoRename) {
			checkAndRename(ctx, "size threshold");
		}
	});

	// Sync with compact: trigger on session_before_compact
	pi.on("session_before_compact", (_event, ctx) => {
		if (!cfg.enabled) return;
		const cr = cfg.compactRename;
		if (cr === "always" || cr === "medium") {
			doRename(ctx, "compact");
		} else if (cr === "lazy" && state.nameCount === 0) {
			doRename(ctx, "compact (first)");
		}
	});

	// /session-namer command
	pi.registerCommand("session-namer", {
		description: "Session namer: rename [name] | on | off | config <key> <val> | status",
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/);
			const action = parts[0];

			function notifySave(r: { saved: boolean; reason?: string }, okMsg: string) {
				if (r.saved) {
					ctx.ui.notify(okMsg, "info");
				} else {
					ctx.ui.notify(`[session-namer] ⚠ ${r.reason}`, "error");
				}
			}

			if (!action || action === "status") {
				const currentName = pi.getSessionName();
				const fileSize = getSessionFileSize(ctx);
				let status =
					`[session-namer] Status:\n` +
					`  enabled: ${cfg.enabled}\n` +
					`  autoRename: ${cfg.autoRename}\n` +
					`  compactRename: ${cfg.compactRename}\n` +
					`  minIntervalSec: ${cfg.minIntervalSec}s\n` +
					`  sizeThreshold: ${cfg.sizeThreshold} bytes\n` +
					`  maxLength: ${cfg.maxLength} bytes\n` +
					`  separator: "${cfg.separator}"\n` +
					`  fileSize: ${fileSize ?? "unknown"} bytes\n` +
					`  lastNamedSize: ${state.lastNamedSize}\n` +
					`  nameCount: ${state.nameCount}\n` +
					`  currentName: ${currentName ?? "(none)"}`;
				if (configWarnings.length > 0) {
					status += `\n  ⚠ warnings:\n    ${configWarnings.join("\n    ")}`;
				}
				ctx.ui.notify(status, "info");
				return;
			}

			if (action === "rename") {
				const customName = parts.slice(1).join(" ").trim();
				if (customName) {
					pi.setSessionName(customName);
					cfg.enabled = false;
					cfg.autoRename = false;
					notifySave(saveGlobalConfig({ enabled: false, autoRename: false }), `[session-namer] Named: ${customName} (auto-rename off)`);
				} else {
					await doRename(ctx, "manual");
				}
				return;
			}

			if (action === "on") {
				cfg.enabled = true;
				cfg.autoRename = true;
				notifySave(saveGlobalConfig({ enabled: true, autoRename: true }), "[session-namer] Enabled.");
				return;
			}

			if (action === "off") {
				cfg.enabled = false;
				cfg.autoRename = false;
				notifySave(saveGlobalConfig({ enabled: false, autoRename: false }), "[session-namer] Disabled.");
				return;
			}

			if (action === "config") {
				const key = parts[1];
				const val = parts.slice(2).join(" ");
				if (!key || val === undefined) {
					ctx.ui.notify("[session-namer] Usage: /session-namer config <key> <value>", "warning");
					return;
				}
				const numKeys = new Set(["sizeThreshold", "maxLength"]);
				if (numKeys.has(key)) {
					const num = Number(val);
					if (isNaN(num) || num <= 0) {
						ctx.ui.notify(`[session-namer] ${key} must be a positive number.`, "error");
						return;
					}
					(cfg as any)[key] = num;
					notifySave(saveGlobalConfig({ [key]: num }), `[session-namer] ${key} = ${num}`);
				} else if (key === "minIntervalSec") {
					const num = Number(val);
					if (isNaN(num) || num < 0) {
						ctx.ui.notify(`[session-namer] minIntervalSec must be >= 0.`, "error");
						return;
					}
					cfg.minIntervalSec = num;
					notifySave(saveGlobalConfig({ minIntervalSec: num }), `[session-namer] minIntervalSec = ${num}`);
				} else if (key === "compactRename") {
					if (val !== "lazy" && val !== "medium" && val !== "always") {
						ctx.ui.notify(`[session-namer] compactRename must be one of: lazy, medium, always`, "error");
						return;
					}
					cfg.compactRename = val as any;
					notifySave(saveGlobalConfig({ compactRename: val }), `[session-namer] compactRename = ${val}`);
				} else if (key === "separator") {
					cfg.separator = val;
					notifySave(saveGlobalConfig({ separator: val }), `[session-namer] separator = "${val}"`);
				} else if (key === "enabled" || key === "autoRename") {
					const bool = val === "true" || val === "1";
					(cfg as any)[key] = bool;
					notifySave(saveGlobalConfig({ [key]: bool }), `[session-namer] ${key} = ${bool}`);
				} else {
					ctx.ui.notify(
						`[session-namer] Unknown config key: ${key}\n` +
						`Available: sizeThreshold, maxLength, minIntervalSec, separator, enabled, autoRename, compactRename`,
						"warning",
					);
				}
				return;
			}

			ctx.ui.notify(
				`[session-namer] Unknown action: ${action}\n` +
				`Usage: /session-namer [status | rename [name] | on | off | config <key> <val>]`,
				"warning",
			);
		},
	});
}
