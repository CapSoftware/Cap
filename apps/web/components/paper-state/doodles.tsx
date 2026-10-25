import type { CSSProperties, ReactNode } from "react";
import styles from "./paper-state.module.css";

const BOIL_ID = "paper-state-boil";

const timing = (delay: number, duration?: number) =>
	({
		"--d": `${delay}s`,
		...(duration === undefined ? {} : { "--t": `${duration}s` }),
	}) as CSSProperties;

const cx = (...names: (string | undefined)[]) =>
	names.filter(Boolean).join(" ");

function DoodleFrame({ children }: { children: ReactNode }) {
	return (
		<svg className={styles.doodle} viewBox="0 0 120 104" aria-hidden="true">
			<defs>
				<filter id={BOIL_ID} x="-15%" y="-15%" width="130%" height="130%">
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.05"
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
						scale="3"
						xChannelSelector="R"
						yChannelSelector="G"
					/>
				</filter>
			</defs>
			<g className={styles.boil} filter={`url(#${BOIL_ID})`}>
				{children}
			</g>
		</svg>
	);
}

function Sparks({
	delay,
	paths,
}: {
	delay: number;
	paths: [string, string, string];
}) {
	return (
		<>
			{paths.map((d, i) => (
				<path
					key={d}
					className={styles.spark}
					style={timing(delay + i * 0.15)}
					d={d}
				/>
			))}
		</>
	);
}

export function LockDoodle() {
	return (
		<DoodleFrame>
			<g className={styles.rattle}>
				<path
					className={cx(styles.stroke, styles.draw)}
					style={timing(0.75, 0.5)}
					pathLength={1}
					d="M 42 50 L 42 36 Q 42 17 60 17 Q 78 17 78 36 L 78 50"
				/>
			</g>
			<path
				className={cx(styles.stroke, styles.draw)}
				style={timing(0.15, 0.8)}
				pathLength={1}
				d="M 34 50 L 86 50 Q 94 50 94 58 L 94 86 Q 94 94 86 94 L 34 94 Q 26 94 26 86 L 26 58 Q 26 50 34 50 Z"
			/>
			<circle
				className={cx(styles.accentFill, styles.pop)}
				style={timing(1.1)}
				cx="60"
				cy="68"
				r="5.5"
			/>
			<path
				className={cx(styles.accentStroke, styles.draw)}
				style={timing(1.25, 0.25)}
				pathLength={1}
				d="M 60 72 L 60 81"
			/>
			<Sparks
				delay={1.5}
				paths={["M 92 22 L 99 15", "M 97 33 L 106 31", "M 21 25 L 14 19"]}
			/>
		</DoodleFrame>
	);
}

export function KeyDoodle() {
	return (
		<DoodleFrame>
			<g className={styles.wiggle}>
				<circle
					className={cx(styles.stroke, styles.draw)}
					style={timing(0.15, 0.6)}
					pathLength={1}
					cx="36"
					cy="52"
					r="17"
				/>
				<circle
					className={cx(styles.accentFill, styles.pop)}
					style={timing(1.15)}
					cx="36"
					cy="52"
					r="5.5"
				/>
				<path
					className={cx(styles.stroke, styles.draw)}
					style={timing(0.7, 0.45)}
					pathLength={1}
					d="M 53 52 L 102 52"
				/>
				<path
					className={cx(styles.stroke, styles.draw)}
					style={timing(1.05, 0.3)}
					pathLength={1}
					d="M 88 52 L 88 65 M 99 52 L 99 62"
				/>
			</g>
			<Sparks
				delay={1.45}
				paths={[
					"M 104 28 L 104 36 M 100 32 L 108 32",
					"M 18 24 L 12 18",
					"M 112 70 L 106 76",
				]}
			/>
		</DoodleFrame>
	);
}

export function EnvelopeDoodle() {
	return (
		<DoodleFrame>
			<g className={styles.bob}>
				<path
					className={cx(styles.stroke, styles.draw)}
					style={timing(0.15, 0.8)}
					pathLength={1}
					d="M 24 30 L 84 30 Q 92 30 92 38 L 92 76 Q 92 84 84 84 L 24 84 Q 16 84 16 76 L 16 38 Q 16 30 24 30 Z"
				/>
				<path
					className={cx(styles.stroke, styles.draw)}
					style={timing(0.75, 0.45)}
					pathLength={1}
					d="M 20 35 L 54 60 L 88 35"
				/>
			</g>
			<g className={styles.pop} style={timing(1.15)}>
				<circle className={styles.paperFill} cx="92" cy="80" r="19" />
				<circle className={styles.accentStroke} cx="92" cy="80" r="14" />
				<path className={styles.accentStroke} d="M 82.5 89.5 L 101.5 70.5" />
			</g>
		</DoodleFrame>
	);
}

export function SearchDoodle() {
	return (
		<DoodleFrame>
			<g className={styles.sway}>
				<circle
					className={cx(styles.stroke, styles.draw)}
					style={timing(0.15, 0.7)}
					pathLength={1}
					cx="50"
					cy="46"
					r="27"
				/>
				<path
					className={cx(styles.stroke, styles.draw)}
					style={{ ...timing(0.75, 0.35), strokeWidth: 7 }}
					pathLength={1}
					d="M 70 66 L 96 92"
				/>
				<path
					className={cx(styles.accentStroke, styles.draw)}
					style={timing(1.05, 0.45)}
					pathLength={1}
					d="M 42 39 Q 42 30 50.5 30 Q 59 30 59 38 Q 59 44 51 47 L 51 51"
				/>
				<circle
					className={cx(styles.accentFill, styles.pop)}
					style={timing(1.45)}
					cx="51"
					cy="59"
					r="3"
				/>
			</g>
		</DoodleFrame>
	);
}

export function PasswordDoodle() {
	return (
		<DoodleFrame>
			<path
				className={cx(styles.stroke, styles.draw)}
				style={timing(0.15, 0.8)}
				pathLength={1}
				d="M 22 42 L 98 42 Q 108 42 108 52 L 108 72 Q 108 82 98 82 L 22 82 Q 12 82 12 72 L 12 52 Q 12 42 22 42 Z"
			/>
			{[30, 45, 60, 75].map((x, i) => (
				<circle
					key={x}
					className={cx(styles.inkFill, styles.typeDot)}
					style={timing(1 + i * 0.22)}
					cx={x}
					cy="62"
					r="4.5"
				/>
			))}
			<path
				className={cx(styles.accentStroke, styles.caret)}
				d="M 90 53 L 90 71"
			/>
			<Sparks
				delay={1.2}
				paths={[
					"M 60 14 L 60 26 M 54.8 17 L 65.2 23 M 54.8 23 L 65.2 17",
					"M 22 22 L 17 16",
					"M 98 22 L 103 16",
				]}
			/>
		</DoodleFrame>
	);
}

export function RecordingDoodle() {
	return (
		<DoodleFrame>
			<g className={styles.bob}>
				<path
					className={cx(styles.stroke, styles.draw)}
					style={timing(0.15, 0.8)}
					pathLength={1}
					d="M 24 22 L 96 22 Q 104 22 104 30 L 104 70 Q 104 78 96 78 L 24 78 Q 16 78 16 70 L 16 30 Q 16 22 24 22 Z"
				/>
				<path
					className={cx(styles.accentStroke, styles.draw)}
					style={timing(0.85, 0.45)}
					pathLength={1}
					d="M 52 38 L 72 50 L 52 62 Z"
				/>
			</g>
			<path
				className={cx(styles.softStroke, styles.march)}
				d="M 16 96 q 6 -6 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0"
			/>
		</DoodleFrame>
	);
}
