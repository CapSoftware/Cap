import type { Folder } from "@cap/web-domain";
import type { CSSProperties, ReactNode } from "react";
import styles from "./library-doodles.module.css";

const BOIL_FILTER_ID = "library-doodle-boil";
const STROKE = 3;

export const libraryDoodleHost = styles.host;
export const libraryDoodleStyles = styles;

export const FOLDER_TINTS: Record<Folder.FolderColor, string> = {
	normal: "var(--gray-5)",
	blue: "#93c5fd",
	red: "#fca5a5",
	yellow: "#fde68a",
};

const timing = (delay: number, duration?: number) =>
	({
		"--d": `${delay}s`,
		...(duration === undefined ? {} : { "--t": `${duration}s` }),
	}) as CSSProperties;

const cx = (...names: (string | false | null | undefined)[]) =>
	names.filter(Boolean).join(" ");

export function LibraryDoodleFilters() {
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
	className,
	style,
}: {
	children: ReactNode;
	size?: number;
	viewBox?: string;
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<svg
			className={cx(styles.doodle, className)}
			width={size}
			height={size}
			viewBox={viewBox}
			aria-hidden="true"
			style={style}
		>
			<g className={styles.boil}>{children}</g>
		</svg>
	);
}

const FOLDER_BODY =
	"M 5 15 Q 5 11 9 11 L 18 11 Q 20 11 21.5 13 L 23 15 L 39 15 Q 43 15 43 19 L 43 36 Q 43 40 39 40 L 9 40 Q 5 40 5 36 Z";

export function FolderDoodle({
	size,
	color = "normal",
	delay = 0,
}: {
	size?: number;
	color?: Folder.FolderColor;
	delay?: number;
}) {
	return (
		<Frame
			size={size}
			style={{ "--doodle-tint": FOLDER_TINTS[color] } as CSSProperties}
		>
			<g className={styles.hop}>
				<path
					className={styles.tint}
					style={timing(delay + 0.45)}
					d={FOLDER_BODY}
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(delay + 0.05, 0.7)}
					strokeWidth={STROKE}
					pathLength={1}
					d={FOLDER_BODY}
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(delay + 0.6, 0.3)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 5.5 21 L 42.5 20.5"
				/>
			</g>
		</Frame>
	);
}

export function MoveDoodle({ size }: { size?: number }) {
	return (
		<Frame size={size}>
			<g className={styles.hop}>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.7)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 5 21 Q 5 17 9 17 L 16 17 L 19.5 20.5 L 39 20.5 Q 43 20.5 43 24.5 L 43 38 Q 43 42 39 42 L 9 42 Q 5 42 5 38 Z"
				/>
			</g>
			<g className={styles.float}>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(0.65, 0.45)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 30 4 Q 22 7 24.5 17 L 25 31"
				/>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(1, 0.25)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 19.5 26 L 25 31.5 L 30.5 26"
				/>
			</g>
		</Frame>
	);
}

export function PersonDoodle({ size }: { size?: number }) {
	return (
		<Frame size={size}>
			<g className={styles.hop}>
				<circle
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.5)}
					strokeWidth={STROKE}
					pathLength={1}
					cx="24"
					cy="15"
					r="7"
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.45, 0.5)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 10 40.5 Q 10 27 24 27 Q 38 27 38 40.5"
				/>
				<circle
					className={cx(styles.accentFill, styles.pop)}
					style={timing(0.9)}
					cx="36"
					cy="12"
					r="3"
				/>
			</g>
		</Frame>
	);
}

export function TeamDoodle({ size }: { size?: number }) {
	return (
		<Frame size={size}>
			<g className={styles.hop}>
				<circle
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.45)}
					strokeWidth={STROKE}
					pathLength={1}
					cx="17"
					cy="16"
					r="6"
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.4, 0.45)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 5.5 39.5 Q 5.5 27 17 27 Q 28.5 27 28.5 39.5"
				/>
				<circle
					className={cx(styles.accent, styles.draw)}
					style={timing(0.8, 0.35)}
					strokeWidth={STROKE}
					pathLength={1}
					cx="33"
					cy="18.5"
					r="5"
				/>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(1.05, 0.3)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 32 28 Q 42.5 28 42.5 39.5"
				/>
			</g>
		</Frame>
	);
}

export function SpaceDoodle({ size }: { size?: number }) {
	return (
		<Frame size={size}>
			<g className={styles.hop}>
				<path
					className={cx(styles.soft, styles.draw)}
					style={timing(0.05, 0.4)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 7 31 L 24 39.5 L 41 31"
				/>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.35, 0.4)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 7 24.5 L 24 33 L 41 24.5"
				/>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(0.65, 0.6)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 24 9 L 41 17.5 L 24 26 L 7 17.5 Z"
				/>
			</g>
		</Frame>
	);
}

export function CheckDoodle({ size = 18 }: { size?: number }) {
	return (
		<Frame size={size}>
			<path
				className={cx(styles.accent, styles.draw)}
				style={timing(0, 0.3)}
				strokeWidth={5}
				pathLength={1}
				d="M 8 25 L 19.5 36 L 41 11"
			/>
		</Frame>
	);
}

export function EyeDoodle({ size }: { size?: number }) {
	return (
		<Frame size={size}>
			<g className={styles.wiggle}>
				<path
					className={cx(styles.ink, styles.draw)}
					style={timing(0.05, 0.6)}
					strokeWidth={STROKE}
					pathLength={1}
					d="M 4 24.5 Q 14 11 24 11 Q 34 11 44 24 Q 34 37.5 24 37.5 Q 14 37.5 4 24.5 Z"
				/>
				<circle
					className={cx(styles.accentFill, styles.pop)}
					style={timing(0.6)}
					cx="24"
					cy="24"
					r="5.5"
				/>
			</g>
		</Frame>
	);
}

export function EmptyFolderDoodle({ size = 88 }: { size?: number }) {
	return (
		<Frame size={size} viewBox="0 0 96 80">
			<path
				className={cx(styles.soft, styles.march)}
				strokeWidth={2.4}
				d="M 6 16 Q 18 4 34 10"
			/>
			<g className={styles.float}>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(0.9, 0.5)}
					strokeWidth={3.4}
					pathLength={1}
					d="M 38 6 Q 48 6 49 26"
				/>
				<path
					className={cx(styles.accent, styles.draw)}
					style={timing(1.3, 0.25)}
					strokeWidth={3.4}
					pathLength={1}
					d="M 43 21 L 49 27 L 55 21"
				/>
			</g>
			<path
				className={cx(styles.ink, styles.draw)}
				style={timing(0.05, 0.8)}
				strokeWidth={3.4}
				pathLength={1}
				d="M 14 38 Q 14 33 19 33 L 33 33 Q 36 33 38 36 L 40 39 L 77 39 Q 82 39 82 44 L 82 69 Q 82 74 77 74 L 19 74 Q 14 74 14 69 Z"
			/>
			<path
				className={cx(styles.soft, styles.draw)}
				style={timing(0.7, 0.35)}
				strokeWidth={3.4}
				pathLength={1}
				d="M 15 48 L 81 47.5"
			/>
		</Frame>
	);
}
