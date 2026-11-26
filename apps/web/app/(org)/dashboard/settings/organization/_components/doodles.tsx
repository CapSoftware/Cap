import type { CSSProperties, ReactNode } from "react";
import styles from "./doodles.module.css";

const BOIL_FILTER_ID = "settings-doodle-boil";
const STROKE = 3;

export const doodleHost = styles.host;

const timing = (delay: number, duration?: number) =>
	({
		"--d": `${delay}s`,
		...(duration === undefined ? {} : { "--t": `${duration}s` }),
	}) as CSSProperties;

const cx = (...names: (string | false | null | undefined)[]) =>
	names.filter(Boolean).join(" ");

export function DoodleFilters() {
	return (
		<svg
			aria-hidden="true"
			width="0"
			height="0"
			style={{ position: "absolute", width: 0, height: 0 }}
		>
			<defs>
				<filter
					id={BOIL_FILTER_ID}
					x="-20%"
					y="-20%"
					width="140%"
					height="140%"
				>
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.09"
						numOctaves="2"
						seed="1"
						result="noise"
					>
						<animate
							attributeName="seed"
							values="1;3;5;7"
							dur="0.6s"
							repeatCount="indefinite"
							calcMode="discrete"
						/>
					</feTurbulence>
					<feDisplacementMap
						in="SourceGraphic"
						in2="noise"
						scale="1.6"
						xChannelSelector="R"
						yChannelSelector="G"
					/>
				</filter>
			</defs>
		</svg>
	);
}

function Frame({
	children,
	size = 28,
	viewBox = "0 0 48 48",
	width,
	className,
}: {
	children: ReactNode;
	size?: number;
	viewBox?: string;
	width?: number;
	className?: string;
}) {
	return (
		<svg
			className={cx(styles.doodle, className)}
			width={width ?? size}
			height={size}
			viewBox={viewBox}
			aria-hidden="true"
		>
			<g className={styles.boil}>{children}</g>
		</svg>
	);
}

export function PlanDoodle({ size }: { size?: number }) {
	return (
		<Frame size={size}>
			<g className={styles.hop}>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.8)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 9 11 L 39 11 Q 43 11 43 15 L 43 33 Q 43 37 39 37 L 9 37 Q 5 37 5 33 L 5 15 Q 5 11 9 11 Z"
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.6, 0.3)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 5.5 20 L 42.5 19.5"
				/>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(0.85, 0.3)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 11.5 29.5 L 21 29"
				/>
				<circle
					className={cx(styles.accentFill, styles.pop)}
					style={timing(1.05)}
					cx="35.5"
					cy="29.5"
					r="2.6"
				/>
			</g>
		</Frame>
	);
}

export function SeatsDoodle({ size }: { size?: number }) {
	return (
		<Frame size={size}>
			<g className={styles.hop}>
				<circle
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.5)}
					strokeWidth={STROKE}
					pathLength={1}
					cx="18"
					cy="15"
					r="6.5"
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.45, 0.5)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 6 39.5 Q 6 26.5 18 26.5 Q 30 26.5 30 39.5"
				/>
				<circle
					className={cx(styles.accent, styles.draw)}
					style={timing(0.85, 0.35)}
					strokeWidth={STROKE}
					pathLength={1}
					cx="34.5"
					cy="18.5"
					r="5"
				/>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(1.1, 0.3)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 35.5 28 Q 43.5 29.5 43.5 39.5"
				/>
			</g>
		</Frame>
	);
}

export function KeyDoodle({ size }: { size?: number }) {
	return (
		<Frame size={size}>
			<g className={styles.wiggle}>
				<circle
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.6)}
					strokeWidth={STROKE}
					pathLength={1}
					cx="15"
					cy="24"
					r="9.5"
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.5, 0.4)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 24.5 24 L 43.5 24.5"
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.8, 0.3)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 35.5 24.5 L 35.5 32 M 42.5 24.5 L 42.5 30"
				/>
				<circle
					className={cx(styles.accentFill, styles.pop)}
					style={timing(0.95)}
					cx="15"
					cy="24"
					r="3.4"
				/>
			</g>
		</Frame>
	);
}

export function DirectoryDoodle({ size }: { size?: number }) {
	return (
		<Frame size={size}>
			<circle
				className={cx(styles.ink, styles.draw)}
				style={timing(0.05, 0.5)}
				strokeWidth={STROKE}
				pathLength={1}
				cx="16.5"
				cy="15.5"
				r="6.5"
			/>
			<path
				className={cx(styles.ink, styles.draw)}
				style={timing(0.45, 0.5)}
				strokeWidth={STROKE}
				pathLength={1}
				d="M 4.5 39 Q 4.5 26.5 16.5 26.5 Q 28.5 26.5 28.5 39"
			/>
			<g className={styles.spin}>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(0.85, 0.35)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 32 20.5 Q 38 13.5 44 20 M 44.5 14 L 44 20 L 38.5 19.5"
				/>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(1.1, 0.35)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 44 28.5 Q 38 35.5 32 29 M 31.5 35 L 32 29 L 37.5 29.5"
				/>
			</g>
		</Frame>
	);
}

export function AgreementDoodle({ size }: { size?: number }) {
	return (
		<Frame size={size}>
			<g className={styles.hop}>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.8)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 12 5 L 29 5 L 38.5 14.5 L 38.5 40.5 Q 38.5 43 36 43 L 12 43 Q 9.5 43 9.5 40.5 L 9.5 7.5 Q 9.5 5 12 5 Z"
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.6, 0.3)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 29 5.5 L 29 14.5 L 38 14.5"
				/>
				<path
					className={cx(styles.soft, styles.draw)}
					style={timing(0.8, 0.3)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 16 21 L 31.5 20.5 M 16 27.5 L 26 27"
				/>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(1.05, 0.5)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 15 36.5 Q 17.5 30.5 19.5 35 Q 21.5 39.5 24 33.5 Q 26 29.5 28 35 L 33 34"
				/>
			</g>
		</Frame>
	);
}

export function EnvelopeDoodle({ size }: { size?: number }) {
	return (
		<Frame size={size}>
			<g className={styles.hop}>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.7)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 9 11 L 39 11 Q 43 11 43 15 L 43 33 Q 43 37 39 37 L 9 37 Q 5 37 5 33 L 5 15 Q 5 11 9 11 Z"
				/>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(0.6, 0.4)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 7 14 L 24 27 L 41 14"
				/>
			</g>
		</Frame>
	);
}

export function SealDoodle({
	lines,
	size = 44,
	delay = 0,
}: {
	lines: [string] | [string, string];
	size?: number;
	delay?: number;
}) {
	const [first, second] = lines;
	return (
		<Frame size={size}>
			<g className={styles.wiggle}>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(delay + 0.05, 0.8)}
					strokeWidth={2.2}
					pathLength={1}
					d="M 24 3.5 Q 39 3 44 17 Q 48 33 35 41.5 Q 21 49 9 39 Q -1 28 6 14 Q 12 4 24 3.5 Z"
				/>
				{second ? (
					<>
						<text
							className={styles.label}
							x="23"
							y="22.5"
							textAnchor="middle"
							fontSize="9"
						>
							{first}
						</text>
						<text
							className={styles.label}
							x="23"
							y="31.5"
							textAnchor="middle"
							fontSize="7"
						>
							{second}
						</text>
					</>
				) : (
					<text
						className={styles.label}
						x="23"
						y="27.5"
						textAnchor="middle"
						fontSize="8.5"
					>
						{first}
					</text>
				)}
				<circle
					className={cx(styles.accentFill, styles.pop)}
					style={timing(delay + 0.75)}
					cx="39"
					cy="38"
					r="7.5"
				/>
				<path
					className={cx(styles.draw)}
					style={{
						...timing(delay + 1, 0.25),
						fill: "none",
						stroke: "#ffffff",
						strokeLinecap: "round",
						strokeLinejoin: "round",
					}}
					strokeWidth={2.2}
					pathLength={1}
					d="M 35.5 38 L 38 40.8 L 42.6 35.4"
				/>
			</g>
		</Frame>
	);
}

export function PaperPlaneDoodle({ size = 76 }: { size?: number }) {
	return (
		<Frame size={size} width={(size * 132) / 104} viewBox="0 0 132 104">
			<path
				className={cx(styles.soft, styles.march)}
				strokeWidth={2.4}
				d="M 8 86 Q 26 92 42 78 Q 56 66 70 64"
			/>
			<g className={styles.float}>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.1, 0.8)}
					strokeWidth={4.2}
					pathLength={1}
					d="M 72 60 L 122 18 L 104 74 L 92 58 Z"
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.75, 0.35)}
					strokeWidth={4.2}
					pathLength={1}
					d="M 92 58 L 122 18"
				/>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(1, 0.3)}
					strokeWidth={4.2}
					pathLength={1}
					d="M 92 58 L 90 72 L 98 66"
				/>
			</g>
			<path
				className={cx(styles.accent, styles.pop)}
				style={timing(1.3)}
				strokeWidth={3.2}
				d="M 30 22 L 30 32 M 25 27 L 35 27"
			/>
			<path
				className={cx(styles.accent, styles.pop)}
				style={timing(1.45)}
				strokeWidth={3.2}
				d="M 54 10 L 58 6"
			/>
		</Frame>
	);
}

export function SeatMeter({
	used,
	total,
	width = 132,
}: {
	used: number;
	total: number;
	width?: number;
}) {
	const fill = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
	const path = "M 4 8 Q 34 4.5 66 7.5 Q 100 10.5 128 6.5";
	return (
		<svg
			className={styles.doodle}
			width={width}
			height={(width * 14) / 132}
			viewBox="0 0 132 14"
			aria-hidden="true"
		>
			<path className={styles.track} strokeWidth={5} d={path} />
			{fill > 0 && (
				<path
					className={cx(styles.accent, styles.meterFill)}
					style={{ "--fill": fill } as CSSProperties}
					strokeWidth={5}
					pathLength={1}
					d={path}
				/>
			)}
		</svg>
	);
}

export function TabSquiggle() {
	return (
		<svg
			className="block w-full h-[5px]"
			viewBox="0 0 100 5"
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			<path
				className={styles.ink}
				strokeWidth={1.6}
				vectorEffect="non-scaling-stroke"
				d="M 1.5 3.1 Q 14 1.6 28 2.9 T 54 2.7 T 78 3 T 98.5 2.4"
			/>
		</svg>
	);
}
