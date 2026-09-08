"use client";

import type { RecordIntentKind } from "../timeline/TimelineComposer";

/**
 * The three media reply kinds, shared by every composer that offers them
 * (sidebar, reaction bar, timeline) so the icons and ordering never drift.
 */
export const RECORD_OPTIONS: { kind: RecordIntentKind; label: string }[] = [
	{ kind: "screen", label: "Record screen" },
	{ kind: "camera", label: "Record camera" },
	{ kind: "voice", label: "Record voice note" },
];

export function RecordIcon({ kind }: { kind: RecordIntentKind }) {
	if (kind === "voice") {
		return (
			<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
				<title>Voice</title>
				<path d="M8 2a2 2 0 0 0-2 2v4a2 2 0 1 0 4 0V4a2 2 0 0 0-2-2ZM4.4 7.4a.6.6 0 0 0-1.2 0 4.8 4.8 0 0 0 4.2 4.76V13.4H5.8a.6.6 0 1 0 0 1.2h4.4a.6.6 0 1 0 0-1.2H8.6v-1.24a4.8 4.8 0 0 0 4.2-4.76.6.6 0 1 0-1.2 0 3.6 3.6 0 1 1-7.2 0Z" />
			</svg>
		);
	}
	if (kind === "camera") {
		return (
			<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
				<title>Camera</title>
				<path d="M2.5 4A1.5 1.5 0 0 0 1 5.5v5A1.5 1.5 0 0 0 2.5 12h6A1.5 1.5 0 0 0 10 10.5v-5A1.5 1.5 0 0 0 8.5 4h-6Zm9.2 2.4 2.6-1.5c.3-.2.7 0 .7.4v5.4c0 .4-.4.6-.7.4l-2.6-1.5V6.4Z" />
			</svg>
		);
	}
	return (
		<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
			<title>Screen</title>
			<path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm3.2 9.4h5.6a.6.6 0 1 1 0 1.2H5.2a.6.6 0 1 1 0-1.2Z" />
		</svg>
	);
}

/**
 * One icon button per media reply kind, styled for a light composer row.
 * `onPointerDown` preventDefault belongs on the caller's row when the buttons
 * sit next to a focused input (a blur-first would unmount them mid-click).
 */
export function RecordActionButtons({
	disabled,
	onSelect,
}: {
	disabled?: boolean;
	onSelect: (kind: RecordIntentKind) => void;
}) {
	return (
		<>
			{RECORD_OPTIONS.map((option) => (
				<button
					key={option.kind}
					type="button"
					aria-label={option.label}
					title={option.label}
					disabled={disabled}
					onClick={() => onSelect(option.kind)}
					className="flex size-8 items-center justify-center rounded-lg text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 disabled:opacity-50"
				>
					<RecordIcon kind={option.kind} />
				</button>
			))}
		</>
	);
}
