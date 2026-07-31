import type { MobileProductAnalyticsState } from "./product-analytics-client";

type ProductAnalyticsFileSystem = {
	writeAsStringAsync: (uri: string, contents: string) => Promise<void>;
	readAsStringAsync: (uri: string) => Promise<string>;
	deleteAsync: (uri: string, options: { idempotent: boolean }) => Promise<void>;
	getInfoAsync: (uri: string) => Promise<{ exists: boolean }>;
	moveAsync: (options: { from: string; to: string }) => Promise<void>;
};

export function createMobileProductAnalyticsStorage(
	fileSystem: ProductAnalyticsFileSystem,
	documentDirectory: string | null,
) {
	const stateUri = documentDirectory
		? `${documentDirectory}product-analytics-outbox-v1.json`
		: null;
	const nextStateUri = stateUri ? `${stateUri}.next` : null;
	const backupStateUri = stateUri ? `${stateUri}.backup` : null;
	const readJsonFile = async (uri: string) =>
		JSON.parse(await fileSystem.readAsStringAsync(uri)) as unknown;

	const readState = async () => {
		if (!stateUri) return null;
		for (const uri of [stateUri, backupStateUri, nextStateUri]) {
			if (!uri) continue;
			try {
				return await readJsonFile(uri);
			} catch {}
		}
		return null;
	};

	const writeState = async (state: MobileProductAnalyticsState) => {
		if (!stateUri || !nextStateUri || !backupStateUri) {
			throw new Error("Mobile analytics storage is unavailable");
		}
		await fileSystem.writeAsStringAsync(nextStateUri, JSON.stringify(state));
		await readJsonFile(nextStateUri);
		await fileSystem.deleteAsync(backupStateUri, { idempotent: true });
		const current = await fileSystem.getInfoAsync(stateUri);
		if (current.exists) {
			await fileSystem.moveAsync({ from: stateUri, to: backupStateUri });
		}
		await fileSystem.moveAsync({ from: nextStateUri, to: stateUri });
	};

	return { readState, writeState };
}
