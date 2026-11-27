import type { VideoNoteTranscriptTurn } from "@cap/database/schema";

const formatTurnTime = (startMs: number) => {
	const total = Math.max(0, Math.floor(startMs / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const pad = (value: number) => String(value).padStart(2, "0");
	return hours > 0
		? `${hours}:${pad(minutes)}:${pad(seconds)}`
		: `${pad(minutes)}:${pad(seconds)}`;
};

export function NoteTranscript({
	turns,
}: {
	turns: VideoNoteTranscriptTurn[];
}) {
	const rows = turns.map((turn, position) => ({
		...turn,
		id: `${turn.startMs}:${position}`,
	}));

	return (
		<ol className="flex flex-col gap-4 px-4 py-4">
			{rows.map((row) => (
				<li key={row.id} className="flex flex-col gap-0.5 min-w-0">
					<p className="flex gap-2 items-baseline">
						<span className="text-[13px] font-medium truncate text-gray-12">
							{row.speaker}
						</span>
						<span className="font-mono text-[10px] tabular-nums text-gray-8 shrink-0">
							{formatTurnTime(row.startMs)}
						</span>
					</p>
					<p className="text-[13px] leading-[22px] text-gray-11 [overflow-wrap:anywhere]">
						{row.text}
					</p>
				</li>
			))}
		</ol>
	);
}
