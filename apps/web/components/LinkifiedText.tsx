"use client";

import { buildEnv } from "@cap/env";
import {
	Button,
	buttonVariants,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@cap/ui";
import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { type ReactNode, useState } from "react";

const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>]+/gi;

const CAP_HOSTS = ["cap.so", "cap.link"];
const CLOSING_BRACKETS: Record<string, string> = {
	")": "(",
	"]": "[",
	"}": "{",
};
const OPENING_BRACKETS = new Set(Object.values(CLOSING_BRACKETS));

function hostnameOf(value: string): string | null {
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return null;
	}
}

const TRUSTED_HOSTS: ReadonlySet<string> = (() => {
	const hosts = new Set(CAP_HOSTS);
	const webHost = hostnameOf(buildEnv.NEXT_PUBLIC_WEB_URL);
	if (webHost) hosts.add(webHost);
	return hosts;
})();

function isTrustedHref(href: string): boolean {
	const host = hostnameOf(href);
	if (!host) return false;
	for (const trusted of TRUSTED_HOSTS) {
		if (host === trusted || host.endsWith(`.${trusted}`)) return true;
	}
	return false;
}

function splitTrailingPunctuation(token: string): [string, string] {
	const openCounts = new Map<string, number>();
	const closeCounts = new Map<string, number>();

	for (const char of token) {
		const open = CLOSING_BRACKETS[char];
		if (open) {
			closeCounts.set(char, (closeCounts.get(char) ?? 0) + 1);
		} else if (OPENING_BRACKETS.has(char)) {
			openCounts.set(char, (openCounts.get(char) ?? 0) + 1);
		}
	}

	let end = token.length;
	while (end > 0) {
		const char = token.charAt(end - 1);
		if (".,;:!?\u2026\"'".includes(char)) {
			end -= 1;
			continue;
		}
		const open = CLOSING_BRACKETS[char];
		if (open) {
			if ((closeCounts.get(char) ?? 0) > (openCounts.get(open) ?? 0)) {
				closeCounts.set(char, (closeCounts.get(char) ?? 0) - 1);
				end -= 1;
				continue;
			}
		}
		break;
	}
	return [token.slice(0, end), token.slice(end)];
}

function safeHttpsHref(candidate: string): string | null {
	const normalized = /^www\./i.test(candidate)
		? `https://${candidate}`
		: candidate;
	try {
		const url = new URL(normalized);
		if (url.protocol !== "https:") return null;
		if (url.username || url.password) return null;
		return url.toString();
	} catch {
		return null;
	}
}

function ExternalLinkWarning({
	href,
	className,
	children,
}: {
	href: string;
	className?: string;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const host = hostnameOf(href) ?? href;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={`${className ?? ""} inline border-0 bg-transparent p-0 text-left`}
					onClick={(event) => {
						event.preventDefault();
						setOpen((value) => !value);
					}}
				>
					{children}
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				sideOffset={6}
				className="z-[60] p-3 w-72 border shadow-lg bg-gray-2 border-gray-4"
			>
				<div className="flex gap-2.5 items-start">
					<FontAwesomeIcon
						icon={faTriangleExclamation}
						className="mt-0.5 text-amber-500 size-3.5 shrink-0"
					/>
					<div className="min-w-0">
						<p className="text-sm font-medium leading-tight text-gray-12">
							This link leads outside Cap
						</p>
						<p className="mt-1 text-xs font-medium break-all text-gray-11">
							{host}
						</p>
						<p className="mt-1 text-[11px] leading-snug break-all line-clamp-3 text-gray-10">
							{href}
						</p>
					</div>
				</div>
				<div className="flex gap-2 items-center mt-3">
					<a
						href={href}
						target="_blank"
						rel="noopener noreferrer nofollow ugc"
						referrerPolicy="no-referrer"
						onClick={() => setOpen(false)}
						className={buttonVariants({ variant: "primary", size: "xs" })}
					>
						Go to link
					</a>
					<Button
						type="button"
						size="xs"
						variant="white"
						onClick={() => setOpen(false)}
					>
						Cancel
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

const DEFAULT_LINK_CLASS =
	"font-medium text-blue-500 underline underline-offset-2 break-all transition-colors hover:text-blue-600";

export function LinkifiedText({
	text,
	linkClassName = DEFAULT_LINK_CLASS,
}: {
	text: string;
	linkClassName?: string;
}) {
	if (!text) return null;

	const nodes: ReactNode[] = [];
	const regex = new RegExp(URL_REGEX.source, "gi");
	let lastIndex = 0;
	let match = regex.exec(text);

	while (match !== null) {
		const matched = match[0];
		const start = match.index;
		const [core, trailing] = splitTrailingPunctuation(matched);
		const href = safeHttpsHref(core);

		if (start > lastIndex) nodes.push(text.slice(lastIndex, start));

		if (href && isTrustedHref(href)) {
			nodes.push(
				<a
					key={`lt-${start}`}
					href={href}
					target="_blank"
					rel="noopener noreferrer nofollow ugc"
					referrerPolicy="no-referrer"
					className={linkClassName}
				>
					{core}
				</a>,
			);
		} else if (href) {
			nodes.push(
				<ExternalLinkWarning
					key={`lt-${start}`}
					href={href}
					className={linkClassName}
				>
					{core}
				</ExternalLinkWarning>,
			);
		} else {
			nodes.push(core);
		}

		if (trailing) nodes.push(trailing);
		lastIndex = start + matched.length;
		match = regex.exec(text);
	}

	if (lastIndex < text.length) nodes.push(text.slice(lastIndex));

	return <>{nodes}</>;
}
