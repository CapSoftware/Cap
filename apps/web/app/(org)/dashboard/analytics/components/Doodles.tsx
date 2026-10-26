import type { CSSProperties, ReactNode } from "react";
import styles from "./doodles.module.css";

export const BOIL_FILTER_ID = "analytics-doodle-boil";
export const BOIL_FILTER_LARGE_ID = "analytics-doodle-boil-lg";

export const doodleStyles = styles;

export const timing = (delay: number, duration?: number) =>
	({
		"--d": `${delay}s`,
		...(duration === undefined ? {} : { "--t": `${duration}s` }),
	}) as CSSProperties;

export const cx = (...names: (string | false | null | undefined)[]) =>
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
				<filter
					id={BOIL_FILTER_LARGE_ID}
					x="-20%"
					y="-20%"
					width="140%"
					height="140%"
				>
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.05"
						numOctaves="2"
						seed="2"
						result="noise"
					>
						<animate
							attributeName="seed"
							values="2;4;6;8"
							dur="0.6s"
							repeatCount="indefinite"
							calcMode="discrete"
						/>
					</feTurbulence>
					<feDisplacementMap
						in="SourceGraphic"
						in2="noise"
						scale="2.6"
						xChannelSelector="R"
						yChannelSelector="G"
					/>
				</filter>
			</defs>
		</svg>
	);
}

function IconFrame({
	children,
	size = 26,
	className,
}: {
	children: ReactNode;
	size?: number;
	className?: string;
}) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 48 48"
			aria-hidden="true"
			overflow="visible"
		>
			<g className={styles.boil} filter={`url(#${BOIL_FILTER_ID})`}>
				{children}
			</g>
		</svg>
	);
}

const W = 3.4;

export function EyeDoodle({ size }: { size?: number }) {
	return (
		<IconFrame size={size}>
			<g className={styles.blink}>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.7)}
					strokeWidth={W}
					pathLength={1}
					d="M 5 25 Q 24 6 43 25 Q 24 42 5 25 Z"
				/>
				<circle
					className={cx(styles.accentFill, styles.pop)}
					style={timing(0.55)}
					cx="24"
					cy="24.5"
					r="6.5"
				/>
				<circle
					className={cx(styles.paperFill, styles.pop)}
					style={timing(0.7)}
					cx="26.4"
					cy="22.4"
					r="1.8"
				/>
			</g>
		</IconFrame>
	);
}

export function BubbleDoodle({ size }: { size?: number }) {
	return (
		<IconFrame size={size}>
			<path
				className={cx(styles.ink, styles.draw)}
				style={timing(0.05, 0.8)}
				strokeWidth={W}
				pathLength={1}
				d="M 12 9 L 37 9 Q 43 9 43 15 L 43 29 Q 43 35 37 35 L 21 35 L 12 42 L 13 35 Q 6 35 6 29 L 6 15 Q 6 9 12 9 Z"
			/>
			{[15.5, 24.5, 33.5].map((dotX, i) => (
				<g key={dotX} className={styles.typing} style={timing(i * 0.12)}>
					<circle
						className={cx(styles.accentFill, styles.pop)}
						style={timing(0.6 + i * 0.12)}
						cx={dotX}
						cy="22"
						r="2.6"
					/>
				</g>
			))}
		</IconFrame>
	);
}

export function SmileDoodle({ size }: { size?: number }) {
	return (
		<IconFrame size={size}>
			<g className={styles.wiggle}>
				<circle
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.75)}
					strokeWidth={W}
					pathLength={1}
					cx="24"
					cy="24"
					r="17.5"
				/>
				<circle
					className={cx(styles.inkFill, styles.pop)}
					style={timing(0.55)}
					cx="18"
					cy="20"
					r="2.4"
				/>
				<circle
					className={cx(styles.inkFill, styles.pop)}
					style={timing(0.65)}
					cx="30"
					cy="20"
					r="2.4"
				/>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(0.75, 0.35)}
					strokeWidth={W}
					pathLength={1}
					d="M 16.5 28 Q 24 35.5 31.5 28"
				/>
			</g>
		</IconFrame>
	);
}

export function ReelDoodle({ size }: { size?: number }) {
	return (
		<IconFrame size={size}>
			<g className={styles.bounce}>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.8)}
					strokeWidth={W}
					pathLength={1}
					d="M 11 11 L 37 11 Q 42 11 42 16 L 42 32 Q 42 37 37 37 L 11 37 Q 6 37 6 32 L 6 16 Q 6 11 11 11 Z"
				/>
				<circle
					className={cx(styles.accentFill, styles.pop)}
					style={timing(0.6)}
					cx="24"
					cy="24"
					r="6"
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.75, 0.25)}
					strokeWidth={W}
					pathLength={1}
					d="M 17 43 L 31 43"
				/>
			</g>
		</IconFrame>
	);
}

function StageFrame({ children }: { children: ReactNode }) {
	return (
		<svg
			width="132"
			height="104"
			viewBox="0 0 132 104"
			aria-hidden="true"
			overflow="visible"
		>
			<g className={styles.boil} filter={`url(#${BOIL_FILTER_LARGE_ID})`}>
				{children}
			</g>
		</svg>
	);
}

export function PaperPlaneDoodle() {
	return (
		<StageFrame>
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
		</StageFrame>
	);
}

export function SquiggleLoader() {
	return (
		<svg
			width="160"
			height="56"
			viewBox="0 0 160 56"
			aria-hidden="true"
			overflow="visible"
		>
			<g className={styles.boil} filter={`url(#${BOIL_FILTER_LARGE_ID})`}>
				<path
					className={cx(styles.soft, styles.scribble)}
					strokeWidth={3.4}
					pathLength={1}
					d="M 6 44 Q 22 40 32 30 Q 42 20 54 32 Q 66 44 80 26 Q 92 10 106 22 Q 118 32 128 16 Q 136 6 154 10"
				/>
			</g>
		</svg>
	);
}

export function GlobeDoodle() {
	return (
		<IconFrame size={56}>
			<circle
				className={cx(styles.ink, styles.draw)}
				style={timing(0.05, 0.8)}
				strokeWidth={2.6}
				pathLength={1}
				cx="24"
				cy="24"
				r="17"
			/>
			<path
				className={cx(styles.ink, styles.draw)}
				style={timing(0.6, 0.5)}
				strokeWidth={2.6}
				pathLength={1}
				d="M 24 7 Q 14 24 24 41 M 24 7 Q 34 24 24 41"
			/>
			<path
				className={cx(styles.accent, styles.draw)}
				style={timing(0.9, 0.4)}
				strokeWidth={2.6}
				pathLength={1}
				d="M 8 19 L 40 19 M 8 29 L 40 29"
			/>
		</IconFrame>
	);
}

export function LaptopDoodle() {
	return (
		<IconFrame size={56}>
			<path
				className={cx(styles.ink, styles.draw)}
				style={timing(0.05, 0.7)}
				strokeWidth={2.6}
				pathLength={1}
				d="M 11 12 L 37 12 Q 39 12 39 14 L 39 31 L 9 31 L 9 14 Q 9 12 11 12 Z"
			/>
			<path
				className={cx(styles.ink, styles.draw)}
				style={timing(0.6, 0.35)}
				strokeWidth={2.6}
				pathLength={1}
				d="M 4 35 L 44 35 Q 42 39 38 39 L 10 39 Q 6 39 4 35 Z"
			/>
			<path
				className={cx(styles.accent, styles.draw)}
				style={timing(0.9, 0.3)}
				strokeWidth={2.6}
				pathLength={1}
				d="M 16 25 L 21 20 L 26 23 L 32 17"
			/>
		</IconFrame>
	);
}

export function StackDoodle() {
	return (
		<IconFrame size={56}>
			<path
				className={cx(styles.ink, styles.draw)}
				style={timing(0.05, 0.7)}
				strokeWidth={2.6}
				pathLength={1}
				d="M 10 16 L 38 16 Q 41 16 41 19 L 41 37 Q 41 40 38 40 L 10 40 Q 7 40 7 37 L 7 19 Q 7 16 10 16 Z"
			/>
			<path
				className={cx(styles.soft, styles.draw)}
				style={timing(0.55, 0.35)}
				strokeWidth={2.6}
				pathLength={1}
				d="M 11 11 L 37 11 M 15 6.5 L 33 6.5"
			/>
			<path
				className={cx(styles.accent, styles.draw)}
				style={timing(0.85, 0.35)}
				strokeWidth={2.6}
				pathLength={1}
				d="M 21 23 L 29 28 L 21 33 Z"
			/>
		</IconFrame>
	);
}
