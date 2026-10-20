import clsx from "clsx";
import { Lock } from "lucide-react";

const COLUMNS = [
	{
		title: "Now",
		x: 16,
		cards: [
			{ y: 50, tag: "var(--ob-green)", line: 52 },
			{ y: 84, tag: "var(--ob-green)", line: 38 },
		],
	},
	{
		title: "Next",
		x: 117,
		cards: [
			{ y: 50, tag: "var(--ob-accent)", line: 46 },
			{ y: 84, tag: "var(--ob-accent)", line: 56 },
			{ y: 118, tag: "var(--ob-accent)", line: 30 },
		],
	},
	{
		title: "Later",
		x: 218,
		cards: [{ y: 50, tag: "var(--ob-camera)", line: 42 }],
	},
] as const;

const CARD_WIDTH = 86;
const CARD_HEIGHT = 26;

const Recording = () => (
	<svg
		viewBox="0 0 320 180"
		className="absolute inset-0 size-full"
		aria-hidden="true"
	>
		<rect width="320" height="180" fill="var(--ob-surface)" />
		<text x="16" y="25" fontSize="10.5" fontWeight="500" className="ob-label">
			Roadmap
		</text>
		<circle cx="288" cy="21" r="5.5" fill="var(--ob-team-2)" />
		<circle cx="300" cy="21" r="5.5" fill="var(--ob-team-1)" />
		{COLUMNS.map((column) => (
			<text
				key={column.title}
				x={column.x + 2}
				y="42"
				fontSize="8"
				fontWeight="500"
				className="ob-label is-soft"
			>
				{column.title}
				<tspan className="ob-label is-faint"> {column.cards.length}</tspan>
			</text>
		))}
		<g className="ob-boil">
			{COLUMNS.flatMap((column) =>
				column.cards.map((card) => (
					<g key={`${column.title}-${card.y}`}>
						<rect
							x={column.x}
							y={card.y}
							width={CARD_WIDTH}
							height={CARD_HEIGHT}
							rx="6"
							fill="var(--ob-surface)"
							stroke="var(--ob-track-strong)"
							strokeWidth="1.5"
						/>
						<path
							d={`M ${column.x + 8} ${card.y + 9} L ${column.x + 20} ${card.y + 9}`}
							stroke={card.tag}
							strokeWidth="3"
							strokeLinecap="round"
						/>
						<path
							d={`M ${column.x + 8} ${card.y + 18} L ${column.x + 8 + card.line} ${card.y + 18}`}
							stroke="var(--ob-ink-faint)"
							strokeWidth="2.2"
							strokeLinecap="round"
						/>
					</g>
				)),
			)}
			<path
				pathLength={1}
				className="ob-ink is-accent ob-pv-circle"
				style={{ strokeWidth: 2.2 }}
				d="M 110 90 C 116 75 196 72 208 89 C 218 104 192 117 158 117 C 124 117 104 108 108 95"
			/>
		</g>
		<g className="ob-pv-cursor">
			<path
				d="M 0 0 L 0 13 L 3.4 9.8 L 5.8 15 L 7.9 14.1 L 5.6 9 L 9.9 8.7 Z"
				fill="var(--ob-ink)"
				stroke="var(--ob-surface)"
				strokeWidth="1.1"
				strokeLinejoin="round"
			/>
		</g>
	</svg>
);

const Webcam = () => (
	<span className="ob-pv-cam absolute bottom-[40px] right-3 flex aspect-square w-[19%] items-end justify-center overflow-hidden rounded-full border-2 border-[var(--ob-surface)] bg-[color-mix(in_srgb,var(--ob-camera)_22%,var(--ob-paper-2))] shadow-[0_6px_16px_-8px_var(--ob-shadow)]">
		<svg viewBox="0 0 40 40" className="h-[86%] w-[86%]" aria-hidden="true">
			<circle
				cx="20"
				cy="16"
				r="7.5"
				fill="color-mix(in srgb, var(--ob-camera) 55%, var(--ob-surface))"
			/>
			<path
				d="M 5 40 C 5 30 11 25.5 20 25.5 C 29 25.5 35 30 35 40 Z"
				fill="color-mix(in srgb, var(--ob-camera) 55%, var(--ob-surface))"
			/>
		</svg>
	</span>
);

export const SharePreview = ({ name }: { name: string }) => {
	const trimmed = name.trim();
	const initial = trimmed.charAt(0).toUpperCase();

	return (
		<figure className="ob-rise mx-auto w-full max-w-[460px]">
			<div className="overflow-hidden rounded-[18px] border-[1.5px] border-[var(--ob-track)] bg-[var(--ob-surface)] shadow-[0_40px_80px_-52px_var(--ob-shadow)]">
				<div className="flex items-center gap-3 border-b-[1.5px] border-[var(--ob-track)] px-3.5 py-2.5">
					<span className="flex shrink-0 gap-1.5" aria-hidden="true">
						<span className="size-2 rounded-full bg-[var(--ob-track-strong)]" />
						<span className="size-2 rounded-full bg-[var(--ob-track-strong)]" />
						<span className="size-2 rounded-full bg-[var(--ob-track-strong)]" />
					</span>
					<span className="flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full bg-[var(--ob-paper-2)] px-3 text-[12px] text-[var(--ob-ink-soft)]">
						<Lock className="size-3 shrink-0" aria-hidden />
						<span className="truncate">cap.link/m4k2p9x</span>
					</span>
					<span className="w-[42px] shrink-0" aria-hidden="true" />
				</div>
				<div className="p-4 sm:p-5">
					<div className="flex items-start justify-between gap-3">
						<p className="min-w-0 truncate text-[16px] font-medium tracking-[-0.01em] text-[var(--ob-ink)] sm:text-[17px]">
							Q3 roadmap walkthrough
						</p>
						<span className="flex h-7 shrink-0 items-center rounded-full border-[1.5px] border-[var(--ob-track)] px-2.5 text-[11.5px] font-medium text-[var(--ob-ink-2)]">
							Copy link
						</span>
					</div>
					<div className="mt-2.5 flex items-center gap-2.5">
						<span
							className={clsx(
								"flex size-8 shrink-0 items-center justify-center rounded-full text-[14px] font-medium transition-colors duration-300",
								initial
									? "bg-[var(--ob-accent)] text-white"
									: "bg-[var(--ob-paper-2)] text-[var(--ob-ink-faint)]",
							)}
						>
							<span key={initial} className="ob-fade">
								{initial || "?"}
							</span>
						</span>
						<div className="min-w-0 leading-tight">
							<p
								className={clsx(
									"truncate text-[13.5px] transition-colors",
									trimmed
										? "text-[var(--ob-ink)]"
										: "text-[var(--ob-ink-faint)]",
								)}
							>
								{trimmed || "Your name"}
							</p>
							<p className="mt-0.5 truncate text-[12px] text-[var(--ob-ink-soft)]">
								just now
							</p>
						</div>
					</div>
					<div className="relative mt-4 aspect-video overflow-hidden rounded-xl border-[1.5px] border-[var(--ob-track)]">
						<Recording />
						<Webcam />
						<div className="absolute inset-x-0 bottom-0 flex h-[30px] items-center gap-2.5 border-t-[1.5px] border-[var(--ob-track)] bg-[var(--ob-surface)] px-3">
							<span className="flex shrink-0 gap-[3px]" aria-hidden="true">
								<span className="h-2.5 w-[3px] rounded-full bg-[var(--ob-ink)]" />
								<span className="h-2.5 w-[3px] rounded-full bg-[var(--ob-ink)]" />
							</span>
							<span className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--ob-track)]">
								<span className="ob-pv-progress absolute inset-0 rounded-full bg-[var(--ob-accent)]" />
							</span>
							<span className="shrink-0 text-[10.5px] tabular-nums text-[var(--ob-ink-soft)]">
								2:14
							</span>
						</div>
					</div>
				</div>
			</div>
			<figcaption className="mt-4 text-center text-[13.5px] text-[var(--ob-ink-soft)]">
				This is what people see when you send them a Cap.
			</figcaption>
		</figure>
	);
};
