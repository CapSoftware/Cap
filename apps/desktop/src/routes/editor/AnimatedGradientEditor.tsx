import { Collapsible as KCollapsible } from "@kobalte/core/collapsible";
import { createQuery } from "@tanstack/solid-query";
import { cx } from "cva";
import {
	createMemo,
	createSignal,
	For,
	Index,
	type JSX,
	onCleanup,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";
import { animatedGradientsStore } from "~/store";
import type { OrganizationBrandColorSwatch } from "~/utils/organization-branding";
import {
	type AnimatedGradientConfig,
	type AnimatedGradientControl,
	type AnimatedGradientPreset,
	commands,
} from "~/utils/tauri";
import IconCapChevronDown from "~icons/cap/chevron-down";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideRotateCcw from "~icons/lucide/rotate-ccw";
import IconLucideSave from "~icons/lucide/save";
import IconLucideShuffle from "~icons/lucide/shuffle";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideX from "~icons/lucide/x";
import { BrandColorsDropdown } from "./BrandColorsDropdown";
import { hexToRgb, RgbInput } from "./color-utils";
import { useEditorContext } from "./context";
import { Field, Input, Slider, Subfield } from "./ui";

const MAX_STOPS = 5;
const MIN_STOPS = 2;
const MAX_SAVED = 100;
const MOTION_KEY: AnimatedGradientControl["key"] = "motionSpeed";

export function copyAnimatedGradientConfig(
	config: AnimatedGradientConfig,
): AnimatedGradientConfig {
	return {
		...config,
		colorStops: config.colorStops.map((stop) => ({
			position: stop.position,
			color: [stop.color[0], stop.color[1], stop.color[2]],
		})),
	};
}

class SavedGradientLimitError extends Error {}

type Stop = AnimatedGradientConfig["colorStops"][number];

function palettePreview(config: AnimatedGradientConfig) {
	const stops = config.colorStops.map(
		(stop) => `rgb(${stop.color.join(",")}) ${stop.position}%`,
	);
	return `linear-gradient(90deg, ${stops.join(",")})`;
}

function controlValue(control: AnimatedGradientControl, value: number) {
	if (control.key === "direction") return `${Math.round(value)}°`;
	if (control.key === MOTION_KEY && value === 0) return "Still";
	return control.step < 1 ? value.toFixed(1) : String(Math.round(value));
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function colorAt(stops: Stop[], position: number): Stop["color"] {
	const first = stops[0];
	const last = stops[stops.length - 1];
	if (!first || !last) return [128, 128, 128];
	if (position <= first.position) return [...first.color];
	if (position >= last.position) return [...last.color];
	for (let index = 0; index < stops.length - 1; index++) {
		const left = stops[index];
		const right = stops[index + 1];
		if (position < left.position || position > right.position) continue;
		const span = right.position - left.position;
		const t = span <= 0 ? 0 : (position - left.position) / span;
		return [0, 1, 2].map((channel) =>
			Math.round(
				left.color[channel] + (right.color[channel] - left.color[channel]) * t,
			),
		) as Stop["color"];
	}
	return [...last.color];
}

function insertStop(stops: Stop[], position: number) {
	if (stops.length >= MAX_STOPS) return null;
	const stop: Stop = { position, color: colorAt(stops, position) };
	let index = stops.findIndex((existing) => existing.position > position);
	if (index === -1) index = stops.length;
	stops.splice(index, 0, stop);
	return index;
}

function largestGapPosition(stops: Stop[]) {
	let position = 50;
	let largestGap = -1;
	for (let index = 0; index < stops.length - 1; index++) {
		const gap = stops[index + 1].position - stops[index].position;
		if (gap > largestGap) {
			largestGap = gap;
			position = Math.round(
				(stops[index].position + stops[index + 1].position) / 2,
			);
		}
	}
	return position;
}

function HeaderButton(props: {
	icon: JSX.Element;
	label: string;
	title?: string;
	disabled?: boolean;
	pressed?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			title={props.title}
			aria-pressed={props.pressed}
			disabled={props.disabled}
			class={cx(
				"flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:opacity-40 disabled:hover:bg-transparent",
				props.pressed ? "bg-gray-3 text-gray-12" : "text-gray-11",
			)}
			onClick={props.onClick}
		>
			<span class="[&>svg]:size-3.5">{props.icon}</span>
			{props.label}
		</button>
	);
}

function ControlRow(props: {
	control: AnimatedGradientControl;
	value: number;
	onChange: (value: number) => void;
}) {
	return (
		<div class="flex items-center gap-3">
			<span class="w-24 shrink-0 truncate text-xs text-gray-11">
				{props.control.label}
			</span>
			<Slider
				class="min-w-0 flex-1"
				value={[props.value]}
				minValue={props.control.min}
				maxValue={props.control.max}
				step={props.control.step}
				formatTooltip={(value) => controlValue(props.control, value)}
				aria-label={props.control.label}
				onChange={([next]) => props.onChange(next)}
			/>
			<span class="w-10 shrink-0 text-right text-xs text-gray-11 tabular-nums">
				{controlValue(props.control, props.value)}
			</span>
		</div>
	);
}

export function AnimatedGradientEditor(props: {
	brandColorSwatches?: OrganizationBrandColorSwatch[];
}) {
	const { project, setProject, projectHistory } = useEditorContext();
	const catalog = createQuery(() => ({
		queryKey: ["animated-gradient-catalog"],
		queryFn: () => commands.animatedGradientCatalog(),
		staleTime: Number.POSITIVE_INFINITY,
	}));
	const library = animatedGradientsStore.createQuery();
	const [presetName, setPresetName] = createSignal("");
	const [saveOpen, setSaveOpen] = createSignal(false);
	const [randomizing, setRandomizing] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	const [deletingId, setDeletingId] = createSignal<string | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [selectedStop, setSelectedStop] = createSignal(0);
	const [fineTuneOpen, setFineTuneOpen] = createSignal(false);
	const [groupName, setGroupName] = createSignal<string | null>(null);
	let disposed = false;
	let revision = 0;
	let barRef!: HTMLDivElement;
	onCleanup(() => {
		disposed = true;
	});

	const config = createMemo(() => {
		const source = project.background.source;
		return source.type === "animatedGradient" ? source.config : null;
	});
	const stops = () => config()?.colorStops ?? [];
	const stopIndex = createMemo(() =>
		clamp(selectedStop(), 0, Math.max(0, stops().length - 1)),
	);
	const savedPresets = () => library.data?.presets ?? [];
	const serializedConfig = createMemo(() => JSON.stringify(config()));
	const isSelected = (preset: AnimatedGradientPreset) =>
		serializedConfig() === JSON.stringify(preset.config);
	const motionControl = createMemo(() =>
		catalog.data?.controls.find((control) => control.key === MOTION_KEY),
	);
	const groups = createMemo(() => {
		const grouped = new Map<string, AnimatedGradientControl[]>();
		for (const control of catalog.data?.controls ?? []) {
			if (control.key === MOTION_KEY) continue;
			const controls = grouped.get(control.group) ?? [];
			controls.push(control);
			grouped.set(control.group, controls);
		}
		return Array.from(grouped, ([name, controls]) => ({ name, controls }));
	});
	const activeGroup = createMemo(
		() => groups().find((group) => group.name === groupName()) ?? groups()[0],
	);

	const updateConfig = (update: (value: AnimatedGradientConfig) => void) => {
		if (disposed || !config()) return;
		revision += 1;
		setProject(
			"background",
			"source",
			produce((source) => {
				if (source.type === "animatedGradient") update(source.config);
			}),
		);
	};

	const applyConfig = (value: AnimatedGradientConfig) => {
		const next = copyAnimatedGradientConfig(value);
		updateConfig((current) => Object.assign(current, next));
	};

	const randomize = async () => {
		if (randomizing() || !config()) return;
		const requestedRevision = revision;
		const requestedConfig = serializedConfig();
		setRandomizing(true);
		setError(null);
		try {
			const next = await commands.randomAnimatedGradient();
			if (
				!disposed &&
				requestedRevision === revision &&
				requestedConfig === serializedConfig()
			)
				applyConfig(next);
		} catch {
			if (!disposed) setError("Could not create a random gradient. Try again.");
		} finally {
			if (!disposed) setRandomizing(false);
		}
	};

	const addStop = (position: number) => {
		let inserted: number | null = null;
		updateConfig((current) => {
			inserted = insertStop(current.colorStops, position);
		});
		if (inserted !== null) setSelectedStop(inserted);
		return inserted;
	};

	const removeStop = (index: number) => {
		updateConfig((current) => {
			if (current.colorStops.length > MIN_STOPS)
				current.colorStops.splice(index, 1);
		});
		setSelectedStop(Math.max(0, index - 1));
	};

	const moveStop = (index: number, position: number) => {
		updateConfig((current) => {
			const stop = current.colorStops[index];
			if (!stop) return;
			stop.position = clamp(
				Math.round(position),
				current.colorStops[index - 1]?.position ?? 0,
				current.colorStops[index + 1]?.position ?? 100,
			);
		});
	};

	const barPosition = (event: PointerEvent) => {
		const rect = barRef.getBoundingClientRect();
		if (rect.width <= 0) return null;
		return Math.round(
			clamp((event.clientX - rect.left) / rect.width, 0, 1) * 100,
		);
	};

	const dragStop = (index: number, event: PointerEvent) => {
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		let resume: (() => void) | null = null;
		const move = (moveEvent: PointerEvent) => {
			const position = barPosition(moveEvent);
			if (position === null) return;
			if (!resume) resume = projectHistory.pause();
			moveStop(index, position);
		};
		const end = () => {
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", end);
			target.removeEventListener("pointercancel", end);
			resume?.();
			resume = null;
		};
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", end);
		target.addEventListener("pointercancel", end);
	};

	const resetFineTune = () => {
		const defaults = catalog.data?.defaultConfig;
		if (!defaults) return;
		updateConfig((current) => {
			for (const group of groups())
				for (const control of group.controls)
					current[control.key] = defaults[control.key];
		});
	};

	const closeSave = () => {
		setSaveOpen(false);
		setPresetName("");
	};

	const savePreset = async () => {
		const currentConfig = config();
		const name = Array.from(presetName().trim()).slice(0, 80).join("");
		if (!currentConfig || !name || saving() || deletingId()) return;
		const savedConfig = copyAnimatedGradientConfig(currentConfig);
		setSaving(true);
		setError(null);
		try {
			await animatedGradientsStore.update((current) => {
				if (current.presets.length >= MAX_SAVED)
					throw new SavedGradientLimitError();
				return {
					...current,
					presets: [
						...current.presets,
						{ id: crypto.randomUUID(), name, config: savedConfig },
					],
				};
			});
			if (disposed) return;
			closeSave();
			await library.refetch();
		} catch (error) {
			if (!disposed)
				setError(
					error instanceof SavedGradientLimitError
						? `You can save up to ${MAX_SAVED} gradients. Delete one to add another.`
						: "Could not save this gradient. Try again.",
				);
		} finally {
			if (!disposed) setSaving(false);
		}
	};

	const deletePreset = async (id: string) => {
		if (saving() || deletingId()) return;
		setDeletingId(id);
		setError(null);
		try {
			await animatedGradientsStore.update((current) => ({
				...current,
				presets: current.presets.filter((preset) => preset.id !== id),
			}));
			if (disposed) return;
			await library.refetch();
		} catch {
			if (!disposed) setError("Could not delete this gradient. Try again.");
		} finally {
			if (!disposed) setDeletingId(null);
		}
	};

	const swatchClass =
		"aspect-square w-full rounded-lg ring-offset-2 ring-offset-gray-200 transition-all duration-200 hover:scale-105 hover:opacity-80";

	return (
		<Show when={config()}>
			{(current) => (
				<div class="flex flex-col gap-5">
					<Show when={error()}>
						<p role="alert" class="text-xs text-red-11">
							{error()}
						</p>
					</Show>

					<Field
						name="Presets"
						value={
							<HeaderButton
								icon={<IconLucideSave />}
								label="Save"
								title="Save the current gradient"
								pressed={saveOpen()}
								disabled={
									saving() ||
									library.isPending ||
									library.isError ||
									savedPresets().length >= MAX_SAVED
								}
								onClick={() => (saveOpen() ? closeSave() : setSaveOpen(true))}
							/>
						}
					>
						<div class="flex flex-col gap-3">
							<div class="grid grid-cols-7 gap-2">
								<button
									type="button"
									title="Randomize"
									aria-label="Randomize gradient"
									disabled={randomizing()}
									class={cx(
										swatchClass,
										"flex items-center justify-center border border-dashed border-gray-8 bg-gray-2 text-gray-10 disabled:opacity-50",
									)}
									onClick={() => void randomize()}
								>
									<IconLucideShuffle class="size-4" />
								</button>
								<For each={catalog.data?.templates ?? []}>
									{(preset) => (
										<button
											type="button"
											title={preset.name}
											aria-label={preset.name}
											aria-pressed={isSelected(preset)}
											class={swatchClass}
											classList={{ "ring-2 ring-gray-500": isSelected(preset) }}
											style={{ background: palettePreview(preset.config) }}
											onClick={() => applyConfig(preset.config)}
										/>
									)}
								</For>
							</div>
							<Show when={saveOpen()}>
								<div class="flex items-center gap-2">
									<Input
										ref={(element) => queueMicrotask(() => element.focus())}
										class="min-w-0 flex-1"
										placeholder="Name this gradient"
										aria-label="Saved gradient name"
										maxLength={80}
										value={presetName()}
										disabled={saving()}
										onInput={(event) =>
											setPresetName(event.currentTarget.value)
										}
										onKeyDown={(event) => {
											if (event.key === "Escape") {
												event.preventDefault();
												closeSave();
											}
											if (event.key !== "Enter") return;
											event.preventDefault();
											void savePreset();
										}}
									/>
									<button
										type="button"
										class="h-8 rounded-lg bg-gray-3 px-3 text-xs font-medium text-gray-12 transition-colors hover:bg-gray-4 disabled:opacity-40"
										disabled={!presetName().trim() || saving()}
										onClick={() => void savePreset()}
									>
										{saving() ? "Saving…" : "Save"}
									</button>
									<button
										type="button"
										aria-label="Cancel"
										class="rounded-md p-1.5 text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
										onClick={closeSave}
									>
										<IconLucideX class="size-3.5" />
									</button>
								</div>
							</Show>
							<Show when={savedPresets().length > 0}>
								<span class="text-[11px] text-gray-10">Saved</span>
								<div class="grid grid-cols-7 gap-2">
									<For each={savedPresets()}>
										{(preset) => (
											<div class="relative">
												<button
													type="button"
													title={preset.name}
													aria-label={preset.name}
													aria-pressed={isSelected(preset)}
													class={swatchClass}
													classList={{
														"ring-2 ring-gray-500": isSelected(preset),
													}}
													style={{ background: palettePreview(preset.config) }}
													onClick={() => applyConfig(preset.config)}
												/>
												<Show when={isSelected(preset)}>
													<button
														type="button"
														title="Delete"
														aria-label={`Delete ${preset.name}`}
														disabled={deletingId() !== null}
														class="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-gray-12 text-gray-1 shadow-sm transition-colors hover:bg-red-11 disabled:opacity-40"
														onClick={() => void deletePreset(preset.id)}
													>
														<IconLucideX class="size-3" />
													</button>
												</Show>
											</div>
										)}
									</For>
								</div>
							</Show>
						</div>
					</Field>

					<div class="w-full border-t border-dashed border-gray-5" />

					<Field
						name="Colours"
						value={
							<HeaderButton
								icon={<IconLucidePlus />}
								label="Add"
								title="Add a colour"
								disabled={current().colorStops.length >= MAX_STOPS}
								onClick={() =>
									addStop(largestGapPosition(current().colorStops))
								}
							/>
						}
					>
						<div class="flex flex-col gap-3">
							<div class="px-3">
								<div
									ref={barRef}
									class="relative h-10"
									onPointerDown={(event) => {
										if (event.button !== 0) return;
										const position = barPosition(event);
										if (position === null) return;
										const index = addStop(position);
										if (index !== null) dragStop(index, event);
									}}
								>
									<div
										class="absolute inset-0 rounded-lg border border-gray-5"
										style={{ background: palettePreview(current()) }}
									/>
									<Index each={current().colorStops}>
										{(stop, index) => {
											const selected = () => stopIndex() === index;
											return (
												<button
													type="button"
													aria-label={`Colour ${index + 1}`}
													aria-pressed={selected()}
													class={cx(
														"absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full p-0.5 shadow-md outline-hidden transition-[width,height] focus-visible:ring-2 focus-visible:ring-blue-9",
														selected() ? "size-6 bg-blue-9" : "size-5 bg-white",
													)}
													style={{ left: `${stop().position}%` }}
													onPointerDown={(event) => {
														if (event.button !== 0) return;
														event.stopPropagation();
														setSelectedStop(index);
														dragStop(index, event);
													}}
													onKeyDown={(event) => {
														const step = event.shiftKey ? 10 : 1;
														if (
															event.key === "ArrowLeft" ||
															event.key === "ArrowRight"
														) {
															event.preventDefault();
															event.stopPropagation();
															moveStop(
																index,
																stop().position +
																	(event.key === "ArrowLeft" ? -step : step),
															);
														}
														if (
															(event.key === "Delete" ||
																event.key === "Backspace") &&
															current().colorStops.length > MIN_STOPS
														) {
															event.preventDefault();
															event.stopPropagation();
															removeStop(index);
														}
													}}
												>
													<span
														class={cx(
															"flex size-full items-center justify-center rounded-full",
															selected() && "bg-white p-0.5",
														)}
													>
														<span
															class="size-full rounded-full"
															style={{
																background: `rgb(${stop().color.join(",")})`,
															}}
														/>
													</span>
												</button>
											);
										}}
									</Index>
								</div>
							</div>
							<Show when={current().colorStops[stopIndex()]}>
								{(stop) => (
									<>
										<div class="flex items-center gap-3">
											<RgbInput
												value={stop().color}
												onChange={(color) =>
													updateConfig((value) => {
														const target = value.colorStops[stopIndex()];
														if (target) target.color = color;
													})
												}
											/>
											<span class="ml-auto text-xs text-gray-11 tabular-nums">
												{Math.round(stop().position)}%
											</span>
											<button
												type="button"
												title="Remove colour"
												aria-label={`Remove colour ${stopIndex() + 1}`}
												disabled={current().colorStops.length <= MIN_STOPS}
												class="rounded-md p-1.5 text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:opacity-30 disabled:hover:bg-transparent"
												onClick={() => removeStop(stopIndex())}
											>
												<IconLucideTrash2 class="size-3.5" />
											</button>
										</div>
										<BrandColorsDropdown
											swatches={props.brandColorSwatches ?? []}
											onSelect={(hex) => {
												const color = hexToRgb(hex);
												if (!color) return;
												updateConfig((value) => {
													const target = value.colorStops[stopIndex()];
													if (target)
														target.color = [color[0], color[1], color[2]];
												});
											}}
										/>
									</>
								)}
							</Show>
						</div>
					</Field>

					<div class="w-full border-t border-dashed border-gray-5" />

					<Show when={motionControl()}>
						{(control) => (
							<Subfield name="Motion" class="gap-4">
								<div class="flex min-w-0 flex-1 items-center gap-3">
									<Slider
										class="min-w-0 flex-1"
										value={[current()[MOTION_KEY]]}
										minValue={control().min}
										maxValue={control().max}
										step={control().step}
										formatTooltip={(value) => controlValue(control(), value)}
										aria-label="Motion speed"
										onChange={([next]) =>
											updateConfig((value) => {
												value[MOTION_KEY] = next;
											})
										}
									/>
									<span class="w-10 shrink-0 text-right text-xs text-gray-11 tabular-nums">
										{controlValue(control(), current()[MOTION_KEY])}
									</span>
								</div>
							</Subfield>
						)}
					</Show>

					<div class="w-full border-t border-dashed border-gray-5" />

					<KCollapsible open={fineTuneOpen()} onOpenChange={setFineTuneOpen}>
						<div class="flex items-center">
							<KCollapsible.Trigger class="group flex flex-1 items-center gap-1.5 text-sm font-medium text-gray-12 outline-hidden">
								Fine-tune
								<IconCapChevronDown class="size-3.5 text-gray-10 transition-transform duration-200 group-data-expanded:rotate-180" />
							</KCollapsible.Trigger>
							<Show when={fineTuneOpen()}>
								<HeaderButton
									icon={<IconLucideRotateCcw />}
									label="Reset"
									title="Reset fine-tune settings"
									onClick={resetFineTune}
								/>
							</Show>
						</div>
						<KCollapsible.Content class="overflow-hidden opacity-0 transition-opacity animate-collapsible-up data-expanded:animate-collapsible-down data-expanded:opacity-100">
							<div class="flex flex-col gap-3 pt-4">
								<div
									role="tablist"
									class="grid grid-cols-4 gap-1 rounded-lg border border-gray-3 bg-gray-2 p-1"
								>
									<For each={groups()}>
										{(group) => (
											<button
												type="button"
												role="tab"
												aria-selected={activeGroup()?.name === group.name}
												class={cx(
													"rounded-md py-1 text-xs font-medium transition-colors",
													activeGroup()?.name === group.name
														? "bg-gray-5 text-gray-12"
														: "text-gray-10 hover:text-gray-12",
												)}
												onClick={() => setGroupName(group.name)}
											>
												{group.name}
											</button>
										)}
									</For>
								</div>
								<div class="flex flex-col gap-1">
									<For each={activeGroup()?.controls ?? []}>
										{(control) => (
											<ControlRow
												control={control}
												value={current()[control.key]}
												onChange={(next) =>
													updateConfig((value) => {
														value[control.key] = next;
													})
												}
											/>
										)}
									</For>
								</div>
							</div>
						</KCollapsible.Content>
					</KCollapsible>
				</div>
			)}
		</Show>
	);
}
