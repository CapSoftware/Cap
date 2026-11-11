import { classNames } from "@cap/utils/helpers";
import type { CSSProperties, ReactNode } from "react";
import styles from "./scene.module.css";

const W = 1600;
const H = 400;
const VANISH_X = W / 2;

const rays = Array.from({ length: 41 }, (_, i) => i - 20).map(
	(step) => VANISH_X + step * 150,
);

const rows = Array.from({ length: 15 }, (_, k) => H / (1 + k * 0.6));

const NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E")`;

export const Grain = () => (
	<div
		aria-hidden="true"
		className={styles.grain}
		style={{ backgroundImage: NOISE }}
	/>
);

const FloorGrid = ({ lit }: { lit: boolean }) => (
	<svg
		aria-hidden="true"
		className={styles.floor}
		viewBox={`0 0 ${W} ${H}`}
		preserveAspectRatio="xMidYMin slice"
	>
		<g
			stroke="#ECE8E1"
			strokeOpacity={lit ? 0.3 : 0.15}
			strokeWidth={1}
			vectorEffect="non-scaling-stroke"
			fill="none"
		>
			{rays.map((x) => (
				<line
					key={`r${x}`}
					x1={VANISH_X}
					y1={0}
					x2={x}
					y2={H}
					vectorEffect="non-scaling-stroke"
				/>
			))}
			{rows.map((y) => (
				<line
					key={`h${y.toFixed(2)}`}
					x1={0}
					y1={y}
					x2={W}
					y2={y}
					vectorEffect="non-scaling-stroke"
				/>
			))}
		</g>
	</svg>
);

export const Plain = ({
	children,
	night = false,
	horizon,
	slab,
	className,
}: {
	children: ReactNode;
	night?: boolean;
	horizon: string;
	slab: { width: string; height: string };
	className?: string;
}) => (
	<div
		className={classNames(styles.scene, night && styles.night, className)}
		style={
			{
				"--horizon": horizon,
				"--slab-w": slab.width,
				"--slab-h": slab.height,
			} as CSSProperties
		}
	>
		<div aria-hidden="true" className={styles.sky} />
		{night ? null : <div aria-hidden="true" className={styles.glare} />}
		<FloorGrid lit={night} />
		<div aria-hidden="true" className={styles.monolith}>
			<div className={styles.slit} />
		</div>
		<div aria-hidden="true" className={styles.spill} />
		<div aria-hidden="true" className={styles.fade} />
		{children}
	</div>
);

export const plateStyles = {
	plate: styles.plate,
};
