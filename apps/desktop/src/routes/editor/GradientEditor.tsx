import { createMemo, createUniqueId, For, Show } from "solid-js";
import { RgbInput } from "./color-utils";
import { useEditorContext } from "./context";
import type { RGBColor } from "./projectConfig";
import { Slider, Subfield } from "./ui";

type GradientSourceFields = {
	type: "gradient";
	from: RGBColor;
	to: RGBColor;
	angle?: number;
	noise_intensity?: number | null;
	noise_scale?: number | null;
};

export const GRADIENT_PRESETS = [
	{ from: [15, 52, 67], to: [52, 232, 158] },
	{ from: [34, 193, 195], to: [253, 187, 45] },
	{ from: [29, 253, 251], to: [195, 29, 253] },
	{ from: [69, 104, 220], to: [176, 106, 179] },
	{ from: [106, 130, 251], to: [252, 92, 125] },
	{ from: [131, 58, 180], to: [253, 29, 29] },
	{ from: [249, 212, 35], to: [255, 78, 80] },
	{ from: [255, 94, 0], to: [255, 42, 104] },
	{ from: [255, 0, 150], to: [0, 204, 255] },
	{ from: [0, 242, 96], to: [5, 117, 230] },
	{ from: [238, 205, 163], to: [239, 98, 159] },
	{ from: [44, 62, 80], to: [52, 152, 219] },
	{ from: [168, 239, 255], to: [238, 205, 163] },
	{ from: [74, 0, 224], to: [143, 0, 255] },
	{ from: [252, 74, 26], to: [247, 183, 51] },
	{ from: [0, 255, 255], to: [255, 20, 147] },
	{ from: [255, 127, 0], to: [255, 255, 0] },
	{ from: [255, 0, 255], to: [0, 255, 0] },
] satisfies Array<{ from: RGBColor; to: RGBColor }>;

function randomColor(): RGBColor {
	return [
		Math.floor(Math.random() * 256),
		Math.floor(Math.random() * 256),
		Math.floor(Math.random() * 256),
	];
}

export function GradientEditor() {
	const { project, setProject } = useEditorContext();
	const filterId = createUniqueId();

	const source = createMemo(() => {
		if (project.background.source.type !== "gradient") return null;
		return project.background.source as unknown as GradientSourceFields;
	});

	const angle = () => source()?.angle ?? 90;
	const noiseIntensity = () => source()?.noise_intensity ?? 0;
	const noiseScale = () => source()?.noise_scale ?? 50;

	const updateGradient = (updates: Partial<GradientSourceFields>) => {
		setProject("background", "source", updates as Record<string, unknown>);
	};

	const gradientCSS = createMemo(() => {
		const s = source();
		if (!s) return "";
		const from = `rgb(${s.from.join(",")})`;
		const to = `rgb(${s.to.join(",")})`;
		return `linear-gradient(${angle()}deg, ${from}, ${to})`;
	});

	const noiseBaseFrequency = createMemo(() => {
		const scale = noiseScale();
		return (0.3 + ((100 - scale) / 100) * 1.2).toFixed(3);
	});

	return (
		<Show when={source()}>
			{(src) => (
				<div class="flex flex-col gap-3">
					<div class="relative overflow-hidden rounded-xl h-28 border border-gray-5">
						<div
							class="absolute inset-0"
							style={{
								background: gradientCSS(),
								transition: "background 200ms ease",
							}}
						/>
						<Show when={noiseIntensity() > 0}>
							<svg
								class="absolute inset-0 w-full h-full pointer-events-none"
								style={{
									opacity: noiseIntensity() / 100,
									"mix-blend-mode": "overlay",
								}}
							>
								<filter id={`noise-${filterId}`}>
									<feTurbulence
										type="fractalNoise"
										baseFrequency={noiseBaseFrequency()}
										numOctaves="4"
										stitchTiles="stitch"
									/>
									<feColorMatrix type="saturate" values="0" />
								</filter>
								<rect
									width="100%"
									height="100%"
									filter={`url(#noise-${filterId})`}
								/>
							</svg>
						</Show>
					</div>

					<div class="flex gap-3 items-end">
						<div class="flex-1 min-w-0">
							<span class="text-[11px] text-gray-10 mb-1 block">From</span>
							<RgbInput
								value={src().from}
								onChange={(from) => {
									updateGradient({ from });
								}}
							/>
						</div>
						<div class="flex-1 min-w-0">
							<span class="text-[11px] text-gray-10 mb-1 block">To</span>
							<RgbInput
								value={src().to}
								onChange={(to) => {
									updateGradient({ to });
								}}
							/>
						</div>
					</div>

					<div class="w-full border-t border-dashed border-gray-5 my-1" />

					<Subfield name="Angle" class="gap-4 items-center">
						<div class="flex flex-1 gap-3 items-center">
							<Slider
								class="flex-1"
								value={[angle()]}
								onChange={(v) => {
									updateGradient({ angle: v[0] });
								}}
								minValue={0}
								maxValue={360}
								step={1}
								formatTooltip={(value) => `${Math.round(value)}°`}
							/>
							<span class="w-12 text-xs text-right text-gray-11 tabular-nums">
								{Math.round(angle())}°
							</span>
						</div>
					</Subfield>

					<div class="w-full border-t border-dashed border-gray-5 my-1" />

					<Subfield name="Noise">
						<div class="w-[120px]">
							<Slider
								value={[noiseIntensity()]}
								onChange={(v) => {
									updateGradient({
										noise_intensity: v[0],
									});
								}}
								minValue={0}
								maxValue={100}
								step={1}
								formatTooltip="%"
							/>
						</div>
					</Subfield>

					<Show when={noiseIntensity() > 0}>
						<Subfield name="Grain Scale">
							<div class="w-[120px]">
								<Slider
									value={[noiseScale()]}
									onChange={(v) => {
										updateGradient({
											noise_scale: v[0],
										});
									}}
									minValue={1}
									maxValue={100}
									step={1}
									formatTooltip="%"
								/>
							</div>
						</Subfield>
					</Show>

					<div class="w-full border-t border-dashed border-gray-5 my-1" />

					<div class="flex flex-wrap gap-2">
						<button
							type="button"
							class="flex items-center justify-center rounded-lg transition-all duration-200 cursor-pointer size-8 hover:opacity-80 hover:scale-105 border border-dashed border-gray-8 bg-gray-2 text-gray-10"
							onClick={() => {
								updateGradient({
									from: randomColor(),
									to: randomColor(),
								});
							}}
							title="Randomize"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22" />
								<path d="m18 2 4 4-4 4" />
								<path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
								<path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" />
								<path d="m18 14 4 4-4 4" />
							</svg>
						</button>
						<For each={GRADIENT_PRESETS}>
							{(gradient) => (
								<button
									type="button"
									class="rounded-lg transition-all duration-200 cursor-pointer size-8 hover:opacity-80 hover:scale-105 ring-offset-2 ring-offset-gray-200"
									classList={{
										"ring-2 ring-gray-500":
											src().from[0] === gradient.from[0] &&
											src().from[1] === gradient.from[1] &&
											src().from[2] === gradient.from[2] &&
											src().to[0] === gradient.to[0] &&
											src().to[1] === gradient.to[1] &&
											src().to[2] === gradient.to[2],
									}}
									style={{
										background: `linear-gradient(${angle()}deg, rgb(${gradient.from.join(
											",",
										)}), rgb(${gradient.to.join(",")}))`,
									}}
									onClick={() => {
										updateGradient({
											from: gradient.from as RGBColor,
											to: gradient.to as RGBColor,
										});
									}}
								/>
							)}
						</For>
					</div>
				</div>
			)}
		</Show>
	);
}
