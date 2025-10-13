import { ProgressCircle } from "@cap/ui-solid";
import { Dialog } from "@kobalte/core/dialog";
import Tooltip from "@corvu/tooltip";
import {
	createMutation,
	createQuery,
	queryOptions,
	useQueryClient,
} from "@tanstack/solid-query";
import { Channel, convertFileSrc } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { remove } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import * as shell from "@tauri-apps/plugin-shell";
import { cx } from "cva";
import {
	createMemo,
	createSignal,
	For,
	type JSX,
	type ParentProps,
	Show,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import CapTooltip from "~/components/Tooltip";
import { trackEvent } from "~/utils/analytics";
import { createTauriEventListener } from "~/utils/createEventListener";
import {
	commands,
	events,
	type RecordingMetaWithMetadata,
	type UploadProgress,
	type UploadDebugEvent,
} from "~/utils/tauri";

type Recording = {
	meta: RecordingMetaWithMetadata;
	path: string;
	prettyName: string;
	thumbnailPath: string;
};

const Tabs = [
	{
		id: "all",
		label: "Show all",
	},
	{
		id: "instant",
		icon: <IconCapInstant class="invert size-3 dark:invert-0" />,
		label: "Instant",
	},
	{
		id: "studio",
		icon: <IconCapFilmCut class="invert size-3 dark:invert-0" />,
		label: "Studio",
	},
] satisfies { id: string; label: string; icon?: JSX.Element }[];

const recordingsQuery = queryOptions({
	queryKey: ["recordings"],
	queryFn: async () => {
		const result = await commands.listRecordings().catch(() => [] as const);

		const recordings = await Promise.all(
			result.map(async (file) => {
				const [path, meta] = file;
				const thumbnailPath = `${path}/screenshots/display.jpg`;

				return {
					meta,
					path,
					prettyName: meta.pretty_name,
					thumbnailPath,
				};
			}),
		);
		return recordings;
	},
	// This will ensure any changes to the upload status in the project meta are reflected.
	refetchInterval: 2000,
});

export default function Recordings() {
	const [activeTab, setActiveTab] = createSignal<(typeof Tabs)[number]["id"]>(
		Tabs[0].id,
	);
	const [uploadProgress, setUploadProgress] = createStore<
		Record</* video_id */ string, number>
	>({});
	const [isStatsModalOpen, setIsStatsModalOpen] = createSignal(false);
	const recordings = createQuery(() => recordingsQuery);

	createTauriEventListener(events.uploadProgressEvent, (e) => {
		setUploadProgress(e.video_id, (Number(e.uploaded) / Number(e.total)) * 100);
		if (e.uploaded === e.total)
			setUploadProgress(
				produce((s) => {
					delete s[e.video_id];
				}),
			);
	});

	createTauriEventListener(events.recordingDeleted, () => recordings.refetch());

	const filteredRecordings = createMemo(() => {
		if (!recordings.data) {
			return [];
		}
		if (activeTab() === "all") {
			return recordings.data;
		}
		return recordings.data.filter(
			(recording) => recording.meta.mode === activeTab(),
		);
	});

	const handleRecordingClick = (recording: Recording) => {
		trackEvent("recording_view_clicked");
		events.newStudioRecordingAdded.emit({ path: recording.path });
	};

	const handleOpenFolder = (path: string) => {
		trackEvent("recording_folder_clicked");
		commands.openFilePath(path);
	};

	const handleCopyVideoToClipboard = (path: string) => {
		trackEvent("recording_copy_clicked");
		commands.copyVideoToClipboard(path);
	};

	const handleOpenEditor = (path: string) => {
		trackEvent("recording_editor_clicked");
		commands.showWindow({
			Editor: { project_path: path },
		});
	};

	return (
		<div class="flex relative flex-col p-4 space-y-4 w-full h-full">
			<div class="flex items-center justify-between">
				<div class="flex flex-col">
					<h2 class="text-lg font-medium text-gray-12">Previous Recordings</h2>
					<p class="text-sm text-gray-10">
						Manage your recordings and perform actions.
					</p>
				</div>
				<button
					onClick={() => setIsStatsModalOpen(true)}
					class="p-2 text-xs text-gray-10 hover:text-gray-12 hover:bg-gray-3 rounded-md transition-colors"
				>
					Stats for Nerds
				</button>
			</div>
			<StatsForNerds
				open={isStatsModalOpen()}
				onOpenChange={setIsStatsModalOpen}
			/>
			<Show
				when={recordings.data && recordings.data.length > 0}
				fallback={
					<p class="text-center text-[--text-tertiary] absolute flex items-center justify-center w-full h-full">
						No recordings found
					</p>
				}
			>
				<div class="flex gap-3 items-center pb-4 w-full border-b border-gray-2">
					<For each={Tabs}>
						{(tab) => (
							<div
								class={cx(
									"flex gap-1.5 items-center transition-colors duration-200 p-2 px-3 border rounded-full",
									activeTab() === tab.id
										? "bg-gray-5 cursor-default border-gray-5"
										: "bg-transparent cursor-pointer hover:bg-gray-3 border-gray-5",
								)}
								onClick={() => setActiveTab(tab.id)}
							>
								{tab.icon && tab.icon}
								<p class="text-xs text-gray-12">{tab.label}</p>
							</div>
						)}
					</For>
				</div>

				<div class="flex relative flex-col flex-1 mt-4 rounded-xl border custom-scroll bg-gray-2 border-gray-3">
					<Show when={filteredRecordings().length === 0}>
						<p class="text-center text-[--text-tertiary] absolute flex items-center justify-center w-full h-full">
							No {activeTab()} recordings
						</p>
					</Show>
					<ul class="p-4 flex flex-col gap-5 w-full text-[--text-primary]">
						<For each={filteredRecordings()}>
							{(recording) => (
								<RecordingItem
									recording={recording}
									onClick={() => handleRecordingClick(recording)}
									onOpenFolder={() => handleOpenFolder(recording.path)}
									onOpenEditor={() => handleOpenEditor(recording.path)}
									onCopyVideoToClipboard={() =>
										handleCopyVideoToClipboard(recording.path)
									}
									uploadProgress={
										recording.meta.upload &&
										(recording.meta.upload.state === "MultipartUpload" ||
											recording.meta.upload.state === "SinglePartUpload")
											? uploadProgress[recording.meta.upload.video_id]
											: undefined
									}
								/>
							)}
						</For>
					</ul>
				</div>
			</Show>
		</div>
	);
}

function RecordingItem(props: {
	recording: Recording;
	onClick: () => void;
	onOpenFolder: () => void;
	onOpenEditor: () => void;
	onCopyVideoToClipboard: () => void;
	uploadProgress: number | undefined;
}) {
	const [imageExists, setImageExists] = createSignal(true);
	const mode = () => props.recording.meta.mode;
	const firstLetterUpperCase = () =>
		mode().charAt(0).toUpperCase() + mode().slice(1);

	const queryClient = useQueryClient();

	return (
		<li class="flex flex-row justify-between [&:not(:last-child)]:border-b [&:not(:last-child)]:pb-5 [&:not(:last-child)]:border-gray-3 items-center w-full  transition-colors duration-200 hover:bg-gray-2">
			<div class="flex gap-5 items-center">
				<Show
					when={imageExists()}
					fallback={<div class="mr-4 rounded bg-gray-10 size-11" />}
				>
					<img
						class="object-cover rounded size-12"
						alt="Recording thumbnail"
						src={`${convertFileSrc(
							props.recording.thumbnailPath,
						)}?t=${Date.now()}`}
						onError={() => setImageExists(false)}
					/>
				</Show>
				<div class="flex flex-col gap-2">
					<span>{props.recording.prettyName}</span>
					<div class="flex space-x-1">
						<div
							class={cx(
								"px-2 py-0.5 flex items-center gap-1.5 font-medium text-[11px] text-gray-12 rounded-full w-fit",
								mode() === "instant" ? "bg-blue-100" : "bg-gray-3",
							)}
						>
							{mode() === "instant" ? (
								<IconCapInstant class="invert size-2.5 dark:invert-0" />
							) : (
								<IconCapFilmCut class="invert size-2.5 dark:invert-0" />
							)}
							<p>{firstLetterUpperCase()}</p>
						</div>

						<Show when={props.recording.meta.status.status === "InProgress"}>
							<div
								class={cx(
									"px-2 py-0.5 flex items-center gap-1.5 font-medium text-[11px] text-gray-12 rounded-full w-fit bg-blue-500 leading-none text-center",
								)}
							>
								<IconPhRecordFill class="invert size-2.5 dark:invert-0" />
								<p>Recording in progress</p>
							</div>
						</Show>

						<Show when={props.recording.meta.status.status === "Failed"}>
							<CapTooltip
								content={
									<span>
										{props.recording.meta.status.status === "Failed"
											? props.recording.meta.status.error
											: ""}
									</span>
								}
							>
								<div
									class={cx(
										"px-2 py-0.5 flex items-center gap-1.5 font-medium text-[11px] text-gray-12 rounded-full w-fit bg-red-9 leading-none text-center",
									)}
								>
									<IconPhWarningBold class="invert size-2.5 dark:invert-0" />
									<p>Recording failed</p>
								</div>
							</CapTooltip>
						</Show>
					</div>
				</div>
			</div>
			<div class="flex gap-2 items-center">
				<Show when={mode() === "studio"}>
					<Show when={props.uploadProgress}>
						<CapTooltip content={`${(props.uploadProgress || 0).toFixed(2)}%`}>
							<ProgressCircle
								variant="primary"
								progress={props.uploadProgress || 0}
								size="sm"
							/>
						</CapTooltip>
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
					<TooltipIconButton
						tooltipText="Edit"
						onClick={() => props.onOpenEditor()}
						disabled={props.recording.meta.status.status !== "Complete"}
					>
						<IconLucideEdit class="size-4" />
					</TooltipIconButton>
				</Show>
				<Show when={mode() === "instant"}>
					<InstantModeActions
						recording={props.recording}
						uploadProgress={props.uploadProgress}
					/>
				</Show>
				<TooltipIconButton
					tooltipText="Open recording bundle"
					onClick={() => revealItemInDir(`${props.recording.path}/`)}
				>
					<IconLucideFolder class="size-4" />
				</TooltipIconButton>
				<TooltipIconButton
					tooltipText="Delete"
					onClick={async () => {
						if (!(await ask("Are you sure you want to delete this recording?")))
							return;
						await remove(props.recording.path, { recursive: true });

						queryClient.refetchQueries(recordingsQuery);
					}}
				>
					<IconCapTrash class="size-4" />
				</TooltipIconButton>
			</div>
		</li>
	);
}

function TooltipIconButton(
	props: ParentProps<{
		onClick: () => void;
		tooltipText: string;
		disabled?: boolean;
	}>,
) {
	return (
		<Tooltip>
			<Tooltip.Trigger
				onClick={(e: MouseEvent) => {
					e.stopPropagation();
					props.onClick();
				}}
				disabled={props.disabled}
				class="p-2.5 opacity-70 will-change-transform hover:opacity-100 rounded-full transition-all duration-200 hover:bg-gray-3 dark:hover:bg-gray-5 disabled:pointer-events-none disabled:opacity-45 disabled:hover:opacity-45"
			>
				{props.children}
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content class="py-2 px-3 font-medium bg-gray-2 text-gray-12 border border-gray-3 text-xs rounded-lg animate-in fade-in slide-in-from-top-0.5">
					{props.tooltipText}
				</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip>
	);
}

interface UploadDebugEventWithTimestamp extends UploadDebugEvent {
	timestamp: number;
}

function StatsForNerds(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [debugEvents, setDebugEvents] = createStore<
		Record<string, UploadDebugEventWithTimestamp[]>
	>({});

	const [hoveredEvent, setHoveredEvent] =
		createSignal<UploadDebugEventWithTimestamp | null>(null);

	createTauriEventListener(events.uploadDebugEvent, (e) => {
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
