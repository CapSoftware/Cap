import { ProgressCircle } from "@cap/ui-solid";
import { Dialog } from "@kobalte/core/dialog";
import { createMutation } from "@tanstack/solid-query";
import { Channel } from "@tauri-apps/api/core";
import { cx } from "cva";
import { createSignal, createMemo, Show, For } from "solid-js";
import { createStore } from "solid-js/store";
import { createTauriEventListener } from "~/utils/createEventListener";
import {
	commands,
	events,
	UploadDebugEvent,
	UploadProgress,
} from "~/utils/tauri";

interface UploadDebugEventWithTimestamp extends UploadDebugEvent {
	timestamp: number;
}

export function UploadStatsForNerds(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [debugEvents, setDebugEvents] = createStore<
		Record<string, UploadDebugEventWithTimestamp[]>
	>({});

	const [hoveredEvent, setHoveredEvent] =
		createSignal<UploadDebugEventWithTimestamp | null>(null);

	createTauriEventListener(events.uploadDebugEvent, (e) => {
		console.log(e);
		const eventWithTimestamp: UploadDebugEventWithTimestamp = {
			...e,
			timestamp: Date.now(),
		};

		const key = `${e.video_id}:${e.upload_id}`;
		setDebugEvents(key, (prev = []) => [...prev, eventWithTimestamp]);
	});

	const allEvents = createMemo(() => {
		const events = Object.values(debugEvents).flat();
		return events.sort((a, b) => a.timestamp - b.timestamp);
	});

	const timeRange = createMemo(() => {
		const events = allEvents();
		if (events.length === 0) return { start: 0, end: 0 };
		const start = Math.min(...events.map((e) => e.timestamp));
		const end = Math.max(...events.map((e) => e.timestamp));
		return { start, end: Math.max(end, start + 60000) }; // At least 1 minute range
	});

	const getEventColor = (state: UploadDebugEvent["state"]) => {
		switch (state) {
			case "Pending":
				return "bg-yellow-500";
			case "Done":
				return "bg-green-500";
			default:
				if (typeof state === "object") {
					if ("Presigning" in state) return "bg-blue-500";
					if ("Uploading" in state) return "bg-purple-500";
					if ("PendingNextChunk" in state) return "bg-orange-500";
				}
				return "bg-gray-500";
		}
	};

	const formatTimestamp = (timestamp: number) => {
		return new Date(timestamp).toLocaleTimeString([], {
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	};

	const getStateLabel = (state: UploadDebugEvent["state"]): string => {
		if (typeof state === "string") return state;
		if (typeof state === "object") {
			if ("Presigning" in state)
				return `Presigning Part ${state.Presigning.part_number}`;
			if ("Uploading" in state)
				return `Uploading Part ${state.Uploading.part_number}`;
			if ("PendingNextChunk" in state)
				return `Pending After Part ${state.PendingNextChunk.prev_part_number}`;
		}
		return "Unknown";
	};

	const getEventDetails = (event: UploadDebugEventWithTimestamp): string => {
		const state = event.state;
		let details = `Video ID: ${event.video_id}\nUpload ID: ${event.upload_id}\nTime: ${formatTimestamp(event.timestamp)}\nState: ${getStateLabel(state)}`;

		if (typeof state === "object") {
			if ("Presigning" in state) {
				details += `\nPart: ${state.Presigning.part_number}\nChunk Size: ${state.Presigning.chunk_size}\nTotal Size: ${state.Presigning.total_size}`;
			} else if ("Uploading" in state) {
				details += `\nPart: ${state.Uploading.part_number}\nChunk Size: ${state.Uploading.chunk_size}\nTotal Size: ${state.Uploading.total_size}`;
			}
		}

		return details;
	};

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
				<div class="fixed inset-0 z-50 flex items-center justify-center p-4">
					<Dialog.Content class="bg-gray-1 border border-gray-3 rounded-lg shadow-xl w-full max-w-6xl h-[80vh] flex flex-col">
						<div class="flex items-center justify-between p-4 border-b border-gray-3">
							<Dialog.Title class="text-lg font-medium text-gray-12">
								Upload Debug Timeline ({allEvents().length} events)
							</Dialog.Title>
							<Dialog.CloseButton class="p-2 text-gray-10 hover:text-gray-12 hover:bg-gray-3 rounded-md transition-colors">
								✕
							</Dialog.CloseButton>
						</div>

						<div class="flex-1 p-4 overflow-hidden">
							<Show
								when={Object.keys(debugEvents).length > 0}
								fallback={
									<div class="flex flex-col items-center justify-center h-full text-gray-10 space-y-2">
										<div class="text-4xl">📊</div>
										<div class="text-center">
											<p class="font-medium">No debug events recorded yet</p>
											<p class="text-sm">
												Start uploading a recording to see the timeline
											</p>
										</div>
									</div>
								}
							>
								<div class="h-full flex flex-col">
									{/* Timeline container */}
									<div
										class="flex-1 relative overflow-auto custom-scroll"
										style={{ "scroll-behavior": "smooth" }}
									>
										<div
											class="relative min-w-[800px]"
											style={{ width: "200%" }}
										>
											{/* Time axis */}
											<div class="sticky top-0 bg-gray-1 border-b border-gray-3 pb-2 mb-4 z-10">
												<div class="flex justify-between text-xs text-gray-10 px-4">
													<span>{formatTimestamp(timeRange().start)}</span>
													<span>Timeline</span>
													<span>{formatTimestamp(timeRange().end)}</span>
												</div>
											</div>

											{/* Event tracks */}
											<div class="space-y-4">
												<For each={Object.entries(debugEvents)}>
													{([key, events]) => (
														<div class="relative">
															<div class="text-sm font-medium text-gray-12 mb-2 sticky left-4">
																{key}
															</div>
															<div class="relative h-8 bg-gray-2 rounded border border-gray-3">
																{/* Timeline background */}
																<div class="absolute inset-0 flex">
																	{/* Grid lines */}
																	<For
																		each={Array.from(
																			{ length: 20 },
																			(_, i) => i,
																		)}
																	>
																		{(i) => (
																			<div
																				class="border-l border-gray-4 flex-1"
																				style={{
																					"margin-left": i === 0 ? "0" : "",
																				}}
																			/>
																		)}
																	</For>
																</div>

																{/* Events */}
																<For each={events}>
																	{(event) => {
																		const position =
																			((event.timestamp - timeRange().start) /
																				(timeRange().end - timeRange().start)) *
																			100;
																		return (
																			<div
																				class={cx(
																					"absolute top-1 w-2 h-6 rounded-sm cursor-pointer transition-transform hover:scale-125",
																					getEventColor(event.state),
																				)}
																				style={{
																					left: `${Math.max(0, Math.min(98, position))}%`,
																				}}
																				onMouseEnter={() =>
																					setHoveredEvent(event)
																				}
																				onMouseLeave={() =>
																					setHoveredEvent(null)
																				}
																			/>
																		);
																	}}
																</For>
															</div>
														</div>
													)}
												</For>
											</div>
										</div>
									</div>

									{/* Legend */}
									<div class="mt-4 p-3 bg-gray-2 rounded border border-gray-3">
										<div class="text-xs font-medium text-gray-12 mb-2">
											Legend:
										</div>
										<div class="flex flex-wrap gap-4 text-xs">
											<div class="flex items-center gap-1">
												<div class="w-3 h-3 bg-yellow-500 rounded-sm" />
												<span class="text-gray-11">Pending</span>
											</div>
											<div class="flex items-center gap-1">
												<div class="w-3 h-3 bg-blue-500 rounded-sm" />
												<span class="text-gray-11">Presigning</span>
											</div>
											<div class="flex items-center gap-1">
												<div class="w-3 h-3 bg-purple-500 rounded-sm" />
												<span class="text-gray-11">Uploading</span>
											</div>
											<div class="flex items-center gap-1">
												<div class="w-3 h-3 bg-orange-500 rounded-sm" />
												<span class="text-gray-11">Pending Next Chunk</span>
											</div>
											<div class="flex items-center gap-1">
												<div class="w-3 h-3 bg-green-500 rounded-sm" />
												<span class="text-gray-11">Done</span>
											</div>
										</div>
									</div>
								</div>
							</Show>
						</div>

						{/* Hover tooltip */}
						<Show when={hoveredEvent()}>
							{(event) => (
								<div
									class="fixed z-60 bg-gray-12 text-gray-1 text-xs p-3 rounded shadow-lg pointer-events-none max-w-xs whitespace-pre-line border border-gray-3"
									style={{
										transform: "translate(-50%, -100%)",
										top: "50%",
										left: "50%",
									}}
								>
									{getEventDetails(event())}
								</div>
							)}
						</Show>
					</Dialog.Content>
				</div>
			</Dialog.Portal>
		</Dialog>
	);
}

function InstantModeActions(props: {
	recording: Recording;
	uploadProgress: number | undefined;
}) {
	const reupload = createMutation(() => ({
		mutationFn: () =>
			commands.uploadExportedVideo(
				props.recording.path,
				"Reupload",
				new Channel<UploadProgress>((progress) => {}),
			),
	}));

	return (
		<>
			<Show
				when={props.uploadProgress || reupload.isPending}
				fallback={
					<TooltipIconButton
						tooltipText="Reupload"
						onClick={() => reupload.mutate()}
					>
						<IconLucideRotateCcw class="size-4" />
					</TooltipIconButton>
				}
			>
				<ProgressCircle
					variant="primary"
					progress={props.uploadProgress || 0}
					size="sm"
				/>
			</Show>

			<Show when={props.recording.meta.sharing}>
				{(sharing) => (
					<TooltipIconButton
						tooltipText="Open link"
						onClick={() => shell.open(sharing().link)}
					>
						<IconCapLink class="size-4" />
					</TooltipIconButton>
				)}
			</Show>
		</>
	);
}
