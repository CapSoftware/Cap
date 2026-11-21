import { serverEnv } from "@cap/env";
import { gateway, type LanguageModel } from "ai";
import { z } from "zod";
import {
	type AiModelRole,
	getAiProviderChain,
	isAiConfigured,
} from "@/lib/ai/provider";

const configSchema = z
	.object({
		notesEnabled: z.boolean(),
		askEnabled: z.boolean(),
		transcriptionEnabled: z.boolean(),
		notesModels: z.array(z.string().min(1)).min(1).max(4),
		condenseModels: z.array(z.string().min(1)).min(1).max(4),
		askModels: z.array(z.string().min(1)).min(1).max(4),
		notesMaxOutputTokens: z.number().int().min(500).max(32_000),
		askMaxOutputTokens: z.number().int().min(200).max(8_000),
		promptVersion: z.string().min(1).max(32),
		notesSinglePassChars: z.number().int().min(20_000).max(400_000),
		reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high"]),
		trialMeetings: z.number().int().min(0).max(100),
	})
	.partial()
	.strip();

export type MeetingsAiConfig = Required<z.infer<typeof configSchema>>;

export const MEETINGS_AI_DEFAULTS: MeetingsAiConfig = {
	notesEnabled: true,
	askEnabled: true,
	transcriptionEnabled: true,
	notesModels: ["openai/gpt-6-luna"],
	condenseModels: ["openai/gpt-6-luna"],
	askModels: ["openai/gpt-6-luna"],
	notesMaxOutputTokens: 16_000,
	askMaxOutputTokens: 2_000,
	promptVersion: "v4",
	reasoningEffort: "none",
	notesSinglePassChars: 400_000,
	trialMeetings: 3,
};

const CACHE_MS = 30_000;
const EDGE_TIMEOUT_MS = 1_500;
const FIRST_READ_WAIT_MS = 500;
const EDGE_ITEM = "meetingsAi";

let cached: { config: MeetingsAiConfig; at: number } | null = null;
let lastEdge: Partial<MeetingsAiConfig> = {};
let refreshing: Promise<MeetingsAiConfig> | null = null;

function parseOverrides(
	raw: unknown,
	source: string,
): Partial<MeetingsAiConfig> {
	const parsed = configSchema.safeParse(raw);
	if (parsed.success) return parsed.data;
	console.warn(`[meetings-ai] ignoring invalid ${source} overrides`);
	return {};
}

function envOverrides(): Partial<MeetingsAiConfig> {
	const raw = serverEnv().MEETINGS_AI_CONFIG;
	if (!raw) return {};
	try {
		return parseOverrides(JSON.parse(raw), "MEETINGS_AI_CONFIG");
	} catch {
		console.warn("[meetings-ai] MEETINGS_AI_CONFIG is not JSON");
		return {};
	}
}

// The connection string is https://edge-config.vercel.com/<id>?token=<token>;
// its REST item endpoint avoids a dependency for one read every 30 s.
function edgeItemUrl(connection: string): string | null {
	try {
		const url = new URL(connection);
		const token = url.searchParams.get("token");
		const id = url.pathname.replace(/^\/+|\/+$/g, "");
		if (!token || !id) return null;
		return `${url.origin}/${id}/item/${EDGE_ITEM}?token=${encodeURIComponent(token)}`;
	} catch {
		return null;
	}
}

async function edgeOverrides(): Promise<Partial<MeetingsAiConfig>> {
	const connection = serverEnv().EDGE_CONFIG;
	if (!connection) return {};
	const url = edgeItemUrl(connection);
	if (!url) return {};
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(EDGE_TIMEOUT_MS),
			cache: "no-store",
		});
		if (response.status === 404) {
			lastEdge = {};
			return lastEdge;
		}
		if (!response.ok) return lastEdge;
		lastEdge = parseOverrides(await response.json(), "Edge Config");
		return lastEdge;
	} catch {
		return lastEdge;
	}
}

function refresh(now: number): Promise<MeetingsAiConfig> {
	refreshing ??= edgeOverrides()
		.then((edge) => {
			const config = { ...MEETINGS_AI_DEFAULTS, ...envOverrides(), ...edge };
			cached = { config, at: now };
			return config;
		})
		.finally(() => {
			refreshing = null;
		});
	return refreshing;
}

// Requests never wait on Edge Config once this instance has read it: a stale
// copy is served while one refresh runs in the background. Only a cold
// instance waits, briefly, before falling back to the env and defaults.
export async function getMeetingsAiConfig(
	now = Date.now(),
): Promise<MeetingsAiConfig> {
	if (cached) {
		if (now - cached.at >= CACHE_MS) void refresh(now).catch(() => undefined);
		return cached.config;
	}
	const fallback = { ...MEETINGS_AI_DEFAULTS, ...envOverrides() };
	const first = refresh(now).catch(() => fallback);
	const timeout = new Promise<MeetingsAiConfig>((resolve) =>
		setTimeout(() => resolve(fallback), FIRST_READ_WAIT_MS),
	);
	return Promise.race([first, timeout]);
}

export function resetMeetingsAiConfigCache() {
	cached = null;
	lastEdge = {};
	refreshing = null;
}

export type MeetingsAiTask = "notes" | "condense" | "ask";

export type MeetingModelSelection = {
	label: string;
	model: () => LanguageModel;
	maxOutputTokens: number;
	providerOptions?: Record<string, Record<string, string>>;
};

const FALLBACK_ROLE: Record<MeetingsAiTask, AiModelRole> = {
	notes: "chat-streaming",
	condense: "generation",
	ask: "chat-streaming",
};

// Vercel deployments reach the gateway with their OIDC token; elsewhere a key
// is needed. Self-hosted installs without either keep the provider chain.
export function gatewayAvailable(): boolean {
	const env = serverEnv();
	return Boolean(
		env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || env.VERCEL_ENV,
	);
}

export function meetingModelChain(
	config: MeetingsAiConfig,
	task: MeetingsAiTask,
): MeetingModelSelection[] {
	const maxOutputTokens =
		task === "notes"
			? config.notesMaxOutputTokens
			: task === "ask"
				? config.askMaxOutputTokens
				: Math.min(config.notesMaxOutputTokens, 4_000);
	if (gatewayAvailable()) {
		const models =
			task === "notes"
				? config.notesModels
				: task === "ask"
					? config.askModels
					: config.condenseModels;
		return models.map((id) => ({
			label: `gateway:${id}`,
			model: () => gateway(id),
			maxOutputTokens,
			providerOptions: id.startsWith("openai/")
				? { openai: { reasoningEffort: config.reasoningEffort } }
				: undefined,
		}));
	}
	return getAiProviderChain(FALLBACK_ROLE[task]).map((selection) => ({
		label: `${selection.provider}:${selection.modelId}`,
		model: () => selection.model(),
		maxOutputTokens,
	}));
}

export function meetingsAiConfigured(task: MeetingsAiTask): boolean {
	if (gatewayAvailable()) return true;
	return isAiConfigured(FALLBACK_ROLE[task]);
}

export class MeetingsAiUnavailableError extends Error {
	constructor(options?: { cause?: unknown }) {
		super("no meeting AI model succeeded", options);
		this.name = "MeetingsAiUnavailableError";
	}
}

// Tries each model in order. A failure after the caller says to stop (the
// request was aborted, or output already reached the client) is rethrown.
export async function runMeetingChain<T>(
	chain: MeetingModelSelection[],
	run: (selection: MeetingModelSelection) => Promise<T>,
	options: { stopOnError?: () => boolean } = {},
): Promise<T> {
	let lastError: unknown;
	for (const selection of chain) {
		try {
			return await run(selection);
		} catch (error) {
			lastError = error;
			console.error(`[meetings-ai] ${selection.label} failed`);
			if (options.stopOnError?.()) throw error;
		}
	}
	throw new MeetingsAiUnavailableError({ cause: lastError });
}
