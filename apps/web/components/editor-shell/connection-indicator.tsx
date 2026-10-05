"use client";

import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";
import { LayoutGridIcon } from "lucide-react";
import {
	type MouseEventHandler,
	type RefObject,
	useCallback,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { HoverPrefetchLink } from "@/components/hover-prefetch-link";
import {
	EDITOR_CONNECTION_COPY,
	type EditorConnectionReport,
	editorConnectionDetail,
	editorConnectionDisplay,
	parseEditorConnectionMessage,
} from "@/lib/editor-connection";

const LEVEL_COLOR = {
	good: "var(--rec-green)",
	fair: "#d4930b",
	poor: "var(--rec-red)",
	offline: "var(--rec-text-2)",
	checking: "var(--rec-text-3)",
} as const;

const subscribeOnline = (onChange: () => void) => {
	window.addEventListener("online", onChange);
	window.addEventListener("offline", onChange);
	return () => {
		window.removeEventListener("online", onChange);
		window.removeEventListener("offline", onChange);
	};
};

function SignalBars({ level }: { level: keyof typeof LEVEL_COLOR }) {
	const { bars } = EDITOR_CONNECTION_COPY[level];
	const color = LEVEL_COLOR[level];
	return (
		<svg
			viewBox="0 0 16 16"
			className="size-4 shrink-0"
			aria-hidden="true"
			fill="none"
		>
			{[0, 1, 2].map((index) => (
				<rect
					key={index}
					x={2 + index * 4.5}
					y={10 - index * 3.5}
					width={3}
					height={4 + index * 3.5}
					rx={1}
					style={{
						fill: index < bars ? color : "var(--rec-line-strong)",
						transition: "fill 0.3s ease",
					}}
				/>
			))}
			{level === "offline" && (
				<path
					d="M2.5 2.5 13.5 13.5"
					stroke="var(--rec-red)"
					strokeWidth={1.6}
					strokeLinecap="round"
				/>
			)}
		</svg>
	);
}

/// Makes no requests of its own: the level comes from the editor frame's
/// measurements of the video it loads anyway.
export function ConnectionIndicator({
	frameRef,
	onNavigate,
}: {
	frameRef: RefObject<HTMLIFrameElement | null>;
	onNavigate?: MouseEventHandler<HTMLAnchorElement>;
}) {
	const online = useSyncExternalStore(
		subscribeOnline,
		() => navigator.onLine,
		() => true,
	);
	const [report, setReport] = useState<EditorConnectionReport | null>(null);
	const [open, setOpen] = useState(false);

	// The editor explains its waits only by the level shown here, so the two
	// never disagree; "checking" means it explains none by it.
	const tellShown = useCallback(
		(shown: ReturnType<typeof editorConnectionDisplay>) => {
			frameRef.current?.contentWindow?.postMessage(
				{
					kind: "cap-editor-connection-shown",
					version: 1,
					level: shown === "checking" ? null : shown,
				},
				window.location.origin,
			);
		},
		[frameRef],
	);

	const ask = useCallback(() => {
		frameRef.current?.contentWindow?.postMessage(
			{ kind: "cap-editor-connection-request", version: 1 },
			window.location.origin,
		);
	}, [frameRef]);

	useEffect(() => {
		const onMessage = (event: MessageEvent<unknown>) => {
			if (
				event.origin !== window.location.origin ||
				event.source !== frameRef.current?.contentWindow
			)
				return;
			const next = parseEditorConnectionMessage(event.data);
			if (!next) return;
			setReport(next);
			tellShown(editorConnectionDisplay(next, navigator.onLine));
		};
		window.addEventListener("message", onMessage);
		// The frame may have measured something before this listened.
		const frame = frameRef.current;
		frame?.addEventListener("load", ask);
		ask();
		return () => {
			window.removeEventListener("message", onMessage);
			frame?.removeEventListener("load", ask);
		};
	}, [ask, frameRef, tellShown]);

	const level = editorConnectionDisplay(report, online);
	useEffect(() => tellShown(level), [level, tellShown]);
	const copy = EDITOR_CONNECTION_COPY[level];
	const detail = level === "offline" ? null : editorConnectionDetail(report);
	const showLabel = level === "poor" || level === "offline";

	return (
		<Popover.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) ask();
			}}
		>
			<Popover.Trigger asChild>
				<button
					type="button"
					data-connection-indicator
					data-level={level}
					aria-label={`${copy.label}. Connection details and dashboard`}
					title={copy.label}
					className={clsx(
						"rec-btn is-ghost",
						showLabel ? "max-lg:w-8 max-lg:px-0 lg:px-2.5" : "is-icon",
					)}
				>
					<SignalBars level={level} />
					{showLabel && <span className="hidden lg:inline">{copy.label}</span>}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					sideOffset={6}
					align="end"
					collisionPadding={12}
					data-appearance="light"
					className="cap-rec rec-pop z-[400] flex w-[17rem] flex-col p-1 text-[13px]"
				>
					<div className="flex flex-col gap-1 px-2.5 pb-2.5 pt-2">
						<div className="flex items-center gap-2 font-medium text-[var(--rec-text-1)]">
							<SignalBars level={level} />
							{copy.title}
						</div>
						<p className="leading-[18px] text-[var(--rec-text-2)]">
							{copy.body}
						</p>
						{detail && (
							<p
								className="text-[12px] tabular-nums text-[var(--rec-text-3)]"
								title="Measured from the video the editor loads"
							>
								{detail}
							</p>
						)}
					</div>
					<div className="mx-1 h-px bg-[var(--rec-line)]" />
					<HoverPrefetchLink
						href="/dashboard/caps"
						onClick={(event) => {
							onNavigate?.(event);
							if (!event.defaultPrevented) setOpen(false);
						}}
						className="rec-focus mt-1 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[var(--rec-text-1)] hover:bg-[var(--rec-ctl-hover)]"
					>
						<LayoutGridIcon
							className="size-3.5 shrink-0 text-[var(--rec-text-2)]"
							aria-hidden
						/>
						Go to dashboard
					</HoverPrefetchLink>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
