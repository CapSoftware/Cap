import type { LoomImportItemView } from "./status";

const COLUMNS = [
	"row",
	"loom_url",
	"title",
	"recorded_at",
	"owner_email",
	"space",
	"status",
	"cap_url",
	"note",
] as const;

function escapeCell(value: string) {
	const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function buildLoomImportReport(
	items: readonly LoomImportItemView[],
	origin: string,
) {
	const lines = [COLUMNS.join(",")];
	for (const item of items) {
		const capUrl =
			item.videoId && (item.status === "imported" || item.status === "skipped")
				? `${origin}/s/${item.videoId}`
				: "";
		lines.push(
			[
				String(item.row),
				item.url,
				item.title ?? "",
				item.recordedAt ?? "",
				item.email ?? "",
				item.space ?? "",
				item.status,
				capUrl,
				item.error ?? "",
			]
				.map(escapeCell)
				.join(","),
		);
	}
	return `${lines.join("\n")}\n`;
}
