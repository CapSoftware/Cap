import type {
	CaptionStyle,
	CatalogBackground,
	ColorLook,
} from "@cap/app-store";
import Image from "next/image";
import type { CSSProperties } from "react";

function hexToRgba(hex: string, alpha: number) {
	const value = Number.parseInt(hex.slice(1), 16);
	return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function backgroundStyle(background: CatalogBackground): CSSProperties {
	if (background.kind === "image") return {};
	if (background.kind === "gradient") {
		return {
			backgroundImage: `linear-gradient(${background.angle}deg, ${background.from}, ${background.to})`,
		};
	}
	return { backgroundColor: background.color };
}

function Tile({
	label,
	children,
	style,
}: {
	label: string;
	children?: React.ReactNode;
	style?: CSSProperties;
}) {
	return (
		<figure className="flex flex-col gap-1.5">
			<div
				className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-gray-3"
				style={style}
			>
				{children}
			</div>
			<figcaption className="truncate text-[11px] text-gray-10">
				{label}
			</figcaption>
		</figure>
	);
}

const SAMPLE_WORDS = ["Every", "word", "lands"];

function CaptionTile({ style }: { style: CaptionStyle }) {
	const textStyle: CSSProperties = {
		color: style.color,
		fontWeight: style.fontWeight,
		fontSize: Math.max(11, Math.round(style.size / 3.6)),
		textTransform: style.uppercase ? "uppercase" : "none",
		textShadow: style.outline
			? `0 0 2px ${style.outlineColor}, 0 0 2px ${style.outlineColor}, 0 0 1px ${style.outlineColor}`
			: undefined,
	};
	return (
		<Tile
			label={style.name}
			style={{
				backgroundImage:
					"linear-gradient(160deg, #1f2937 0%, #111827 55%, #030712 100%)",
			}}
		>
			<span
				className="absolute bottom-[14%] rounded-md px-2 py-1"
				style={{
					...textStyle,
					backgroundColor: hexToRgba(
						style.backgroundColor,
						style.backgroundOpacity / 100,
					),
				}}
			>
				{SAMPLE_WORDS.map((word, index) => {
					const active = style.activeWordHighlight && index === 1;
					return (
						<span key={word}>
							{index > 0 ? " " : ""}
							<span
								style={
									active
										? style.highlightStyle === "pill"
											? {
													backgroundColor: style.highlightColor,
													borderRadius: 4,
													padding: "0 3px",
												}
											: { color: style.highlightColor }
										: undefined
								}
							>
								{word}
							</span>
						</span>
					);
				})}
			</span>
		</Tile>
	);
}

function lookFilter(look: ColorLook) {
	const v = look.values;
	const intensity = v.intensity ?? 1;
	const amount = (value: number | undefined) => (value ?? 0) * intensity;
	const temperature = amount(v.temperature);
	return [
		`brightness(${1 + amount(v.exposure) * 0.5})`,
		`contrast(${1 + amount(v.contrast) - amount(v.fade) * 0.25})`,
		`saturate(${Math.max(0, 1 + amount(v.saturation))})`,
		temperature > 0 ? `sepia(${temperature * 0.5})` : "",
		temperature < 0 ? `hue-rotate(${temperature * 25}deg)` : "",
		amount(v.tint) !== 0 ? `hue-rotate(${amount(v.tint) * -12}deg)` : "",
	]
		.filter(Boolean)
		.join(" ");
}

function LookTile({ look }: { look: ColorLook }) {
	const vignette = (look.values.vignette ?? 0) * (look.values.intensity ?? 1);
	return (
		<Tile label={look.name}>
			<div
				className="absolute inset-0"
				style={{
					backgroundImage:
						"linear-gradient(135deg, #f97316 0%, #facc15 25%, #22c55e 50%, #0ea5e9 75%, #8b5cf6 100%)",
					filter: lookFilter(look),
				}}
			/>
			<div
				className="absolute inset-0"
				style={{
					background: `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${Math.min(0.8, vignette)}) 100%)`,
				}}
			/>
		</Tile>
	);
}

export function ContentPreview({
	backgrounds,
	captionStyles,
	colorLooks,
}: {
	backgrounds: readonly CatalogBackground[];
	captionStyles: readonly CaptionStyle[];
	colorLooks: readonly ColorLook[];
}) {
	if (!backgrounds.length && !captionStyles.length && !colorLooks.length) {
		return null;
	}
	return (
		<div className="flex flex-col gap-6">
			{backgrounds.length > 0 && (
				<section aria-label="Backgrounds" className="flex flex-col gap-3">
					<h2 className="text-[13px] font-medium text-gray-12">
						{backgrounds.length} backgrounds
					</h2>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
						{backgrounds.map((background) => (
							<Tile
								key={background.id}
								label={background.name}
								style={backgroundStyle(background)}
							>
								{background.kind === "image" && (
									<Image
										src={background.image.url}
										alt=""
										fill
										sizes="(min-width: 640px) 240px, 45vw"
										className="object-cover"
									/>
								)}
							</Tile>
						))}
					</div>
				</section>
			)}
			{captionStyles.length > 0 && (
				<section aria-label="Caption styles" className="flex flex-col gap-3">
					<h2 className="text-[13px] font-medium text-gray-12">
						{captionStyles.length} caption styles
					</h2>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
						{captionStyles.map((style) => (
							<CaptionTile key={style.id} style={style} />
						))}
					</div>
				</section>
			)}
			{colorLooks.length > 0 && (
				<section aria-label="Color looks" className="flex flex-col gap-3">
					<h2 className="text-[13px] font-medium text-gray-12">
						{colorLooks.length} color looks
					</h2>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
						{colorLooks.map((look) => (
							<LookTile key={look.id} look={look} />
						))}
					</div>
				</section>
			)}
		</div>
	);
}
