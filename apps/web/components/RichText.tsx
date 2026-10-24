import { Fragment, type ReactNode } from "react";

type RichTextElement = {
	tag: string;
	attrs: Record<string, string>;
	children: RichTextPart[];
};

type RichTextPart = string | RichTextElement;

const selfClosingTags = new Set(["br"]);
const attrPattern = /([a-zA-Z:-]+)=["']([^"']*)["']/g;

const parseAttributes = (source: string) => {
	const attrs: Record<string, string> = {};

	for (const match of source.matchAll(attrPattern)) {
		const name = match[1];
		const value = match[2];
		if (!name || value === undefined) continue;
		attrs[name] = value;
	}

	return attrs;
};

const parseRichText = (content: string) => {
	const root: RichTextElement = {
		tag: "root",
		attrs: {},
		children: [],
	};
	const stack = [root];

	for (const token of content.split(/(<\/?[^>]+>)/g).filter(Boolean)) {
		const parent = stack.at(-1);
		if (!parent) continue;

		if (!token.startsWith("<")) {
			parent.children.push(token);
			continue;
		}

		const close = token.match(/^<\/([a-zA-Z0-9-]+)>$/);
		if (close) {
			const tag = close[1]?.toLowerCase();
			if (!tag) continue;
			while (stack.length > 1) {
				const current = stack.pop();
				if (current?.tag === tag) break;
			}
			continue;
		}

		const open = token.match(/^<([a-zA-Z0-9-]+)([^>]*)>$/);
		if (!open) {
			parent.children.push(token);
			continue;
		}

		const tag = open[1]?.toLowerCase();
		if (!tag) {
			parent.children.push(token);
			continue;
		}
		const node: RichTextElement = {
			tag,
			attrs: parseAttributes(open[2] ?? ""),
			children: [],
		};

		parent.children.push(node);

		if (!token.endsWith("/>") && !selfClosingTags.has(tag)) {
			stack.push(node);
		}
	}

	return root.children;
};

const getText = (part: RichTextPart): string => {
	if (typeof part === "string") return part;
	return part.children.map(getText).join("");
};

const getKey = (node: RichTextElement) =>
	`${node.tag}:${node.attrs.href ?? ""}:${getText(node)}`;

const renderPart = (part: RichTextPart): ReactNode => {
	if (typeof part === "string") return part;

	const children = part.children.map(renderPart);
	const key = getKey(part);

	switch (part.tag) {
		case "a": {
			const href = part.attrs.href ?? "#";
			const isExternal =
				href.startsWith("http://") || href.startsWith("https://");

			return (
				<a
					key={key}
					href={href}
					target={isExternal ? "_blank" : undefined}
					rel={isExternal ? "noreferrer" : undefined}
					className="font-semibold text-blue-500 transition-colors hover:text-blue-600"
				>
					{children}
				</a>
			);
		}
		case "code":
			return <code key={key}>{children}</code>;
		case "li":
			return <li key={key}>{children}</li>;
		case "ol":
			return (
				<ol key={key} className="pl-6 list-decimal">
					{children}
				</ol>
			);
		case "p":
			return <p key={key}>{children}</p>;
		case "span":
			return (
				<span key={key} className={part.attrs.className ?? part.attrs.class}>
					{children}
				</span>
			);
		case "strong":
			return <strong key={key}>{children}</strong>;
		case "ul":
			return (
				<ul key={key} className="pl-6 list-disc">
					{children}
				</ul>
			);
		default:
			return <Fragment key={key}>{children}</Fragment>;
	}
};

export const renderRichText = (content: string) =>
	parseRichText(content).map(renderPart);

export function RichText({
	content,
	className,
}: {
	content: string;
	className?: string;
}) {
	return <div className={className}>{renderRichText(content)}</div>;
}
