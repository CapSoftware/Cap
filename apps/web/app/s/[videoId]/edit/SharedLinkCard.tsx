"use client";

import clsx from "clsx";
import { CheckIcon, CopyIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
	title?: string;
	description: string;
	onDismiss?: () => void;
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
				"flex flex-col gap-3 rounded-2xl border border-gray-4 bg-gray-1 p-4 text-left",
				props.className,
			)}
		>
			<div className="flex items-start gap-3">
				<span className="relative mt-1 flex size-2.5 shrink-0" aria-hidden>
					<span className="absolute inset-0 animate-ping rounded-full bg-[#22B07D] opacity-50 motion-reduce:animate-none" />
					<span className="relative size-2.5 rounded-full bg-[#22B07D]" />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2 className="text-[0.9375rem] font-semibold leading-snug text-gray-12">
						{props.title ?? "Your Cap is already shared"}
					</h2>
					<p className="text-[0.8125rem] leading-snug text-gray-10">
						{props.description}
					</p>
				</div>
				{props.onDismiss && (
					<button
						type="button"
						aria-label="Dismiss"
						onClick={props.onDismiss}
						className="-m-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
					>
						<XIcon className="size-4" aria-hidden />
					</button>
				)}
			</div>
			<div className="flex items-center gap-1.5 rounded-xl border border-gray-4 bg-gray-2 p-1 pl-3">
				<input
					ref={inputRef}
					readOnly
					value={display}
					aria-label="Share link"
					onFocus={(event) => event.currentTarget.select()}
					className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-gray-12 outline-none"
				/>
				<button
					type="button"
					onClick={() => void copy()}
					className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-blue-9 px-3 text-[0.8125rem] font-medium text-white transition-colors hover:bg-blue-10"
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
				className="inline-flex items-center gap-1.5 self-start text-[0.8125rem] font-medium text-blue-11 hover:text-blue-12"
			>
				Open share page
				<ExternalLinkIcon className="size-3.5" aria-hidden />
			</a>
		</section>
	);
}
