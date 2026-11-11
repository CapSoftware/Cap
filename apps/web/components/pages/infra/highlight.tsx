import type { ReactNode } from "react";

const TOKEN =
	/("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|<\/?[a-z]+|\/?>|\b[a-z]+(?==")|(?<=^|\s)-{1,2}[A-Za-z][\w-]*|\b(?:const|await|curl)\b|\b\d+(?:\.\d+)?\b)/g;

const COLORS = {
	key: "#9C9890",
	string: "#F4F1EB",
	number: "#D8C7A8",
	keyword: "#FFFFFF",
	plain: "#B9B5AD",
	muted: "rgba(236,232,225,0.45)",
} as const;

const colorOf = (token: string, rest: string) => {
	if (token.startsWith('"') || token.startsWith("'")) {
		return /^\s*:/.test(rest) ? COLORS.key : COLORS.string;
	}
	if (token.startsWith("<") || token.endsWith(">")) return COLORS.keyword;
	if (token.startsWith("-") || /^[a-z]+$/.test(token)) {
		return /^(?:const|await|curl)$/.test(token) || token.startsWith("-")
			? COLORS.keyword
			: COLORS.key;
	}
	return COLORS.number;
};

export const highlight = (code: string): ReactNode[] => {
	const out: ReactNode[] = [];
	let cursor = 0;
	for (const match of code.matchAll(TOKEN)) {
		const start = match.index ?? 0;
		const token = match[0];
		if (start > cursor) {
			out.push(
				<span key={`p${cursor}`} style={{ color: COLORS.plain }}>
					{code.slice(cursor, start)}
				</span>,
			);
		}
		out.push(
			<span
				key={`t${start}`}
				style={{ color: colorOf(token, code.slice(start + token.length)) }}
			>
				{token}
			</span>,
		);
		cursor = start + token.length;
	}
	if (cursor < code.length) {
		out.push(
			<span key={`p${cursor}`} style={{ color: COLORS.plain }}>
				{code.slice(cursor)}
			</span>,
		);
	}
	return out;
};

export const CODE_MUTED = COLORS.muted;
