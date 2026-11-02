import { formatHighlightTime } from "@/lib/video-highlights";

export interface HighlightTick {
	id: string;
	timestamp: number;
	label: string | null;
}

export function HighlightTicks({
	highlights,
	duration,
	onSeek,
}: {
	highlights: readonly HighlightTick[];
	duration: number;
	onSeek?: (time: number) => void;
}) {
	if (highlights.length === 0 || !(duration > 0)) return null;

	return (
		<div
			className="relative w-full h-0 pointer-events-none"
			data-highlight-ticks=""
		>
			{highlights.map((highlight) => {
				const percent = Math.min(
					100,
					Math.max(0, (highlight.timestamp / duration) * 100),
				);
				const title = `${formatHighlightTime(highlight.timestamp)} ${
					highlight.label ?? "Highlight"
				}`;
				return (
					<button
						key={highlight.id}
						type="button"
						title={title}
						aria-label={`Jump to highlight: ${title}`}
						onClick={(event) => {
							event.stopPropagation();
							onSeek?.(highlight.timestamp);
						}}
						className="group absolute bottom-1 -translate-x-1/2 pointer-events-auto flex flex-col items-center focus-visible:outline-none"
						style={{ left: `${percent}%` }}
					>
						<span className="mb-0.5 hidden max-w-[12rem] truncate rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium text-white group-hover:block group-focus-visible:block">
							{title}
						</span>
						<span className="h-3 w-1.5 rounded-sm bg-amber-400 shadow-[0_0_0_1px_rgba(0,0,0,0.35)] transition-transform group-hover:scale-y-125" />
					</button>
				);
			})}
		</div>
	);
}
