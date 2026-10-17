export const LOOM_IMPORT_MAX_ROWS = 2000;
export const LOOM_IMPORT_MAX_SPACE_NAME_LENGTH = 255;
export const LOOM_IMPORT_MAX_URL_LENGTH = 1024;

export type CsvTable = {
	headers: string[];
	rows: string[][];
	delimiter: string;
	headerless: boolean;
};

export type LoomImportField = "loomUrl" | "ownerEmail" | "spaceName";

export type LoomImportMapping = Partial<Record<LoomImportField, number>>;

export type LoomImportRowInput = {
	rowNumber: number;
	loomUrl: string;
	ownerEmail?: string;
	spaceName?: string;
};

export type LoomImportRowIssue = {
	rowNumber: number;
	value: string;
	reason: "not_loom" | "bad_email" | "space_too_long" | "duplicate";
	duplicateOf?: number;
};

export type LoomImportPlan = {
	rows: LoomImportRowInput[];
	issues: LoomImportRowIssue[];
	owners: number;
	spaces: number;
	overLimit: boolean;
};

const LOOM_ID_PATTERN = /^[0-9a-f]{32}$/i;
const TRAILING_LOOM_ID_PATTERN = /([0-9a-f]{32})$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOOM_LINK_PATTERN =
	/https?:\/\/(?:[a-z0-9-]+\.)*loom\.com\/[^\s"'<>,;)]+/gi;
const CANDIDATE_DELIMITERS = [",", ";", "\t"] as const;

const URL_HEADER_HINTS = [
	"loomvideourl",
	"loomurl",
	"loomlink",
	"sharelink",
	"shareurl",
	"videourl",
	"videolink",
	"link",
	"url",
];
const ID_HEADER_HINTS = ["loomvideoid", "loomid", "videoid", "id"];
const EMAIL_HEADER_HINTS = [
	"useremail",
	"owneremail",
	"creatoremail",
	"memberemail",
	"recordedby",
	"email",
];
const SPACE_HEADER_HINTS = ["spacename", "space", "loomspace", "capspace"];

export function normalizeHeader(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function detectDelimiter(text: string) {
	const firstLineEnd = text.search(/\r?\n/);
	const sample = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
	let best: string = ",";
	let bestCount = 0;
	for (const delimiter of CANDIDATE_DELIMITERS) {
		let count = 0;
		let inQuotes = false;
		for (let index = 0; index < sample.length; index++) {
			const char = sample[index];
			if (char === '"') inQuotes = !inQuotes;
			else if (char === delimiter && !inQuotes) count++;
		}
		if (count > bestCount) {
			best = delimiter;
			bestCount = count;
		}
	}
	return best;
}

export function parseCsvRecords(input: string, delimiter = ",") {
	const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
	const records: string[][] = [];
	const length = text.length;
	const delimiterCode = delimiter.charCodeAt(0);
	let row: string[] = [];
	let index = 0;

	const pushRow = () => {
		records.push(row);
		row = [];
	};

	while (index <= length) {
		if (index === length) {
			if (row.length > 0) pushRow();
			break;
		}

		if (text.charCodeAt(index) === 34) {
			let value = "";
			let segmentStart = index + 1;
			let cursor = segmentStart;
			let closed = false;
			while (cursor < length) {
				const quote = text.indexOf('"', cursor);
				if (quote === -1) break;
				if (text.charCodeAt(quote + 1) === 34) {
					value += `${text.slice(segmentStart, quote)}"`;
					cursor = quote + 2;
					segmentStart = cursor;
					continue;
				}
				value += text.slice(segmentStart, quote);
				cursor = quote + 1;
				closed = true;
				break;
			}
			if (!closed) throw new Error("This CSV has an unclosed quoted field.");
			let end = cursor;
			while (
				end < length &&
				text.charCodeAt(end) !== delimiterCode &&
				text.charCodeAt(end) !== 10 &&
				text.charCodeAt(end) !== 13
			) {
				end++;
			}
			row.push((value + text.slice(cursor, end)).trim());
			index = end;
		} else {
			let end = index;
			while (
				end < length &&
				text.charCodeAt(end) !== delimiterCode &&
				text.charCodeAt(end) !== 10 &&
				text.charCodeAt(end) !== 13
			) {
				end++;
			}
			row.push(text.slice(index, end).trim());
			index = end;
		}

		if (index >= length) {
			pushRow();
			break;
		}

		const code = text.charCodeAt(index);
		if (code === delimiterCode) {
			index++;
			if (index === length) {
				row.push("");
				pushRow();
				break;
			}
			continue;
		}

		if (code === 13 && text.charCodeAt(index + 1) === 10) index += 2;
		else index++;
		pushRow();
	}

	while (records.length > 0 && !isFilledRecord(records[records.length - 1])) {
		records.pop();
	}
	return records;
}

function isFilledRecord(record: string[] | undefined) {
	return Boolean(record?.some((cell) => cell.length > 0));
}

export function countFilledRows(table: CsvTable) {
	let count = 0;
	for (const row of table.rows) if (isFilledRecord(row)) count++;
	return count;
}

export function parseCsv(text: string): CsvTable {
	const delimiter = detectDelimiter(text);
	const records = parseCsvRecords(text, delimiter);
	const first = records[0];
	if (!first || !isFilledRecord(first)) throw new Error("This CSV is empty.");
	const headerless = first.some(
		(cell) =>
			LOOM_ID_PATTERN.test(cell) ||
			(/loom\.com/i.test(cell) && extractLoomVideoId(cell) !== null),
	);
	if (headerless) {
		const width = records.reduce(
			(max, record) => Math.max(max, record.length),
			0,
		);
		return {
			headers: Array.from(
				{ length: width },
				(_, index) => `Column ${index + 1}`,
			),
			rows: records,
			delimiter,
			headerless: true,
		};
	}
	return {
		headers: first.map((header) => header.trim()),
		rows: records.slice(1),
		delimiter,
		headerless: false,
	};
}

export function extractLoomVideoId(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (LOOM_ID_PATTERN.test(trimmed)) return trimmed.toLowerCase();

	let url: URL;
	try {
		url = new URL(
			/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
		);
	} catch {
		return null;
	}

	const host = url.hostname.toLowerCase();
	if (host !== "loom.com" && !host.endsWith(".loom.com")) return null;

	const segments = url.pathname.split("/").filter(Boolean);
	const last = segments.at(-1);
	if (!last || segments.length < 2) return null;

	const trailingId = last.match(TRAILING_LOOM_ID_PATTERN)?.[1];
	if (trailingId) return trailingId.toLowerCase();

	return /^[a-z0-9]{10,64}$/i.test(last) ? last : null;
}

export function loomShareUrl(loomVideoId: string) {
	return `https://www.loom.com/share/${loomVideoId}`;
}

export function isValidImportEmail(value: string) {
	return EMAIL_PATTERN.test(value);
}

export function normalizeImportEmail(value: string) {
	return value.trim().toLowerCase();
}

export function normalizeImportSpaceName(value: string) {
	return value.trim().replace(/\s+/g, " ");
}

function sampleColumn(rows: string[][], column: number, limit = 60) {
	const values: string[] = [];
	for (const row of rows) {
		const value = row[column]?.trim();
		if (value) values.push(value);
		if (values.length >= limit) break;
	}
	return values;
}

function headerScore(header: string, hints: string[]) {
	const normalized = normalizeHeader(header);
	const exact = hints.indexOf(normalized);
	if (exact !== -1) return 1 - exact / (hints.length * 4);
	const partial = hints.findIndex((hint) => normalized.includes(hint));
	return partial === -1 ? 0 : 0.5 - partial / (hints.length * 4);
}

function bestColumn(
	headers: string[],
	score: (column: number) => number,
	taken: Set<number>,
) {
	let best: number | undefined;
	let bestScore = 0;
	for (let column = 0; column < headers.length; column++) {
		if (taken.has(column)) continue;
		const value = score(column);
		if (value > bestScore) {
			best = column;
			bestScore = value;
		}
	}
	return best;
}

export function detectLoomImportMapping(table: CsvTable): LoomImportMapping {
	const { headers, rows } = table;
	const taken = new Set<number>();
	const samples = headers.map((_, column) => sampleColumn(rows, column));

	const ratio = (column: number, test: (value: string) => boolean) => {
		const values = samples[column] ?? [];
		if (values.length === 0) return 0;
		return values.filter(test).length / values.length;
	};

	const loomUrl = bestColumn(
		headers,
		(column) => {
			const linkRatio = ratio(column, (value) =>
				/loom\.com/i.test(value) ? extractLoomVideoId(value) !== null : false,
			);
			const idRatio = ratio(column, (value) => LOOM_ID_PATTERN.test(value));
			const header = headers[column] ?? "";
			if (linkRatio >= 0.5)
				return 2 + linkRatio + headerScore(header, URL_HEADER_HINTS);
			if (idRatio >= 0.5)
				return 1 + idRatio + headerScore(header, ID_HEADER_HINTS);
			return headerScore(header, URL_HEADER_HINTS) * 0.5;
		},
		taken,
	);
	if (loomUrl !== undefined) taken.add(loomUrl);

	const ownerEmail = bestColumn(
		headers,
		(column) => {
			const emailRatio = ratio(column, isValidImportEmail);
			const hint = headerScore(headers[column] ?? "", EMAIL_HEADER_HINTS);
			return emailRatio >= 0.5 ? 1 + emailRatio + hint : 0;
		},
		taken,
	);
	if (ownerEmail !== undefined) taken.add(ownerEmail);

	const spaceName = bestColumn(
		headers,
		(column) =>
			SPACE_HEADER_HINTS.includes(normalizeHeader(headers[column] ?? "")) &&
			ratio(column, () => true) > 0
				? 1
				: 0,
		taken,
	);

	return { loomUrl, ownerEmail, spaceName };
}

export function tableFromPastedLinks(text: string): CsvTable {
	const rows: string[][] = [];
	for (const match of text.matchAll(LOOM_LINK_PATTERN)) {
		rows.push([match[0].replace(/[.)\]]+$/, "")]);
	}
	if (rows.length === 0) {
		for (const token of text.split(/\s+/)) {
			if (LOOM_ID_PATTERN.test(token)) rows.push([token]);
		}
	}
	return { headers: ["Loom link"], rows, delimiter: ",", headerless: true };
}

export function buildLoomImportPlan(
	table: CsvTable,
	mapping: LoomImportMapping,
	{ allowOwners }: { allowOwners: boolean },
): LoomImportPlan {
	const rows: LoomImportRowInput[] = [];
	const issues: LoomImportRowIssue[] = [];
	const seen = new Map<string, number>();
	const owners = new Set<string>();
	const spaces = new Set<string>();
	const urlColumn = mapping.loomUrl;

	if (urlColumn === undefined) {
		return { rows, issues, owners: 0, spaces: 0, overLimit: false };
	}

	const emailColumn = allowOwners ? mapping.ownerEmail : undefined;
	const spaceColumn = allowOwners ? mapping.spaceName : undefined;

	const firstRowNumber = table.headerless ? 1 : 2;
	table.rows.forEach((record, index) => {
		const rowNumber = index + firstRowNumber;
		const rawUrl = (record[urlColumn] ?? "").trim();
		const rawEmail =
			emailColumn === undefined
				? ""
				: normalizeImportEmail(record[emailColumn] ?? "");
		const rawSpace =
			spaceColumn === undefined
				? ""
				: normalizeImportSpaceName(record[spaceColumn] ?? "");

		if (!rawUrl && !rawEmail && !rawSpace) return;

		const loomVideoId =
			rawUrl.length <= LOOM_IMPORT_MAX_URL_LENGTH
				? extractLoomVideoId(rawUrl)
				: null;
		if (!loomVideoId) {
			issues.push({ rowNumber, value: rawUrl, reason: "not_loom" });
			return;
		}
		if (rawEmail && !isValidImportEmail(rawEmail)) {
			issues.push({ rowNumber, value: rawEmail, reason: "bad_email" });
			return;
		}
		if (rawSpace.length > LOOM_IMPORT_MAX_SPACE_NAME_LENGTH) {
			issues.push({ rowNumber, value: rawSpace, reason: "space_too_long" });
			return;
		}
		const duplicateOf = seen.get(loomVideoId);
		if (duplicateOf !== undefined) {
			issues.push({
				rowNumber,
				value: rawUrl,
				reason: "duplicate",
				duplicateOf,
			});
			return;
		}
		seen.set(loomVideoId, rowNumber);
		if (rawEmail) owners.add(rawEmail);
		if (rawSpace) spaces.add(rawSpace.toLowerCase());
		rows.push({
			rowNumber,
			loomUrl: /^https?:\/\//i.test(rawUrl)
				? rawUrl
				: loomShareUrl(loomVideoId),
			...(rawEmail ? { ownerEmail: rawEmail } : {}),
			...(rawSpace ? { spaceName: rawSpace } : {}),
		});
	});

	return {
		rows,
		issues,
		owners: owners.size,
		spaces: spaces.size,
		overLimit: rows.length > LOOM_IMPORT_MAX_ROWS,
	};
}

export type LoomImportRowsPayload = {
	owners: string[];
	spaces: string[];
	rows: Array<[number, string, number, number]>;
};

export function encodeLoomImportRows(
	rows: LoomImportRowInput[],
): LoomImportRowsPayload {
	const owners: string[] = [];
	const spaces: string[] = [];
	const ownerIndex = new Map<string, number>();
	const spaceIndex = new Map<string, number>();
	const indexOf = (
		value: string | undefined,
		list: string[],
		index: Map<string, number>,
	) => {
		if (!value) return -1;
		let position = index.get(value);
		if (position === undefined) {
			position = list.length;
			list.push(value);
			index.set(value, position);
		}
		return position;
	};
	return {
		owners,
		spaces,
		rows: rows.map((row) => [
			row.rowNumber,
			extractLoomVideoId(row.loomUrl) ?? row.loomUrl,
			indexOf(row.ownerEmail, owners, ownerIndex),
			indexOf(row.spaceName, spaces, spaceIndex),
		]),
	};
}

export function decodeLoomImportRows(
	payload: unknown,
): LoomImportRowInput[] | null {
	if (!payload || typeof payload !== "object") return null;
	const { owners, spaces, rows } = payload as Partial<LoomImportRowsPayload>;
	if (!Array.isArray(owners) || !Array.isArray(spaces) || !Array.isArray(rows))
		return null;
	const pick = (list: unknown[], index: unknown) =>
		typeof index === "number" && typeof list[index] === "string"
			? (list[index] as string)
			: undefined;
	return rows.map((row, index) => {
		const [rowNumber, loomId, owner, space] = Array.isArray(row) ? row : [];
		const id = typeof loomId === "string" ? loomId : "";
		const ownerEmail = pick(owners, owner);
		const spaceName = pick(spaces, space);
		return {
			rowNumber:
				typeof rowNumber === "number" && Number.isInteger(rowNumber)
					? rowNumber
					: index + 1,
			loomUrl: LOOM_ID_PATTERN.test(id) ? loomShareUrl(id.toLowerCase()) : id,
			...(ownerEmail ? { ownerEmail } : {}),
			...(spaceName ? { spaceName } : {}),
		};
	});
}

export const LOOM_IMPORT_ISSUE_LABELS: Record<
	LoomImportRowIssue["reason"],
	string
> = {
	not_loom: "Not a Loom link",
	bad_email: "Owner email looks wrong",
	space_too_long: "Space name is too long",
	duplicate: "Duplicate video",
};

export const LOOM_CSV_TEMPLATE =
	"loom_video_url,user_email,space_name\nhttps://www.loom.com/share/0123456789abcdef0123456789abcdef,teammate@example.com,Sales\n";
