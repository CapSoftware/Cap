import {
	type ColumnMapping,
	type InventoryOptions,
	type InventoryTable,
	MAX_COLUMNS,
	MAX_ROWS,
} from "./inventory";
import type { ImportOutcome } from "./queue";

export type ImportDraft = {
	id: string;
	fileName: string;
	table: InventoryTable;
	mapping: ColumnMapping;
	options: InventoryOptions;
	selected: number[];
	organizationId: string;
};

export type ImportRun = {
	draftId: string;
	apiBaseUrl: string;
	userId: string;
	organizationId: string;
	outcomes: Record<number, ImportOutcome>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.every((item: unknown) => typeof item === "string");

const isDraft = (value: unknown): value is ImportDraft => {
	if (
		!isObject(value) ||
		typeof value.id !== "string" ||
		!value.id ||
		typeof value.fileName !== "string" ||
		typeof value.organizationId !== "string" ||
		!isObject(value.table) ||
		!isStringArray(value.table.headers) ||
		!Array.isArray(value.table.records) ||
		!isObject(value.mapping) ||
		!isObject(value.options) ||
		!Array.isArray(value.selected)
	)
		return false;
	const headers = value.table.headers;
	const records = value.table.records;
	const { mapping, options, selected } = value;
	if (
		headers.length === 0 ||
		headers.length > MAX_COLUMNS ||
		headers.some((header) => !header.trim()) ||
		new Set(headers.map((header) => header.trim().toLowerCase())).size !==
			headers.length ||
		records.length === 0 ||
		records.length > MAX_ROWS ||
		!records.every(
			(record) => isStringArray(record) && record.length === headers.length,
		) ||
		!["url", "title", "owner", "space", "createdAt", "duration"].every(
			(key) =>
				typeof mapping[key] === "number" &&
				Number.isInteger(mapping[key]) &&
				mapping[key] >= -1 &&
				mapping[key] < headers.length,
		) ||
		typeof options.ownerEmail !== "string" ||
		typeof options.spaceName !== "string" ||
		(options.ownerMode !== "column" && options.ownerMode !== "override") ||
		(options.spaceMode !== "none" &&
			options.spaceMode !== "column" &&
			options.spaceMode !== "override") ||
		selected.some(
			(record: unknown) =>
				typeof record !== "number" ||
				!Number.isInteger(record) ||
				record < 1 ||
				record > records.length,
		) ||
		new Set(selected).size !== selected.length
	)
		return false;
	return true;
};

const isRun = (value: unknown, draft: ImportDraft): value is ImportRun => {
	if (
		!isObject(value) ||
		value.draftId !== draft.id ||
		typeof value.apiBaseUrl !== "string" ||
		typeof value.userId !== "string" ||
		!value.userId ||
		typeof value.organizationId !== "string" ||
		!value.organizationId ||
		!isObject(value.outcomes)
	)
		return false;
	try {
		const url = new URL(value.apiBaseUrl);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			return false;
	} catch {
		return false;
	}
	return Object.entries(value.outcomes).every(([key, outcome]) => {
		if (!isObject(outcome)) return false;
		const record = outcome.sourceRecord;
		return (
			typeof record === "number" &&
			Number.isInteger(record) &&
			record >= 1 &&
			record <= draft.table.records.length &&
			String(record) === key &&
			typeof outcome.state === "string" &&
			["sending", "started", "existing", "failed", "uncertain"].includes(
				outcome.state,
			) &&
			(outcome.videoId === undefined || typeof outcome.videoId === "string") &&
			(outcome.message === undefined || typeof outcome.message === "string") &&
			(!["started", "existing"].includes(outcome.state) ||
				Boolean(outcome.videoId))
		);
	});
};

export const restoreImportInventory = (
	draft: unknown,
	run: unknown,
): { draft: ImportDraft | null; run: ImportRun | null } => {
	if (draft == null && run == null) return { draft: null, run: null };
	if (!isDraft(draft) || (run != null && !isRun(run, draft))) {
		throw new Error(
			"Saved import progress cannot be read safely. Check your Cap dashboard before opening another inventory.",
		);
	}
	return {
		draft,
		run:
			run == null
				? null
				: {
						...run,
						outcomes: Object.fromEntries(
							Object.entries(run.outcomes).map(([key, outcome]) => [
								key,
								outcome.state === "sending"
									? {
											...outcome,
											state: "uncertain" as const,
											message:
												"This tab closed before Cap confirmed the request. Check your dashboard before importing it again.",
										}
									: outcome,
							]),
						),
					},
	};
};

const openDatabase = () =>
	new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("cap-loom-importer", 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore("inventory");
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () =>
			reject(
				new Error("Close other importer tabs to unlock the saved inventory."),
			);
	});

let pendingWrite: Promise<unknown> = Promise.resolve();

const write = (
	values: { draft?: ImportDraft; run?: ImportRun },
	clear = false,
) => {
	const operation = pendingWrite
		.catch(() => undefined)
		.then(async () => {
			const database = await openDatabase();
			try {
				await new Promise<void>((resolve, reject) => {
					const transaction = database.transaction("inventory", "readwrite");
					const store = transaction.objectStore("inventory");
					if (clear) store.clear();
					if (values.draft) store.put(values.draft, "draft");
					if (values.run) store.put(values.run, "run");
					transaction.oncomplete = () => resolve();
					transaction.onabort = () => reject(transaction.error);
					transaction.onerror = () => reject(transaction.error);
				});
			} finally {
				database.close();
			}
		});
	pendingWrite = operation;
	return operation;
};

export const saveImportDraft = (draft: ImportDraft) => write({ draft });
export const saveImportRun = (run: ImportRun) => write({ run });
export const clearImportInventory = () => write({}, true);

export const loadImportInventory = async () => {
	await pendingWrite.catch(() => undefined);
	const database = await openDatabase();
	try {
		return await new Promise<{
			draft: ImportDraft | null;
			run: ImportRun | null;
		}>((resolve, reject) => {
			const transaction = database.transaction("inventory", "readonly");
			const store = transaction.objectStore("inventory");
			const draft = store.get("draft");
			const run = store.get("run");
			transaction.oncomplete = () => {
				try {
					resolve(restoreImportInventory(draft.result, run.result));
				} catch (error) {
					reject(error);
				}
			};
			transaction.onabort = () => reject(transaction.error);
			transaction.onerror = () => reject(transaction.error);
		});
	} finally {
		database.close();
	}
};
