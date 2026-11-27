"use client";

import clsx from "clsx";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recorder.css";

export function useShareLink(videoId: string) {
	const path = `/s/${encodeURIComponent(videoId)}`;
	const [href, setHref] = useState(path);
	useEffect(() => {
		setHref(new URL(path, window.location.origin).toString());
	}, [path]);
	const display = href.replace(/^https?:\/\//, "");
	return { path, href, display };
}

export function SharedLinkCard(props: {
	videoId: string;
	title: string;
	description: string;
	className?: string;
}) {
	const { path, href, display } = useShareLink(props.videoId);
	const [copied, setCopied] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const resetRef = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (resetRef.current !== null) window.clearTimeout(resetRef.current);
		},
		[],
	);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(href);
		} catch {
			inputRef.current?.select();
			return;
		}
		setCopied(true);
		if (resetRef.current !== null) window.clearTimeout(resetRef.current);
		resetRef.current = window.setTimeout(() => setCopied(false), 2000);
	};

	return (
		<section
			aria-label="Share link"
			className={clsx(
				"cap-rec rec-pop flex flex-col gap-3 p-4 text-left",
				props.className,
			)}
		>
			<div className="flex items-start gap-3">
				<span className="relative mt-1 flex size-2.5 shrink-0" aria-hidden>
					<span className="absolute inset-0 animate-ping rounded-full bg-[var(--rec-green)] opacity-50 motion-reduce:animate-none" />
					<span className="relative size-2.5 rounded-full bg-[var(--rec-green)]" />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2 className="text-[14px] font-medium leading-snug text-[var(--rec-text-1)]">
						{props.title}
					</h2>
					<p className="text-[13px] leading-snug text-[var(--rec-text-2)]">
						{props.description}
					</p>
				</div>
			</div>
			<div className="flex items-center gap-1.5 rounded-[10px] bg-[var(--rec-ctl)] p-1 pl-3">
				<input
					ref={inputRef}
					readOnly
					value={display}
					aria-label="Share link"
					onFocus={(event) => event.currentTarget.select()}
					className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--rec-text-1)] outline-none"
				/>
				<button
					type="button"
					onClick={() => void copy()}
					className="rec-btn is-accent !h-7 !px-2.5 !text-[12px]"
				>
					{copied ? (
						<CheckIcon className="size-3.5" aria-hidden />
					) : (
						<CopyIcon className="size-3.5" aria-hidden />
					)}
					{copied ? "Copied" : "Copy link"}
				</button>
			</div>
			<a
				href={path}
				target="_blank"
				rel="noopener noreferrer"
				className="inline-flex items-center gap-1.5 self-start text-[13px] font-medium text-[var(--rec-accent)] hover:underline"
			>
				Open share page
				<ExternalLinkIcon className="size-3.5" aria-hidden />
			</a>
		</section>
	);
}
