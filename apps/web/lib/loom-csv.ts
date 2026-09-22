import type { LoomCsvImportRow } from "@/actions/loom";

export function parseLoomCsvRecords(text: string) {
	const records: string[][] = [];
	let field = "";
	let row: string[] = [];
	let inQuotes = false;
	const input = text.replace(/^\uFEFF/, "");
	const quote = "\u0022";

	for (let index = 0; index < input.length; index += 1) {
		const char = input.charAt(index);
		const next = input.charAt(index + 1);

		if (char === quote) {
			if (inQuotes && next === quote) {
				field += quote;
				index += 1;
			} else {
				inQuotes = !inQuotes;
			}
			continue;
		}

		if (char === "," && !inQuotes) {
			row.push(field.trim());
			field = "";
			continue;
		}

		if ((char === "\n" || char === "\r") && !inQuotes) {
			if (char === "\r" && next === "\n") index += 1;
			row.push(field.trim());
			if (row.some((cell) => cell.length > 0)) records.push(row);
			row = [];
			field = "";
			continue;
		}

		field += char;
	}

	if (inQuotes) throw new Error("CSV has an unclosed quoted field.");

	if (field.length > 0 || row.length > 0) {
		row.push(field.trim());
		if (row.some((cell) => cell.length > 0)) records.push(row);
	}

	return records;
}

export function parseConciergeLoomCsv(text: string): LoomCsvImportRow[] {
	const records = parseLoomCsvRecords(text);
	const headers = records[0]?.map((value) => value.toLowerCase()) ?? [];
	const loomUrlIndex = headers.indexOf("loom_video_url");
	const userEmailIndex = headers.indexOf("user_email");
	const spaceNameIndex = headers.indexOf("space_name");
	if (loomUrlIndex < 0 || userEmailIndex < 0) {
		throw new Error("CSV needs loom_video_url and user_email columns.");
	}
	const rows = records.slice(1).map((values, index) => ({
		rowNumber: index + 2,
		loomUrl: values[loomUrlIndex] ?? "",
		userEmail: values[userEmailIndex] ?? "",
		spaceName: spaceNameIndex < 0 ? undefined : values[spaceNameIndex],
	}));
	if (rows.length === 0) throw new Error("CSV has no video rows.");
	if (rows.length > 500) {
		throw new Error("Split the library into CSV files of up to 500 videos.");
	}
	return rows;
}
