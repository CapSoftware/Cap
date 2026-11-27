import { Dialog as KDialog } from "@kobalte/core/dialog";
import { NumberField } from "@kobalte/core/number-field";
import { createEventListener } from "@solid-primitives/event-listener";
import { debounce, throttle } from "@solid-primitives/scheduled";
import { makePersisted } from "@solid-primitives/storage";
import { cx } from "cva";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	Show,
} from "solid-js";
import toast from "solid-toast";
import {
	COMMON_RATIOS,
	CROP_ZERO,
	type CropBounds,
	Cropper,
	type CropperRef,
	createCropOptionsMenuItems,
	type Ratio,
} from "~/components/Cropper";
import { Toggle } from "~/components/Toggle";
import { composeEventHandlers } from "~/utils/composeEventHandlers";
import { showContextMenu } from "../../../engine/context-menu";
import { commands } from "../../../engine/editor-api";
import { resolveEditorAssetUrl } from "../../../engine/editor-asset-url";
import { FPS, type ModalDialog, useEditorContext } from "./context";
import { getPreviewProjectConfig } from "./preview-config";
import { editorLayout } from "./responsive-layout";
import { EditorButton } from "./ui";

type CropDialogState = Extract<ModalDialog, { type: "crop" }>;

export function CropDialog(props: { dialog: Accessor<CropDialogState> }) {
	const dialog = props.dialog;
	const { project, setDialog } = useEditorContext();
	const layout = editorLayout();
	const {
		setProject: setState,
		styleScopeToken,
		editorInstance,
		editorState,
		canvasControls,
		latestFrame,
		previewResolutionBase,
	} = useEditorContext();
	const display = editorInstance.recordings.segments[0].display;
	const cropTarget = dialog().styleTarget ?? null;
	const cropToken = dialog().scopeToken;
	const cropStyle =
		cropTarget === null ? null : project.timeline?.styleSegments[cropTarget];
	const cropTargetValid = () =>
		(!cropToken || cropToken === styleScopeToken()) &&
		(cropTarget === null ||
			project.timeline?.styleSegments[cropTarget] === cropStyle);

	let cropperRef: CropperRef | undefined;
	let previewCanvas: HTMLCanvasElement | undefined;
	const [crop, setCrop] = createSignal(CROP_ZERO);
	const [aspect, setAspect] = createSignal<Ratio | null>(null);

	const [frameUrl, setFrameUrl] = createSignal<string | null>(null);
	const [frameLoaded, setFrameLoaded] = createSignal(false);
	const [frameError, setFrameError] = createSignal(false);
	const [previewReady, setPreviewReady] = createSignal(false);
	const screenshotSrc = resolveEditorAssetUrl(
		`${editorInstance.path}/screenshots/display.jpg`,
	);

	let cancelled = false;

	void commands
		.getDisplayFrameForCropping(FPS)
		.then((bytes) => {
			if (cancelled) return;
			setFrameUrl(
				URL.createObjectURL(
					new Blob([new Uint8Array(bytes)], {
						type: "image/jpeg",
					}),
				),
			);
		})
		.catch((error: unknown) => {
			if (cancelled) return;
			console.warn("Display frame fetch failed:", error);
			setFrameError(true);
		});

	const [viewport, setViewport] = createSignal({
		w: window.innerWidth,
		h: window.innerHeight,
	});
	const onViewportResize = () =>
		setViewport({
			w: window.innerWidth,
			h: window.innerHeight,
		});
	window.addEventListener("resize", onViewportResize);

	const boxSize = createMemo(() => {
		const { w: vw, h: vh } = viewport();
		const ratio = display.width / display.height;
		const stacked = layout.compact() && vw < vh * 1.25;
		const maxW = layout.compact()
			? Math.max(120, vw - (stacked ? 56 : 380))
			: Math.max(120, Math.min(vw - 164, 1280)) * 0.68;
		const maxH = layout.compact()
			? Math.max(120, stacked ? vh * 0.42 : vh - 180)
			: Math.max(100, Math.min(vh - 280, 760));
		let w = maxW;
		let h = w / ratio;
		if (h > maxH) {
			h = maxH;
			w = h * ratio;
		}
		return { w: Math.round(w), h: Math.round(h) };
	});

	const currentFrameNumber = () =>
		Math.max(
			Math.floor((editorState.previewTime ?? editorState.playbackTime) * FPS),
			0,
		);

	const drawPreview = () => {
		if (
			previewCanvas &&
			canvasControls()?.drawLatestFrameToCanvas(previewCanvas)
		) {
			if (!previewReady()) setPreviewReady(true);
		}
	};

	let configUpdateInFlight = false;
	let pendingConfig: {
		config: ReturnType<typeof getPreviewProjectConfig>;
		frameNumber: number;
		resolutionBase: ReturnType<typeof previewResolutionBase>;
	} | null = null;

	const flushConfig = async () => {
		if (configUpdateInFlight) return;
		const next = pendingConfig;
		if (!next) return;
		pendingConfig = null;
		configUpdateInFlight = true;
		try {
			await commands.updateProjectConfigInMemory(
				next.config,
				next.frameNumber,
				FPS,
				next.resolutionBase,
			);
		} catch (e) {
			console.error("[Crop] preview render failed:", e);
		} finally {
			configUpdateInFlight = false;
			if (pendingConfig) void flushConfig();
		}
	};

	const queueConfig = (bounds: CropBounds | null) => {
		const config = getPreviewProjectConfig(project, editorState);
		if (bounds) {
			if (!cropTargetValid()) return;
			const nextCrop = {
				position: { x: bounds.x, y: bounds.y },
				size: { x: bounds.width, y: bounds.height },
			};
			if (cropTarget === null)
				config.background = {
					...config.background,
					crop: nextCrop,
				};
			else if (config.timeline) {
				config.timeline = {
					...config.timeline,
					styleSegments: config.timeline.styleSegments.map((segment, index) =>
						index === cropTarget
							? {
									...segment,
									overrides: {
										...segment.overrides,
										background: {
											...(segment.overrides.background ?? config.background),
											crop: nextCrop,
										},
									},
								}
							: segment,
					),
				};
			}
		}
		pendingConfig = {
			config,
			frameNumber: currentFrameNumber(),
			resolutionBase: previewResolutionBase(),
		};
		void flushConfig();
	};

	const throttledConfig = throttle(queueConfig, 1000 / FPS);
	const trailingConfig = debounce(queueConfig, 1000 / FPS + 16);

	let lastPushed: CropBounds = {
		x: dialog().position.x,
		y: dialog().position.y,
		width: dialog().size.x,
		height: dialog().size.y,
	};

	createEffect(
		on(
			crop,
			(bounds) => {
				if (bounds.width <= 0 || bounds.height <= 0) return;
				if (
					bounds.x === lastPushed.x &&
					bounds.y === lastPushed.y &&
					bounds.width === lastPushed.width &&
					bounds.height === lastPushed.height
				)
					return;
				lastPushed = bounds;
				throttledConfig(bounds);
				trailingConfig(bounds);
			},
			{ defer: true },
		),
	);

	createEffect(on(latestFrame, () => drawPreview()));

	onCleanup(() => {
		cancelled = true;
		window.removeEventListener("resize", onViewportResize);
		throttledConfig.clear();
		trailingConfig.clear();
		const url = frameUrl();
		if (url) URL.revokeObjectURL(url);
		queueConfig(null);
	});

	const initialBounds = {
		x: dialog().position.x,
		y: dialog().position.y,
		width: dialog().size.x,
		height: dialog().size.y,
	};

	const [snapToRatio, setSnapToRatioEnabled] = makePersisted(
		createSignal(true),
		{ name: "editorCropSnapToRatio" },
	);

	async function showCropOptionsMenu(e: UIEvent, positionAtCursor = false) {
		e.preventDefault();
		e.stopPropagation();
		const items = createCropOptionsMenuItems({
			aspect: aspect(),
			snapToRatioEnabled: snapToRatio(),
			onAspectSet: setAspect,
			onSnapToRatioSet: setSnapToRatioEnabled,
		});
		let position: { x: number; y: number } | undefined;
		if (!positionAtCursor) {
			const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
			position = { x: rect.x, y: rect.y + 40 };
		}
		showContextMenu(items, position);
	}

	const saveCrop = () => {
		const bounds = crop();
		if (!frameLoaded() || bounds.width <= 0 || bounds.height <= 0) return;
		if (!cropTargetValid()) {
			toast.error("Crop target changed. Reopen Crop to continue.");
			return;
		}
		const nextCrop = {
			position: { x: bounds.x, y: bounds.y },
			size: { x: bounds.width, y: bounds.height },
		};
		if (cropTarget === null) setState("background", "crop", nextCrop);
		else
			setState(
				"timeline",
				"styleSegments",
				cropTarget,
				"overrides",
				"background",
				"crop",
				nextCrop,
			);
		setDialog((d) => ({ ...d, open: false }));
	};

	const closeCrop = () => setDialog((d) => ({ ...d, open: false }));
	const styleScopeLabel =
		cropTarget === null ? null : `Editing Style ${cropTarget + 1} only`;

	createEventListener(window, "keydown", (e: KeyboardEvent) => {
		if (e.key !== "Enter" || e.isComposing) return;
		const target = e.target as HTMLElement | null;
		if (
			target?.tagName === "INPUT" ||
			target?.tagName === "TEXTAREA" ||
			target?.isContentEditable ||
			target?.closest("button")
		)
			return;
		e.preventDefault();
		saveCrop();
	});

	const isFull = () =>
		crop().width === display.width && crop().height === display.height;
	const isCentered = () =>
		crop().x === Math.round((display.width - crop().width) / 2) &&
		crop().y === Math.round((display.height - crop().height) / 2);
	const isUntouched = () =>
		crop().x === dialog().position.x &&
		crop().y === dialog().position.y &&
		crop().width === dialog().size.x &&
		crop().height === dialog().size.y &&
		aspect() === null;

	const ratioLabel = (ratio: Ratio | null) =>
		ratio ? `${ratio[0]}:${ratio[1]}` : "Free";
	const ratioSelected = (ratio: Ratio | null) => {
		const current = aspect();
		if (!ratio || !current) return ratio === current;
		return current[0] === ratio[0] && current[1] === ratio[1];
	};

	function BoundInput(props: {
		field: keyof CropBounds;
		min?: number;
		max?: number;
	}) {
		return (
			<NumberField
				value={crop()[props.field]}
				minValue={props.min}
				maxValue={props.max}
				onRawValueChange={(v) => {
					cropperRef?.setCropProperty(props.field, v);
				}}
				changeOnWheel={true}
				format={false}
				class="w-[60px]"
			>
				<NumberField.Input
					class="h-7 w-full rounded-[7px] border-0 bg-ed-ctl px-2 text-[12.5px] text-ed-text-1 caret-ed-accent tabular-nums outline-hidden transition-[background-color,box-shadow] duration-150 hover:bg-ed-ctl-hover focus:bg-ed-ctl-hover focus:ring-1 focus:ring-ed-accent"
					onKeyDown={composeEventHandlers<HTMLInputElement>([
						(e) => e.stopPropagation(),
					])}
				/>
			</NumberField>
		);
	}

	const inspectorLabel = "text-xs font-medium text-ed-text-2";
	const inspectorRow = "flex h-7 items-center justify-between gap-3";
	const actionButton =
		"flex h-7 flex-1 items-center justify-center rounded-[7px] bg-ed-ctl text-xs font-medium text-ed-text-1 outline-hidden transition-colors duration-100 enabled:hover:bg-ed-ctl-hover enabled:active:bg-ed-ctl-active focus-visible:ring-1 focus-visible:ring-ed-accent disabled:opacity-45";

	return (
		<>
			<div class="flex h-[52px] shrink-0 items-center justify-between px-5">
				<KDialog.Title class="text-sm font-semibold text-ed-text-1">
					Crop
				</KDialog.Title>
				<EditorButton
					leftIcon={<IconLucideX />}
					tooltipText="Close"
					onClick={closeCrop}
				/>
			</div>
			<div data-crop-body class="flex items-stretch gap-4 px-5">
				<div
					class="relative flex items-center justify-center rounded-xl bg-ed-stage p-4"
					style={{ width: `${boxSize().w + 32}px` }}
				>
					<div
						class="relative transition-opacity duration-200"
						classList={{ "opacity-0": !frameLoaded() }}
						style={{
							width: `${boxSize().w}px`,
							height: `${boxSize().h}px`,
						}}
					>
						<Cropper
							ref={cropperRef}
							onCropChange={setCrop}
							aspectRatio={aspect() ?? undefined}
							targetSize={{
								x: display.width,
								y: display.height,
							}}
							initialCrop={initialBounds}
							snapToRatioEnabled={snapToRatio()}
							useBackdropFilter={true}
							allowLightMode={true}
							appearance="editor"
							snapToAlignmentEnabled={true}
							onContextMenu={(e) => showCropOptionsMenu(e, true)}
						>
							<img
								class="block h-full w-full select-none pointer-events-none"
								alt="Current frame"
								onError={() => {
									const url = frameUrl();
									if (url) {
										setFrameUrl(null);
										URL.revokeObjectURL(url);
									}
									setFrameError(true);
								}}
								onLoad={() => setFrameLoaded(true)}
								src={frameUrl() ?? (frameError() ? screenshotSrc : undefined)}
							/>
						</Cropper>
					</div>
					<Show when={!frameLoaded()}>
						<div class="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 rounded-xl bg-ed-stage">
							<div class="size-6 animate-spin rounded-full border-2 border-ed-line-strong border-t-ed-accent" />
							<span class="text-xs font-medium text-ed-text-2">
								Loading frame…
							</span>
						</div>
					</Show>
				</div>

				<div
					data-crop-panel
					class="flex w-[300px] shrink-0 flex-col gap-3 rounded-xl bg-ed-card-2 p-3.5"
				>
					<span class={inspectorLabel}>Preview</span>
					<div class="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-ed-stage">
						<canvas
							ref={previewCanvas}
							class="block max-h-full max-w-full object-contain"
						/>
						<Show when={!previewReady()}>
							<div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ed-stage">
								<div class="size-5 animate-spin rounded-full border-2 border-ed-line-strong border-t-ed-accent" />
								<span class="text-[11px] font-medium text-ed-text-3">
									Rendering preview…
								</span>
							</div>
						</Show>
					</div>

					<div class="h-px bg-ed-line" />

					<span class={inspectorLabel}>Aspect ratio</span>
					<div class="grid grid-cols-3 gap-1.5">
						<For each={[null, ...COMMON_RATIOS]}>
							{(ratio) => (
								<button
									type="button"
									class="flex h-7 items-center justify-center rounded-[7px] text-xs font-medium tabular-nums outline-hidden transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-ed-accent"
									classList={{
										"bg-ed-accent/12 text-ed-accent-ink ring-1 ring-inset ring-ed-accent":
											ratioSelected(ratio),
										"bg-ed-ctl text-ed-text-2 hover:bg-ed-ctl-hover hover:text-ed-text-1":
											!ratioSelected(ratio),
									}}
									aria-pressed={ratioSelected(ratio)}
									onClick={() => setAspect(ratio)}
								>
									{ratioLabel(ratio)}
								</button>
							)}
						</For>
					</div>
					<div class={inspectorRow}>
						<span class="text-xs text-ed-text-2">Snap to ratios</span>
						<Toggle
							size="sm"
							checked={snapToRatio()}
							onChange={setSnapToRatioEnabled}
						/>
					</div>

					<div class="h-px bg-ed-line" />

					<div class={inspectorRow}>
						<span class="text-xs text-ed-text-2">Size</span>
						<div class="flex items-center gap-1.5">
							<BoundInput field="width" max={display.width} />
							<span class="w-2 text-center text-xs text-ed-text-3">×</span>
							<BoundInput field="height" max={display.height} />
						</div>
					</div>
					<div class={inspectorRow}>
						<span class="text-xs text-ed-text-2">Position</span>
						<div class="flex items-center gap-1.5">
							<BoundInput field="x" />
							<span class="w-2" />
							<BoundInput field="y" />
						</div>
					</div>

					<div class="h-px bg-ed-line" />

					<div class="flex gap-1.5">
						<button
							type="button"
							class={actionButton}
							disabled={isCentered()}
							onClick={() => {
								const bounds = crop();
								cropperRef?.animateTo({
									...bounds,
									x: Math.round((display.width - bounds.width) / 2),
									y: Math.round((display.height - bounds.height) / 2),
								});
							}}
						>
							Center
						</button>
						<button
							type="button"
							class={actionButton}
							disabled={isFull()}
							onClick={() => cropperRef?.fill()}
						>
							Full
						</button>
						<button
							type="button"
							class={actionButton}
							disabled={isUntouched()}
							onClick={() => {
								cropperRef?.reset();
								setAspect(null);
							}}
						>
							Reset
						</button>
					</div>
				</div>
			</div>
			<p class="px-5 pt-3 pb-5 text-center text-xs text-ed-text-3">
				Drag to move · Arrow keys nudge · Hold{" "}
				<kbd class="rounded-[4px] bg-ed-ctl px-1 font-sans text-ed-text-2">
					⇧
				</kbd>{" "}
				to skip snapping
			</p>
			<div class="flex h-14 shrink-0 items-center justify-between gap-3 border-t border-ed-line px-5">
				<div class="min-w-0 text-xs text-ed-text-2">
					<Show
						when={cropTargetValid()}
						fallback={
							<p role="alert" class="text-orange-11">
								Crop target changed. Close and reopen Crop to continue.
							</p>
						}
					>
						<Show when={styleScopeLabel}>{(label) => <p>{label()}</p>}</Show>
					</Show>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<EditorButton onClick={closeCrop}>Cancel</EditorButton>
					<button
						type="button"
						class={cx(
							"flex h-[30px] shrink-0 items-center justify-center rounded-lg px-3.5 text-[13px] font-medium text-white outline-hidden",
							"bg-linear-to-b from-ed-accent-2 to-ed-accent",
							"shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(0,60,160,0.25)]",
							"transition-[filter,opacity] duration-150 ease-out",
							"enabled:hover:brightness-[1.06] enabled:active:brightness-[0.96] disabled:opacity-45",
						)}
						disabled={
							!frameLoaded() ||
							crop().width <= 0 ||
							crop().height <= 0 ||
							!cropTargetValid()
						}
						onClick={saveCrop}
					>
						Save
					</button>
				</div>
			</div>
		</>
	);
}
