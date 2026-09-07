export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 50_000;

export const MAX_COLUMNS = 256;

export type InventoryTable = {
	headers: string[];
	records: string[][];
};

export type ColumnMapping = {
	url: number;
	title: number;
	owner: number;
	space: number;
	createdAt: number;
	duration: number;
};

export type InventoryOptions = {
	ownerEmail: string;
	spaceName: string;
	ownerMode: "column" | "override";
	spaceMode: "none" | "column" | "override";
};

export type InventoryRow = {
	index: number;
	sourceRecord: number;
	url: string;
	videoId: string | null;
	title: string;
	originalOwner: string;
	ownerEmail: string;
	spaceName: string;
	createdAt: string;
	duration: string;
	issue:
		| "missing-link"
		| "invalid-link"
		| "invalid-owner"
		| "invalid-space"
		| "duplicate"
		| null;
	detail: string;
	reviewRequired: boolean;
	raw: string[];
};

export type ImportCsvRow = {
	loom_video_url: string;
	user_email: string;
	space_name?: string;
};

function checkedTable(headers: string[], records: string[][]): InventoryTable {
	if (headers.length === 0 || headers.some((header) => !header.trim())) {
		throw new Error("Every column needs a non-empty header.");
	}
	if (headers.length > MAX_COLUMNS) {
		throw new Error(`Files are limited to ${MAX_COLUMNS} columns.`);
	}
	const uniqueHeaders = new Set(
		headers.map((header) => header.trim().toLowerCase()),
	);
	if (uniqueHeaders.size !== headers.length) {
		throw new Error("Column headers must be unique, ignoring case and spaces.");
	}
	if (records.length > MAX_ROWS) {
		throw new Error(
			`Files are limited to ${MAX_ROWS.toLocaleString("en-US")} records.`,
		);
	}
	if (!records.some((record) => record.some((value) => value.trim()))) {
		throw new Error(
			"This file has no data records. Include a header and at least one record.",
		);
	}
	return {
		headers,
		records: records.map((record, index) => {
			if (record.length > headers.length) {
				throw new Error(
					`Record ${index + 1} has more values than the header. Check its delimiters and quotes.`,
				);
			}
			return Array.from(
				{ length: headers.length },
				(_, column) => record[column] ?? "",
			);
		}),
	};
}

function parseDelimited(text: string, delimiter: string): InventoryTable {
	const records: string[][] = [];
	let record: string[] = [];
	let field = "";
	let state: "plain" | "quoted" | "closed" = "plain";
	let started = false;

	const finishField = () => {
		record.push(field);
		if (record.length > MAX_COLUMNS) {
			throw new Error(`Files are limited to ${MAX_COLUMNS} columns.`);
		}
		field = "";
		state = "plain";
	};
	const finishRecord = () => {
		finishField();
		records.push(record);
		if (records.length > MAX_ROWS + 1) {
			throw new Error(
				`Files are limited to ${MAX_ROWS.toLocaleString("en-US")} records.`,
			);
		}
		record = [];
		started = false;
	};

	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (state === "quoted") {
			if (character !== '"') {
				field += character;
			} else if (text[index + 1] === '"') {
				field += '"';
				index++;
			} else {
				state = "closed";
			}
			continue;
		}
		if (character === delimiter) {
			finishField();
			started = true;
		} else if (character === "\n" || character === "\r") {
			finishRecord();
			if (character === "\r" && text[index + 1] === "\n") index++;
		} else if (state === "closed" || (character === '"' && field !== "")) {
			throw new Error(
				`Malformed quotes near record ${Math.max(1, records.length)}. Quote the entire field and escape quotes by doubling them.`,
			);
		} else if (character === '"') {
			state = "quoted";
			started = true;
		} else {
			field += character;
			started = true;
		}
	}
	if (state === "quoted") {
		throw new Error(
			"A quoted field is not closed. Check the file's final quotes.",
		);
	}
	if (started) finishRecord();
	return checkedTable(records[0] ?? [], records.slice(1));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): InventoryTable {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(
			"This file is not valid JSON. Use an array of flat objects or an object with a videos array.",
		);
	}
	const records = isObject(parsed) ? parsed.videos : parsed;
	if (!Array.isArray(records)) {
		throw new Error(
			"JSON must contain an array of flat objects or an object with a videos array.",
		);
	}
	if (records.length > MAX_ROWS) {
		throw new Error(
			`Files are limited to ${MAX_ROWS.toLocaleString("en-US")} records.`,
		);
	}
	const headers = new Set<string>();
	const objects: Record<string, unknown>[] = [];
	for (const [index, record] of records.entries()) {
		if (!isObject(record)) {
			throw new Error(`JSON record ${index + 1} must be a flat object.`);
		}
		for (const [key, value] of Object.entries(record)) {
			if (value !== null && typeof value === "object") {
				throw new Error(
					`JSON record ${index + 1} contains nested data in "${key}". Use flat values.`,
				);
			}
			if (
				typeof value === "number" &&
				(!Number.isFinite(value) ||
					(Number.isInteger(value) && !Number.isSafeInteger(value)))
			) {
				throw new Error(
					`JSON record ${index + 1} contains an unsafe number in "${key}". Store long numeric identifiers as strings.`,
				);
			}
			headers.add(key);
			if (headers.size > MAX_COLUMNS) {
				throw new Error(`Files are limited to ${MAX_COLUMNS} columns.`);
			}
		}
		objects.push(record);
	}
	const columns = [...headers];
	return checkedTable(
		columns,
		objects.map((record) =>
			columns.map((key) => {
				const value = Object.hasOwn(record, key) ? record[key] : null;
				return value === null ? "" : String(value);
			}),
		),
	);
}

function detectDelimiter(text: string): string {
	let quoted = false;
	let commas = 0;
	let tabs = 0;
	for (const character of text) {
		if (character === '"') quoted = !quoted;
		if (quoted) continue;
		if (character === "\n" || character === "\r") break;
		if (character === ",") commas++;
		if (character === "\t") tabs++;
	}
	return tabs > commas ? "\t" : ",";
}

export function parseInventory(text: string, filename: string): InventoryTable {
	if (
		text.length > MAX_FILE_BYTES ||
		new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES
	) {
		throw new Error("Choose a file no larger than 10 MB.");
	}
	const source = text.replace(/^\uFEFF/, "");
	if (!source.trim()) throw new Error("This file is empty.");
	const extension = filename.split(".").pop()?.toLowerCase();
	if (
		extension === "json" ||
		(extension !== "csv" && extension !== "tsv" && /^\s*[[{]/.test(source))
	) {
		return parseJson(source);
	}
	const delimiter =
		extension === "tsv"
			? "\t"
			: extension === "csv"
				? ","
				: detectDelimiter(source);
	return parseDelimited(source, delimiter);
}

function normalizedHeader(header: string): string {
	return header
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
}

export function detectColumns(headers: string[]): ColumnMapping {
	const normalized = headers.map(normalizedHeader);
	const findColumn = (aliases: string[]) => {
		for (const alias of aliases) {
			const index = normalized.indexOf(alias);
			if (index !== -1) return index;
		}
		return -1;
	};
	return {
		url: findColumn([
			"loom_video_url",
			"video_link",
			"video_url",
			"loom_url",
			"url",
			"link",
		]),
		title: findColumn(["video_name", "video_title", "title", "name"]),
		owner: findColumn([
			"user_email",
			"creator_email",
			"original_creator_email",
			"owner_email",
			"email",
			"creator",
			"owner",
		]),
		space: findColumn(["space_name"]),
		createdAt: findColumn(["created_at", "date_created", "created"]),
		duration: findColumn(["duration", "video_duration", "length"]),
	};
}

function readableText(value: string): string {
	return value.replace(/\\([@|-])/g, "$1").trim();
}

function loomVideoId(value: string): string | null {
	const match =
		/^https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([a-f0-9]{32})\/?(?:[?#][^\s\\]*)?$/i.exec(
			value,
		);
	return match?.[1]?.toLowerCase() ?? null;
}

function hasControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || (code >= 127 && code <= 159);
	});
}

function validEmail(value: string): boolean {
	return (
		value.length <= 254 &&
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
		!hasControlCharacter(value)
	);
}

function validSpace(value: string): boolean {
	return value.length <= 255 && !hasControlCharacter(value);
}

export function buildInventory(
	table: InventoryTable,
	mapping: ColumnMapping,
	options: InventoryOptions,
): InventoryRow[] {
	const seen = new Map<string, number>();
	const decisionColumns = table.headers.flatMap((header, index) =>
		[
			"review_decision",
			"decision",
			"import",
			"include",
			"cap_import_status",
		].includes(normalizedHeader(header).replace(/^_+/, ""))
			? [index]
			: [],
	);
	const approvedDecisions = new Set(["approved", "include", "yes", "true"]);
	return table.records.map((record, index) => {
		const mapped = (column: number) => readableText(record[column] ?? "");
		const inputUrl = (record[mapping.url] ?? "").trim();
		const videoId = loomVideoId(inputUrl);
		const originalOwner = mapped(mapping.owner);
		const ownerEmail = (
			options.ownerMode === "override"
				? options.ownerEmail.trim()
				: originalOwner
		).toLowerCase();
		const inputSpace =
			options.spaceMode === "override"
				? options.spaceName.trim()
				: options.spaceMode === "column"
					? mapped(mapping.space)
					: "";
		const spaceName = inputSpace.replace(/\s+/g, " ");
		const reviewRequired = decisionColumns.some((column) => {
			const decision = record[column]?.trim().toLowerCase() ?? "";
			return !approvedDecisions.has(decision);
		});
		let issue: InventoryRow["issue"] = null;
		let detail = reviewRequired
			? "Review this record before selecting it for import."
			: "";
		if (!inputUrl) {
			issue = "missing-link";
			detail =
				"This record has no Loom link. Its source metadata has been preserved.";
		} else if (!videoId) {
			issue = "invalid-link";
			detail =
				"Use an http or https loom.com share or embed link with a 32-character video ID.";
		} else if (seen.has(videoId)) {
			issue = "duplicate";
			detail = `This video also appears in record ${seen.get(videoId)}. Only its first record is eligible.`;
		} else if (!validEmail(ownerEmail)) {
			issue = "invalid-owner";
			detail = "Assign a valid owner email before importing this video.";
		} else if (!validSpace(spaceName)) {
			issue = "invalid-space";
			detail =
				"Use a Space name no longer than 255 characters without control characters.";
		}
		if (videoId && !seen.has(videoId)) seen.set(videoId, index + 1);
		return {
			index,
			sourceRecord: index + 1,
			url: videoId ? `https://www.loom.com/share/${videoId}` : inputUrl,
			videoId,
			title: mapped(mapping.title),
			originalOwner,
			ownerEmail,
			spaceName,
			createdAt: mapped(mapping.createdAt),
			duration: mapped(mapping.duration),
			issue,
			detail,
			reviewRequired,
			raw: [...record],
		};
	});
}

export function toImportRows(rows: InventoryRow[]): ImportCsvRow[] {
	const invalid = rows.find(
		(row) =>
			row.issue !== null ||
			!loomVideoId(row.url) ||
			!validEmail(row.ownerEmail) ||
			!validSpace(row.spaceName),
	);
	if (invalid) {
		throw new Error(
			`Record ${invalid.sourceRecord} is not ready to import. ${invalid.detail || "Check its Loom link, owner email, and Space name."}`,
		);
	}
	return rows.map((row) => ({
		loom_video_url: row.url,
		user_email: row.ownerEmail,
		...(row.spaceName ? { space_name: row.spaceName } : {}),
	}));
}

function formulaLike(value: string): boolean {
	for (const character of value) {
		if (character === "\t" || character === "\r" || character === "\n")
			return true;
		const code = character.charCodeAt(0);
		if (!character.trim() || code < 32 || (code >= 127 && code <= 159))
			continue;
		return "=+@-".includes(character);
	}
	return false;
}

function csvCell(value: string): string {
	const safe = formulaLike(value) ? `'${value}` : value;
	return /[",\t\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvFile(records: string[][]): string {
	return `\uFEFF${records.map((record) => record.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function exportImportCsv(rows: InventoryRow[]): string {
	const prepared = toImportRows(rows);
	if (
		prepared.some(
			(row) => formulaLike(row.user_email) || formulaLike(row.space_name ?? ""),
		)
	) {
		throw new Error(
			"This owner or Space starts with a spreadsheet formula character. Rename it for CSV export, or import directly into Cap.",
		);
	}
	return csvFile([
		["loom_video_url", "user_email", "space_name"],
		...prepared.map((row) => [
			row.loom_video_url,
			row.user_email,
			row.space_name ?? "",
		]),
	]);
}

export function exportInventoryCsv(
	table: InventoryTable,
	rows: InventoryRow[],
): string {
	const byIndex = new Map<number, InventoryRow>();
	for (const row of rows) {
		if (
			!Number.isInteger(row.index) ||
			row.index < 0 ||
			row.index >= table.records.length ||
			byIndex.has(row.index)
		) {
			throw new Error(
				"The prepared inventory does not match the source records. Reload the file before downloading it.",
			);
		}
		byIndex.set(row.index, row);
	}
	const usedHeaders = new Set(
		table.headers.map((header) => header.trim().toLowerCase()),
	);
	const preparedHeaders = [
		"source_record_number",
		"prepared_loom_video_url",
		"prepared_user_email",
		"prepared_space_name",
		"validation_status",
		"validation_detail",
		"review_required",
	].map((header) => {
		let candidate = header;
		while (usedHeaders.has(candidate)) candidate = `cap_${candidate}`;
		usedHeaders.add(candidate);
		return candidate;
	});
	return csvFile([
		[...table.headers, ...preparedHeaders],
		...table.records.map((record, index) => {
			const row = byIndex.get(index);
			return [
				...record,
				String(index + 1),
				row?.url ?? "",
				row?.ownerEmail ?? "",
				row?.spaceName ?? "",
				row
					? (row.issue ?? (row.reviewRequired ? "review-required" : "ready"))
					: "not-prepared",
				row?.detail ?? "This record has not been prepared.",
				String(row?.reviewRequired ?? true),
			];
		}),
	]);
}
