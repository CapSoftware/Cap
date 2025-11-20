import { Button } from "@cap/ui-solid";
import { NumberField } from "@kobalte/core/number-field";
import { makePersisted } from "@solid-primitives/storage";
import { convertFileSrc } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import {
	createEffect,
	createSignal,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { Transition } from "solid-transition-group";
import {
	CROP_ZERO,
	type CropBounds,
	Cropper,
	type CropperRef,
	createCropOptionsMenuItems,
	type Ratio,
} from "~/components/Cropper";
import { composeEventHandlers } from "~/utils/composeEventHandlers";
import IconCapCircleX from "~icons/cap/circle-x";
import IconLucideMaximize from "~icons/lucide/maximize";
import IconLucideRatio from "~icons/lucide/ratio";
import { useScreenshotEditorContext } from "./context";
import { ExportDialog } from "./ExportDialog";
import { Header } from "./Header";
import { Preview } from "./Preview";
import { Dialog, DialogContent, EditorButton, Input, Subfield } from "./ui";

export function Editor() {
	const [zoom, setZoom] = createSignal(1);
	const {
		projectHistory,
		setActiveTool,
		setProject,
		project,
		setSelectedAnnotationId,
	} = useScreenshotEditorContext();

	createEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Ignore if typing in an input or contenteditable
			const target = e.target as HTMLElement;
			if (
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable
			) {
				return;
			}

			const isMod = e.metaKey || e.ctrlKey;
			const isShift = e.shiftKey;

			// Undo / Redo
			if (isMod && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (isShift) {
					projectHistory.redo();
				} else {
					projectHistory.undo();
				}
				return;
			}
			if (isMod && e.key.toLowerCase() === "y") {
				e.preventDefault();
				projectHistory.redo();
				return;
			}

			// Tools (No modifiers)
			if (!isMod && !isShift) {
				switch (e.key.toLowerCase()) {
					case "a":
						setActiveTool("arrow");
						setSelectedAnnotationId(null);
						break;
					case "r":
						setActiveTool("rectangle");
						setSelectedAnnotationId(null);
						break;
					case "c":
					case "o": // Support 'o' for oval/circle too
						setActiveTool("circle");
						setSelectedAnnotationId(null);
						break;
					case "t":
						setActiveTool("text");
						setSelectedAnnotationId(null);
						break;
					case "v":
					case "s":
					case "escape":
						setActiveTool("select");
						setSelectedAnnotationId(null);
						break;
					case "p": {
						// Toggle Padding
						// We need to push history here too if we want undo for padding
						projectHistory.push();
						const currentPadding = project.background.padding;
						setProject("background", "padding", currentPadding === 0 ? 20 : 0);
						break;
					}
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
	});

	return (
		<>
			<Header zoom={zoom()} setZoom={setZoom} />
			<div
				class="flex overflow-y-hidden flex-col flex-1 gap-0 pb-0 w-full min-h-0 leading-5 animate-in fade-in"
				data-tauri-drag-region
			>
				<div class="flex overflow-hidden flex-col flex-1 min-h-0">
					<div class="flex overflow-y-hidden flex-row flex-1 min-h-0">
						<Preview zoom={zoom()} setZoom={setZoom} />
					</div>
				</div>
				<Dialogs />
			</div>
		</>
	);
}

function Dialogs() {
	const { dialog, setDialog, project, setProject, path } =
		useScreenshotEditorContext();

	return (
		<Dialog.Root
			size={(() => {
				const d = dialog();
				if ("type" in d && d.type === "crop") return "lg";
				return "sm";
			})()}
			contentClass={(() => {
				const d = dialog();
				// if ("type" in d && d.type === "export") return "max-w-[740px]";
				return "";
			})()}
			open={dialog().open}
			onOpenChange={(o) => {
				if (!o) setDialog((d) => ({ ...d, open: false }));
			}}
		>
			<Show
				when={(() => {
					const d = dialog();
					if ("type" in d) return d;
				})()}
			>
				{(dialog) => (
					<Switch>
						<Match when={dialog().type === "export"}>
							<ExportDialog />
						</Match>
						<Match
							when={(() => {
								const d = dialog();
								if (d.type === "crop") return d;
							})()}
						>
							{(dialog) => {
								let cropperRef: CropperRef | undefined;
								const [crop, setCrop] = createSignal(CROP_ZERO);
								const [aspect, setAspect] = createSignal<Ratio | null>(null);

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

								async function showCropOptionsMenu(
									e: UIEvent,
									positionAtCursor = false,
								) {
									e.preventDefault();
									const items = createCropOptionsMenuItems({
										aspect: aspect(),
										snapToRatioEnabled: snapToRatio(),
										onAspectSet: setAspect,
										onSnapToRatioSet: setSnapToRatioEnabled,
									});
									const menu = await Menu.new({ items });
									let pos: LogicalPosition | undefined;
									if (!positionAtCursor) {
										const rect = (
											e.target as HTMLDivElement
										).getBoundingClientRect();
										pos = new LogicalPosition(rect.x, rect.y + 40);
									}
									await menu.popup(pos);
									await menu.close();
								}

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
										>
											<NumberField.Input
												class="rounded-[0.5rem] bg-gray-2 hover:ring-1 py-[18px] hover:ring-gray-5 h-[2rem] font-normal placeholder:text-black-transparent-40 text-xs caret-gray-500 transition-shadow duration-200 focus:ring-offset-1 focus:bg-gray-3 focus:ring-offset-gray-100 focus:ring-1 focus:ring-gray-10 px-[0.5rem] w-full text-[0.875rem] outline-none text-gray-12"
												onKeyDown={composeEventHandlers<HTMLInputElement>([
													(e) => e.stopPropagation(),
												])}
											/>
										</NumberField>
									);
								}

								return (
									<>
										<Dialog.Header>
											<div class="flex flex-row space-x-[2rem]">
												<div class="flex flex-row items-center space-x-[0.75rem] text-gray-11">
													<span>Size</span>
													<div class="w-[3.25rem]">
														<BoundInput field="width" max={dialog().size.x} />
													</div>
													<span>×</span>
													<div class="w-[3.25rem]">
														<BoundInput field="height" max={dialog().size.y} />
													</div>
												</div>
												<div class="flex flex-row items-center space-x-[0.75rem] text-gray-11">
													<span>Position</span>
													<div class="w-[3.25rem]">
														<BoundInput field="x" />
													</div>
													<span>×</span>
													<div class="w-[3.25rem]">
														<BoundInput field="y" />
													</div>
												</div>
											</div>
											<div class="flex flex-row gap-3 justify-end items-center w-full">
												<div class="flex flex-row items-center space-x-[0.5rem] text-gray-11"></div>

												<Button
													variant="white"
													size="xs"
													class="flex items-center justify-center text-center rounded-full h-[2rem] w-[2rem] border focus:border-blue-9"
													onMouseDown={showCropOptionsMenu}
													onClick={showCropOptionsMenu}
												>
													<div class="relative pointer-events-none size-4">
														<Show when={!aspect()}>
															<IconLucideRatio class="group-active:scale-90 transition-transform size-4 pointer-events-none *:pointer-events-none" />
														</Show>
														<Transition
															enterClass="scale-50 opacity-0 blur-md"
															enterActiveClass="duration-200 [transition-timing-function:cubic-bezier(0.215,0.61,0.355,1)]"
															enterToClass="scale-100 opacity-100 blur-0"
															exitClass="opacity-0"
															exitActiveClass="duration-0"
															exitToClass="opacity-0"
														>
															<Show when={aspect()} keyed>
																{(ratio) => (
																	<span class="flex absolute inset-0 justify-center items-center text-xs font-medium tracking-tight leading-none pointer-events-none text text-blue-10">
																		{ratio[0]}:{ratio[1]}
																	</span>
																)}
															</Show>
														</Transition>
													</div>
												</Button>

												<EditorButton
													leftIcon={<IconLucideMaximize />}
													onClick={() => cropperRef?.fill()}
													disabled={
														crop().width === dialog().size.x &&
														crop().height === dialog().size.y
													}
												>
													Full
												</EditorButton>
												<EditorButton
													leftIcon={<IconCapCircleX />}
													onClick={() => {
														cropperRef?.reset();
														setAspect(null);
													}}
													disabled={
														crop().x === dialog().position.x &&
														crop().y === dialog().position.y &&
														crop().width === dialog().size.x &&
														crop().height === dialog().size.y
													}
												>
													Reset
												</EditorButton>
											</div>
										</Dialog.Header>
										<Dialog.Content>
											<div class="flex flex-row justify-center">
												<div class="rounded divide-black-transparent-10">
													<Cropper
														ref={cropperRef}
														onCropChange={setCrop}
														aspectRatio={aspect() ?? undefined}
														targetSize={{
															x: dialog().size.x,
															y: dialog().size.y,
														}}
														initialCrop={initialBounds}
														snapToRatioEnabled={snapToRatio()}
														useBackdropFilter={true}
														allowLightMode={true}
														onContextMenu={(e) => showCropOptionsMenu(e, true)}
													>
														<img
															class="shadow pointer-events-none max-h-[70vh]"
															alt="screenshot"
															src={convertFileSrc(path)}
														/>
													</Cropper>
												</div>
											</div>
										</Dialog.Content>
										<Dialog.Footer>
											<Button
												onClick={() => {
													const bounds = crop();
													setProject("background", "crop", {
														position: {
															x: bounds.x,
															y: bounds.y,
														},
														size: {
															x: bounds.width,
															y: bounds.height,
														},
													});
													setDialog((d) => ({ ...d, open: false }));
												}}
											>
												Save
											</Button>
										</Dialog.Footer>
									</>
								);
							}}
						</Match>
					</Switch>
				)}
			</Show>
		</Dialog.Root>
	);
}
