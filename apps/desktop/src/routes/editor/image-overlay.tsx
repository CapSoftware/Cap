import { createEventListener } from "@solid-primitives/event-listener";
import { For, onCleanup, Show } from "solid-js";
import { unwrap } from "solid-js/store";
import { useCanvasSnapTargets } from "./CanvasElementsOverlay";
import { useEditorContext } from "./context";
import { resizeImage } from "./images";
import { SNAP_PX, snapMovingRect } from "./snapping";

export function ImageOverlay(props: {
	size: { width: number; height: number };
}) {
	const {
		project,
		setProject,
		editorState,
		setEditorState,
		projectHistory,
		setSnapGuides,
	} = useEditorContext();
	const snapTargets = useCanvasSnapTargets();
	const time = () => editorState.previewTime ?? editorState.playbackTime;
	const visible = () =>
		(project.timeline?.imageSegments ?? [])
			.map((segment, index) => ({ segment, index }))
			.filter(
				({ segment }) =>
					segment.enabled && time() >= segment.start && time() < segment.end,
			)
			.sort((a, b) => a.segment.track - b.segment.track || a.index - b.index);
	const selected = (index: number) =>
		editorState.timeline.selection?.type === "image" &&
		editorState.timeline.selection.indices.includes(index);
	let endDrag: (() => void) | undefined;
	onCleanup(() => endDrag?.());

	function drag(
		event: MouseEvent,
		index: number,
		mode: "move" | "rotate" | { x: number; y: number },
	) {
		if (event.button !== 0 || editorState.playing) return;
		event.preventDefault();
		event.stopPropagation();
		endDrag?.();
		const source = project.timeline?.imageSegments[index];
		if (!source) return;
		setEditorState("timeline", "selection", {
			type: "image",
			indices: [index],
		});
		const initial = structuredClone(unwrap(source));
		const canvas = { ...props.size };
		const rect = (event.currentTarget as HTMLElement)
			.closest("[data-image-overlay]")
			?.getBoundingClientRect();
		const center = rect
			? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
			: { x: event.clientX, y: event.clientY };
		const startAngle = Math.atan2(
			event.clientY - center.y,
			event.clientX - center.x,
		);
		const targets = snapTargets({ image: index });
		const resume = projectHistory.pause();
		let moved = false;
		const move = (next: MouseEvent) => {
			if (project.timeline?.imageSegments[index] !== source) return;
			const delta = {
				x: next.clientX - event.clientX,
				y: next.clientY - event.clientY,
			};
			if (!moved && Math.hypot(delta.x, delta.y) < 2) return;
			moved = true;
			if (mode === "rotate") {
				let rotation =
					initial.rotation +
					((Math.atan2(next.clientY - center.y, next.clientX - center.x) -
						startAngle) *
						180) /
						Math.PI;
				if (next.shiftKey) rotation = Math.round(rotation / 15) * 15;
				setProject(
					"timeline",
					"imageSegments",
					index,
					"rotation",
					((((rotation + 180) % 360) + 360) % 360) - 180,
				);
			} else if (mode === "move") {
				const radians = (initial.rotation * Math.PI) / 180;
				const width = initial.size.x * canvas.width;
				const height = initial.size.y * canvas.height;
				const w =
					(Math.abs(width * Math.cos(radians)) +
						Math.abs(height * Math.sin(radians))) /
					canvas.width;
				const h =
					(Math.abs(width * Math.sin(radians)) +
						Math.abs(height * Math.cos(radians))) /
					canvas.height;
				const raw = {
					x: initial.center.x + delta.x / canvas.width - w / 2,
					y: initial.center.y + delta.y / canvas.height - h / 2,
					w,
					h,
				};
				const snap = next.shiftKey
					? { dx: 0, dy: 0, guides: [] }
					: snapMovingRect(
							raw,
							targets,
							SNAP_PX / canvas.width,
							SNAP_PX / canvas.height,
						);
				setSnapGuides(snap.guides);
				setProject("timeline", "imageSegments", index, "center", {
					x: Math.max(0, Math.min(1, raw.x + w / 2 + snap.dx)),
					y: Math.max(0, Math.min(1, raw.y + h / 2 + snap.dy)),
				});
			} else
				setProject(
					"timeline",
					"imageSegments",
					index,
					resizeImage(initial, delta, mode, canvas),
				);
		};
		const finish = (next?: MouseEvent) => {
			if (!endDrag) return;
			if (next) move(next);
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", finish);
			window.removeEventListener("blur", cancel);
			endDrag = undefined;
			setSnapGuides([]);
			resume();
		};
		const cancel = () => finish();
		endDrag = cancel;
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", finish);
		window.addEventListener("blur", cancel);
	}

	createEventListener(window, "keydown", (event) => {
		if (
			editorState.playing ||
			(event.target instanceof HTMLElement &&
				(event.target.isContentEditable ||
					["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)))
		)
			return;
		const direction = {
			ArrowLeft: [-1, 0],
			ArrowRight: [1, 0],
			ArrowUp: [0, -1],
			ArrowDown: [0, 1],
		}[event.key];
		if (!direction) return;
		const items = visible().filter(({ index }) => selected(index));
		if (!items.length) return;
		event.preventDefault();
		const resume = projectHistory.pause();
		for (const { segment, index } of items) {
			const step = event.shiftKey ? 10 : 1;
			setProject("timeline", "imageSegments", index, "center", {
				x: Math.max(
					0,
					Math.min(
						1,
						segment.center.x + (direction[0] * step) / props.size.width,
					),
				),
				y: Math.max(
					0,
					Math.min(
						1,
						segment.center.y + (direction[1] * step) / props.size.height,
					),
				),
			});
		}
		resume();
	});

	return (
		<div class="pointer-events-none absolute inset-0">
			<Show when={!editorState.playing}>
				<For each={visible()}>
					{({ segment, index }) => (
						<div
							data-image-overlay
							class="group/image absolute pointer-events-auto cursor-move"
							style={{
								left: `${segment.center.x * 100}%`,
								top: `${segment.center.y * 100}%`,
								width: `${segment.size.x * 100}%`,
								height: `${segment.size.y * 100}%`,
								transform: `translate(-50%, -50%) rotate(${segment.rotation}deg)`,
							}}
							onMouseDown={(event) => drag(event, index, "move")}
						>
							<div
								class={`pointer-events-none absolute inset-0 border-2 ${selected(index) ? "border-blue-9" : "border-transparent group-hover/image:border-blue-7"}`}
							/>
							<Show when={selected(index)}>
								<span class="pointer-events-none absolute -top-6 left-0 max-w-full truncate rounded bg-blue-9 px-1.5 text-[11px] text-white">
									{segment.name}
								</span>
								<button
									type="button"
									aria-label="Rotate image"
									class="absolute -top-7 left-1/2 size-3 -translate-x-1/2 rounded-full border border-white bg-blue-9 cursor-crosshair"
									onMouseDown={(event) => drag(event, index, "rotate")}
								/>
								<For
									each={[
										{ x: -1, y: -1 },
										{ x: 1, y: -1 },
										{ x: -1, y: 1 },
										{ x: 1, y: 1 },
									]}
								>
									{(corner) => (
										<button
											type="button"
											aria-label="Resize image"
											class="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-blue-9"
											style={{
												left: corner.x < 0 ? "0" : "100%",
												top: corner.y < 0 ? "0" : "100%",
												cursor:
													corner.x === corner.y ? "nwse-resize" : "nesw-resize",
											}}
											onMouseDown={(event) => drag(event, index, corner)}
										/>
									)}
								</For>
							</Show>
						</div>
					)}
				</For>
			</Show>
		</div>
	);
}
