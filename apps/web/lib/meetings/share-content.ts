export const NOTE_TITLE_COLUMN_CHARS = 255;
export const NOTE_EXCERPT_CHARS = 360;
const UNTITLED_NOTE = "Untitled note";

const firstCharacters = (value: string, max: number) =>
	Array.from(value).slice(0, max).join("");

export function noteTitle(title: string): string {
	const trimmed = title.replace(/\s+/g, " ").trim();
	return firstCharacters(trimmed || UNTITLED_NOTE, NOTE_TITLE_COLUMN_CHARS);
}

function withoutTags(value: string): string {
	let current = value;
	for (;;) {
		const next = current.replace(/<[^>]*>/g, "");
		if (next === current) return next.replace(/[<>]/g, "");
		current = next;
	}
}

export function noteExcerpt(markdown: string): string {
	const text = markdown
		.replace(/```[\s\S]*?```/g, " ")
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) => line && !/^#{1,6}\s/.test(line) && !/^[-*_]{3,}$/.test(line),
		)
		.map((line) =>
			line
				.replace(/^>+\s*/, "")
				.replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
				.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
				.replace(/[*_~`]+/g, ""),
		)
		.map(withoutTags)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return firstCharacters(text, NOTE_EXCERPT_CHARS);
}
