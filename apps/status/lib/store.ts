import { Redis } from "@upstash/redis";
import { emptyState } from "./state";
import type { MonitorState } from "./types";

export const STATE_KEY = "cap:status:v1:state";
export const LOCK_KEY = "cap:status:v1:lock";

export function getRedis(): Redis {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) throw new Error("Status storage is not configured");
	return new Redis({
		url,
		token,
		retry: { retries: 1 },
		signal: () => AbortSignal.timeout(5_000),
	});
}

export async function readState(redis: Redis): Promise<MonitorState> {
	const state = await redis.get<MonitorState>(STATE_KEY);
	if (state && state.version !== 1)
		throw new Error("Unsupported status data version");
	return state ?? emptyState();
}

export const COMMIT_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[2], ARGV[2])
redis.call("DEL", KEYS[1])
return 1
`;

export const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`;
