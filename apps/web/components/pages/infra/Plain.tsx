import type { CSSProperties } from "react";
import { ART_PATH, NIGHT, PLAIN, PLATES } from "./art";
import { LADDER } from "./content";
import { HeroDust } from "./Dust";
import styles from "./scene.module.css";
import { MONO } from "./theme";

const NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.1 -0.2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")`;

const srcSet = (name: string, widths: readonly number[], type: string) =>
	widths
		.map((width) => `${ART_PATH}/${name}-${width}.${type} ${width}w`)
		.join(", ");

export const Grain = () => (
	<div
		aria-hidden="true"
		className={styles.grain}
		style={{ backgroundImage: NOISE }}
	/>
);

const PLAIN_WIDTHS = [1280, 2000, 3200] as const;
const PLAIN_SIZES =
	"(min-width: 1024px) 236vh, (min-width: 640px) 1240px, 1000px";
const LIT_WIDTHS = [120, 192] as const;

export const HeroArt = () => (
	<div
		aria-hidden="true"
		className={styles.art}
		style={
			{
				"--horizon": PLAIN.horizon,
				"--slab-base": PLAIN.slabBase,
				"--slit-top": PLAIN.slitTop,
				"--lit-x": PLAIN.lit.x,
				"--lit-y": PLAIN.lit.y,
				"--lit-w": PLAIN.lit.w,
				"--lit-h": PLAIN.lit.h,
				backgroundImage: `url("${PLAIN.placeholder}")`,
			} as CSSProperties
		}
	>
		<picture>
			<source
				type="image/avif"
				srcSet={srcSet("plain", PLAIN_WIDTHS, "avif")}
				sizes={PLAIN_SIZES}
			/>
			<img
				className={styles.base}
				src={`${ART_PATH}/plain-2000.webp`}
				srcSet={srcSet("plain", PLAIN_WIDTHS, "webp")}
				sizes={PLAIN_SIZES}
				width={3200}
				height={1600}
				alt=""
				decoding="async"
				fetchPriority="high"
			/>
		</picture>
		<HeroDust />
		<div className={styles.litBox}>
			<picture>
				<source
					type="image/avif"
					srcSet={srcSet("plain-lit", LIT_WIDTHS, "avif")}
					sizes="(min-width: 1024px) 14vh, 64px"
				/>
				<img
					className={styles.lit}
					src={`${ART_PATH}/plain-lit-192.webp`}
					width={192}
					height={704}
					alt=""
					decoding="async"
				/>
			</picture>
		</div>
		<div className={styles.pulse} />
	</div>
);

const NIGHT_WIDTHS = [1280, 2000, 3200] as const;

export const NightArt = () => (
	<div
		aria-hidden="true"
		className={styles.nightArt}
		style={
			{
				"--night-ratio": NIGHT.ratio,
				backgroundImage: `url("${NIGHT.placeholder}")`,
			} as CSSProperties
		}
	>
		<picture>
			<source
				type="image/avif"
				srcSet={srcSet("night", NIGHT_WIDTHS, "avif")}
				sizes="max(100vw, 980px)"
			/>
			<img
				className={styles.base}
				src={`${ART_PATH}/night-2000.webp`}
				srcSet={srcSet("night", NIGHT_WIDTHS, "webp")}
				sizes="max(100vw, 980px)"
				width={3200}
				height={960}
				alt=""
				loading="lazy"
				decoding="async"
			/>
		</picture>
	</div>
);

const PLATE_WIDTHS = [1400, 2000, 2800] as const;
const PLATE_SMALL_WIDTHS = [640, 1100] as const;
const PLATE_SIZES = "min(100vw, 1680px)";

export const PlatesArt = ({ className }: { className?: string }) => (
	<figure
		className={`${styles.plates} ${className ?? ""}`}
		style={
			{
				"--plates-ratio": PLATES.ratio,
				"--plates-ratio-small": PLATES.ratioSmall,
				backgroundImage: `url("${PLATES.placeholder}")`,
			} as CSSProperties
		}
	>
		<picture>
			<source
				media="(min-width: 768px)"
				type="image/avif"
				srcSet={srcSet("plates", PLATE_WIDTHS, "avif")}
				sizes={PLATE_SIZES}
			/>
			<source
				media="(min-width: 768px)"
				type="image/webp"
				srcSet={srcSet("plates", PLATE_WIDTHS, "webp")}
				sizes={PLATE_SIZES}
			/>
			<source
				type="image/avif"
				srcSet={srcSet("plates-small", PLATE_SMALL_WIDTHS, "avif")}
				sizes="100vw"
			/>
			<img
				className={styles.base}
				src={`${ART_PATH}/plates-small-1100.webp`}
				srcSet={srcSet("plates-small", PLATE_SMALL_WIDTHS, "webp")}
				sizes="100vw"
				alt=""
				loading="lazy"
				decoding="async"
			/>
		</picture>
		<figcaption className="sr-only">
			An upload is encoded to renditions from {LADDER.join(", ")}, never above
			the source resolution.
		</figcaption>
		<ul aria-hidden="true" className="m-0 list-none p-0">
			{LADDER.map((label, i) => {
				const rung = PLATES.rungs[i];
				if (!rung) return null;
				return (
					<li
						key={label}
						className={styles.rung}
						style={
							{
								"--x": rung.x,
								"--y": rung.y,
								"--to": PLATES.leadTo,
								"--sx": rung.sx,
								"--sy": rung.sy,
								"--sto": PLATES.leadToSmall,
							} as CSSProperties
						}
					>
						<span
							className={`${MONO} text-[12px] text-[rgba(232,236,244,0.86)]`}
						>
							{label}
						</span>
					</li>
				);
			})}
		</ul>
	</figure>
);
