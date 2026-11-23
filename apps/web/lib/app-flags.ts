import { db } from "@cap/database";
import { appFlags } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export interface AppFlagSource {
	read(key: string): Promise<unknown>;
}

export const databaseAppFlagSource: AppFlagSource = {
	async read(key) {
		const [row] = await db()
			.select({ value: appFlags.value })
			.from(appFlags)
			.where(eq(appFlags.key, key))
			.limit(1);
		return row?.value ?? null;
	},
};

export const APP_FLAG_CACHE_MS = 15_000;

type CachedFlag = { value: unknown; readAt: number };

export function createAppFlagReader(
	source: AppFlagSource,
	options: { cacheMs?: number; now?: () => number } = {},
) {
	const cacheMs = options.cacheMs ?? APP_FLAG_CACHE_MS;
	const now = options.now ?? Date.now;
	const cache = new Map<string, CachedFlag>();

	return async function readAppFlag(key: string): Promise<unknown> {
		const cached = cache.get(key);
		if (cached && now() - cached.readAt < cacheMs) return cached.value;
		try {
			const value = await source.read(key);
			cache.set(key, { value, readAt: now() });
			return value;
		} catch (error) {
			console.error("[app-flags] Failed to read flag", { key, error });
			return null;
		}
	};
}

export const readAppFlag = createAppFlagReader(databaseAppFlagSource);
