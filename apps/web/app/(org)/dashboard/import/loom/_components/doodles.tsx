"use client";

import clsx from "clsx";
import {
	type CSSProperties,
	type ReactNode,
	useId,
	useSyncExternalStore,
} from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
	const query = window.matchMedia(REDUCED_MOTION_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

export function useReducedMotion() {
	return useSyncExternalStore(
		subscribeReducedMotion,
		() => window.matchMedia(REDUCED_MOTION_QUERY).matches,
		() => false,
	);
}

export const delay = (seconds: number) =>
	({ "--d": `${seconds}s` }) as CSSProperties;

export const Boil = ({
	children,
	scale = 2.4,
}: {
	children: ReactNode;
	scale?: number;
}) => {
	const id = `li-boil-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	const reducedMotion = useReducedMotion();
	return (
		<>
			<defs>
				<filter id={id} x="-15%" y="-15%" width="130%" height="130%">
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.05"
						numOctaves={2}
						seed={1}
						result="noise"
					>
						{!reducedMotion && (
							<animate
								attributeName="seed"
								values="1;3;5;7"
								dur="0.6s"
								repeatCount="indefinite"
								calcMode="discrete"
							/>
						)}
					</feTurbulence>
					<feDisplacementMap
						in="SourceGraphic"
						in2="noise"
						scale={scale}
						xChannelSelector="R"
						yChannelSelector="G"
					/>
				</filter>
			</defs>
			<g style={{ filter: `url(#${id})` }}>{children}</g>
		</>
	);
};

const Sparks = ({ at = 0.6 }: { at?: number }) => (
	<>
		<path
			className="li-spark"
			style={delay(at)}
			d="M 22 14 L 22 20 M 22 28 L 22 34 M 12 24 L 18 24 M 26 24 L 32 24"
		/>
		<path
			className="li-spark"
			style={delay(at + 0.15)}
			d="M 98 6 L 98 12 M 98 20 L 98 26 M 88 16 L 94 16 M 102 16 L 108 16"
		/>
		<path
			className="li-spark"
			style={delay(at + 0.3)}
			d="M 104 60 L 104 65 M 104 71 L 104 76 M 96 68 L 101 68 M 107 68 L 112 68"
		/>
	</>
);

const SHEET = "M 34 10 L 70 10 L 86 26 L 86 82 L 34 82 Z";
const SHEET_FOLD = "M 70 10 L 70 26 L 86 26";

export type DoodleKind =
	| "sheet"
	| "drop"
	| "move"
	| "check"
	| "magnify"
	| "done"
	| "error"
	| "unlock"
	| "watch"
	| "stop";

export const Doodle = ({
	kind,
	className,
}: {
	kind: DoodleKind;
	className?: string;
}) => (
	<svg
		key={kind}
		viewBox="0 0 120 96"
		className={clsx("h-auto overflow-visible", className ?? "w-28")}
		aria-hidden="true"
	>
		<Boil>
			{kind === "sheet" && (
				<>
					<path className="li-ink li-draw" pathLength={1} d={SHEET} />
					<path
						className="li-ink li-draw"
						pathLength={1}
						style={delay(0.35)}
						d={SHEET_FOLD}
					/>
					{[40, 52, 64].map((y, index) => (
						<path
							key={y}
							className="li-ink is-thin is-soft li-draw"
							pathLength={1}
							style={delay(0.5 + index * 0.12)}
							d={`M 44 ${y} L 76 ${y}`}
						/>
					))}
					<path
						className="li-ink is-thin is-accent li-draw"
						pathLength={1}
						style={delay(0.9)}
						d="M 44 40 L 56 40 M 44 52 L 56 52 M 44 64 L 56 64"
					/>
				</>
			)}
			{kind === "drop" && (
				<>
					<path
						className="li-ink li-draw"
						pathLength={1}
						d="M 14 60 L 14 84 L 106 84 L 106 60"
					/>
					<g className="li-bob">
						<path
							className="li-ink li-draw"
							pathLength={1}
							style={delay(0.3)}
							d="M 42 6 L 68 6 L 80 18 L 80 52 L 42 52 Z"
						/>
						<path
							className="li-ink is-thin is-soft li-draw"
							pathLength={1}
							style={delay(0.6)}
							d="M 50 26 L 72 26 M 50 34 L 72 34 M 50 42 L 64 42"
						/>
					</g>
					<path
						className="li-ink is-accent li-fade"
						style={delay(0.8)}
						d="M 60 60 L 60 76 M 52 69 L 60 77 L 68 69"
					/>
				</>
			)}
			{kind === "move" && (
				<>
					<circle
						className="li-ink is-loom li-draw"
						pathLength={1}
						cx="22"
						cy="48"
						r="13"
					/>
					<path
						className="li-ink is-thin is-loom li-fade"
						style={delay(0.4)}
						d="M 22 39 L 22 57 M 13 48 L 31 48 M 15.6 41.6 L 28.4 54.4 M 28.4 41.6 L 15.6 54.4"
					/>
					<path
						className="li-ink is-soft li-march"
						d="M 38 46 C 52 22 68 22 82 44"
					/>
					<path
						className="li-ink li-draw"
						pathLength={1}
						style={delay(0.3)}
						d="M 84 40 L 84 70 L 112 70 L 112 46 L 100 46 L 96 40 Z"
					/>
					<path
						className="li-ink is-accent li-draw"
						pathLength={1}
						style={delay(0.9)}
						d="M 91 57 L 96 62 L 105 52"
					/>
				</>
			)}
			{kind === "check" &&
				[18, 42, 66].map((y, index) => (
					<g key={y}>
						<rect
							className="li-ink is-thin li-draw"
							pathLength={1}
							style={delay(index * 0.18)}
							x="14"
							y={y - 8}
							width="22"
							height="16"
							rx="3"
						/>
						<path
							className="li-ink is-thin is-soft li-draw"
							pathLength={1}
							style={delay(0.2 + index * 0.18)}
							d={`M 44 ${y} L 84 ${y}`}
						/>
						<path
							className="li-ink is-green li-draw"
							pathLength={1}
							style={delay(0.7 + index * 0.25)}
							d={`M 92 ${y} L 97 ${y + 5} L 106 ${y - 5}`}
						/>
					</g>
				))}
			{kind === "magnify" && (
				<>
					{[22, 40, 58, 76].map((y, index) => (
						<path
							key={y}
							className="li-ink is-thin is-soft li-draw"
							pathLength={1}
							style={delay(index * 0.1)}
							d={`M 16 ${y} L ${index % 2 ? 84 : 100} ${y}`}
						/>
					))}
					<g>
						<animateTransform
							attributeName="transform"
							type="translate"
							values="0 0; 34 10; 8 30; 0 0"
							dur="4.2s"
							repeatCount="indefinite"
							calcMode="spline"
							keySplines="0.45 0 0.55 1; 0.45 0 0.55 1; 0.45 0 0.55 1"
						/>
						<circle
							className="li-ink is-accent"
							cx="44"
							cy="34"
							r="14"
							style={{ fill: "var(--li-paper)", fillOpacity: 0.7 }}
						/>
						<path className="li-ink is-accent" d="M 54 44 L 66 56" />
					</g>
				</>
			)}
			{kind === "done" && (
				<>
					<path
						className="li-ink is-green li-draw"
						pathLength={1}
						style={{ ...delay(0.05), strokeWidth: 3 }}
						d="M 34 52 L 52 70 L 90 26"
					/>
					<Sparks />
				</>
			)}
			{kind === "error" && (
				<>
					<circle
						className="li-ink is-red li-draw"
						pathLength={1}
						cx="60"
						cy="48"
						r="30"
					/>
					<path
						className="li-ink is-red li-draw"
						pathLength={1}
						style={delay(0.5)}
						d="M 60 32 L 60 52 M 60 63 L 60 63.4"
					/>
				</>
			)}
			{kind === "stop" && (
				<>
					<circle
						className="li-ink is-soft li-draw"
						pathLength={1}
						cx="60"
						cy="48"
						r="30"
					/>
					<path
						className="li-ink li-draw"
						pathLength={1}
						style={delay(0.4)}
						d="M 50 38 L 50 58 M 70 38 L 70 58"
					/>
				</>
			)}
			{kind === "unlock" && (
				<>
					<rect
						className="li-ink is-thin is-soft li-draw"
						pathLength={1}
						x="10"
						y="30"
						width="56"
						height="38"
						rx="6"
					/>
					<rect
						className="li-ink is-thin li-draw"
						pathLength={1}
						style={delay(0.15)}
						x="18"
						y="40"
						width="56"
						height="38"
						rx="6"
						fill="var(--li-paper)"
					/>
					<path
						className="li-ink is-thin is-accent li-draw"
						pathLength={1}
						style={delay(0.45)}
						d="M 41 51 L 41 67 L 54 59 Z"
					/>
					<rect
						className="li-ink li-draw"
						pathLength={1}
						style={delay(0.3)}
						x="80"
						y="46"
						width="28"
						height="24"
						rx="5"
					/>
					<g className="li-fade" style={delay(0.7)}>
						<path className="li-ink" d="M 87 46 L 87 37 C 87 29 101 29 101 37">
							<animateTransform
								attributeName="transform"
								type="translate"
								values="0 0; 0 -7; 0 -7"
								keyTimes="0; 0.4; 1"
								dur="2.4s"
								begin="1s"
								fill="freeze"
							/>
						</path>
					</g>
					<path
						className="li-ink is-thin li-draw"
						pathLength={1}
						style={delay(0.6)}
						d="M 94 55 L 94 61"
					/>
					<Sparks at={1.6} />
				</>
			)}
			{kind === "watch" && (
				<>
					<rect
						className="li-ink li-draw"
						pathLength={1}
						x="16"
						y="14"
						width="66"
						height="46"
						rx="7"
					/>
					<path
						className="li-ink is-accent li-draw"
						pathLength={1}
						style={delay(0.4)}
						d="M 43 28 L 43 46 L 58 37 Z"
					/>
					{[70, 80].map((y, index) => (
						<path
							key={y}
							className="li-ink is-thin is-soft li-draw"
							pathLength={1}
							style={delay(0.8 + index * 0.2)}
							d={`M 16 ${y} L ${index ? 62 : 82} ${y}`}
						/>
					))}
					<Sparks at={1.1} />
				</>
			)}
		</Boil>
	</svg>
);

const SQUIGGLE =
	"M 4 14 q 6 -7 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0";

export const Squiggle = ({
	progress,
	done = false,
	className,
}: {
	progress: number | null;
	done?: boolean;
	className?: string;
}) => (
	<svg
		viewBox="0 0 608 26"
		className={clsx("h-auto w-full overflow-visible", className)}
		aria-hidden="true"
	>
		<path className="li-squiggle-track" pathLength={100} d={SQUIGGLE} />
		<path
			className={clsx(
				"li-squiggle-fill",
				progress === null && "is-waiting",
				done && "is-done",
			)}
			pathLength={100}
			d={SQUIGGLE}
			style={
				progress === null
					? undefined
					: {
							strokeDashoffset:
								100 -
								Math.max(0, Math.min(100, Math.round(progress * 1000) / 10)),
						}
			}
		/>
	</svg>
);

export const StepMark = ({ value }: { value: number }) => (
	<svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden="true">
		<Boil scale={1.8}>
			<circle className="li-ink is-thin" cx="16" cy="16" r="12" />
		</Boil>
		<text
			x="16"
			y="20.5"
			textAnchor="middle"
			fontSize="13"
			fontWeight="500"
			fill="var(--li-ink)"
			fontFamily="inherit"
		>
			{value}
		</text>
	</svg>
);

export const InkArrow = ({ className }: { className?: string }) => (
	<svg
		viewBox="0 0 64 24"
		className={clsx("h-5 w-14 overflow-visible", className)}
		aria-hidden="true"
	>
		<Boil scale={1.6}>
			<path
				className="li-ink is-thin is-soft li-draw"
				pathLength={1}
				d="M 4 16 C 20 4 38 4 56 12 M 48 6 L 57 12 L 49 18"
			/>
		</Boil>
	</svg>
);

export const LoomMark = ({ size = 18 }: { size?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		role="img"
		aria-label="Loom"
	>
		<path
			fill="#625DF5"
			d="M15 7.222h-4.094l3.546-2.047-.779-1.35-3.545 2.048 2.046-3.546-1.349-.779L8.78 5.093V1H7.22v4.094L5.174 1.548l-1.348.779 2.046 3.545-3.545-2.046-.779 1.348 3.546 2.047H1v1.557h4.093l-3.545 2.047.779 1.35 3.545-2.047-2.047 3.545 1.35.779 2.046-3.546V15h1.557v-4.094l2.047 3.546 1.349-.779-2.047-3.546 3.545 2.047.779-1.349-3.545-2.046h4.093L15 7.222zm-7 2.896a2.126 2.126 0 110-4.252 2.126 2.126 0 010 4.252z"
		/>
	</svg>
);
