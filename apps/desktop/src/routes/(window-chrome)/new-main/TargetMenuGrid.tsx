import { cx } from "cva";
import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import { Transition } from "solid-transition-group";
import type {
	CaptureDisplayWithThumbnail,
	CaptureWindowWithThumbnail,
} from "~/utils/tauri";
import IconLucideExternalLink from "~icons/lucide/external-link";
import IconLucideImage from "~icons/lucide/image";
import IconLucideSquarePlay from "~icons/lucide/square-play";
import TargetCard, {
	type RecordingWithPath,
	type ScreenshotWithPath,
	TargetCardSkeleton,
} from "./TargetCard";

const DEFAULT_SKELETON_COUNT = 6;

type BaseProps<T> = {
	targets?: T[];
	onSelect?: (target: T) => void;
	isLoading?: boolean;
	errorMessage?: string;
	emptyMessage?: string;
	disabled?: boolean;
	skeletonCount?: number;
	class?: string;
	highlightQuery?: string;
};

type DisplayGridProps = BaseProps<CaptureDisplayWithThumbnail> & {
	variant: "display";
};

type WindowGridProps = BaseProps<CaptureWindowWithThumbnail> & {
	variant: "window";
};

type RecordingGridProps = BaseProps<RecordingWithPath> & {
	variant: "recording";
	uploadProgress?: Record<string, number>;
	reuploadingPaths?: Set<string>;
	onReupload?: (path: string) => void;
	onRefetch?: () => void;
	onViewAll?: () => void;
};

type ScreenshotGridProps = BaseProps<ScreenshotWithPath> & {
	variant: "screenshot";
	onViewAll?: () => void;
};

type TargetMenuGridProps =
	| DisplayGridProps
	| WindowGridProps
	| RecordingGridProps
	| ScreenshotGridProps;

function EmptyState(props: {
	icon: JSX.Element;
	title: string;
	description: string;
	action?: { label: string; onClick: () => void };
}) {
	return (
		<div class="col-span-2 flex flex-col items-center justify-center py-8 px-4 text-center">
			<div class="flex items-center justify-center size-12 rounded-full bg-gray-3 mb-3">
				{props.icon}
			</div>
			<p class="text-sm font-medium text-gray-12 mb-1">{props.title}</p>
			<p class="text-xs text-gray-10 mb-3 max-w-[200px]">{props.description}</p>
			<Show when={props.action}>
				{(action) => (
					<button
						type="button"
						onClick={action().onClick}
						class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-12 bg-gray-3 rounded-lg hover:bg-gray-4 transition-colors"
					>
						<IconLucideExternalLink class="size-3" />
						{action().label}
					</button>
				)}
			</Show>
		</div>
	);
}

function ViewAllButton(props: { onClick: () => void; label: string }) {
	return (
		<button
			type="button"
			onClick={props.onClick}
			class="col-span-2 flex items-center justify-center gap-2 py-2.5 mt-1 mb-3 text-xs font-medium text-gray-11 bg-gray-3 rounded-lg hover:bg-gray-4 hover:text-gray-12 transition-colors"
		>
			<IconLucideExternalLink class="size-3" />
			{props.label}
		</button>
	);
}

export default function TargetMenuGrid(props: TargetMenuGridProps) {
	const items = createMemo(() => props.targets ?? []);
	const skeletonItems = createMemo(() =>
		Array.from({ length: props.skeletonCount ?? DEFAULT_SKELETON_COUNT }),
	);
	const isEmpty = createMemo(
		() => !props.isLoading && items().length === 0 && !props.errorMessage,
	);

	let containerRef: HTMLDivElement | undefined;

	const handleKeyDown = (event: KeyboardEvent) => {
		const container = containerRef;
		if (!container) return;

		const buttons = Array.from(
			container.querySelectorAll<HTMLButtonElement>(
				"button[data-target-menu-card]:not(:disabled)",
			),
		);
		if (!buttons.length) return;

		const currentTarget = event.currentTarget as HTMLButtonElement | null;
		if (!currentTarget) return;

		const currentIndex = buttons.indexOf(currentTarget);
		if (currentIndex === -1) return;

		const totalItems = buttons.length;
		const columns = 2;
		let nextIndex = currentIndex;

		switch (event.key) {
			case "ArrowRight":
				nextIndex = (currentIndex + 1) % totalItems;
				event.preventDefault();
				break;
			case "ArrowLeft":
				nextIndex = (currentIndex - 1 + totalItems) % totalItems;
				event.preventDefault();
				break;
			case "ArrowDown":
				nextIndex = Math.min(currentIndex + columns, totalItems - 1);
				event.preventDefault();
				break;
			case "ArrowUp":
				nextIndex = Math.max(currentIndex - columns, 0);
				event.preventDefault();
				break;
			case "Home":
				nextIndex = 0;
				event.preventDefault();
				break;
			case "End":
				nextIndex = totalItems - 1;
				event.preventDefault();
				break;
			default:
				return;
		}

		const target = buttons[nextIndex];
		target?.focus();
	};

	const getOnViewAll = () => {
		if (props.variant === "recording")
			return (props as RecordingGridProps).onViewAll;
		if (props.variant === "screenshot")
			return (props as ScreenshotGridProps).onViewAll;
		return undefined;
	};

	const renderEmptyState = () => {
		const onViewAll = getOnViewAll();

		if (props.variant === "recording") {
			return (
				<EmptyState
					icon={<IconLucideSquarePlay class="size-5 text-gray-10" />}
					title="No recordings yet"
					description="Your screen recordings will appear here. Start recording to get started!"
					action={
						onViewAll
							? { label: "View All Recordings", onClick: onViewAll }
							: undefined
					}
				/>
			);
		}

		if (props.variant === "screenshot") {
			return (
				<EmptyState
					icon={<IconLucideImage class="size-5 text-gray-10" />}
					title="No screenshots yet"
					description="Your screenshots will appear here. Take a screenshot to get started!"
					action={
						onViewAll
							? { label: "View All Screenshots", onClick: onViewAll }
							: undefined
					}
				/>
			);
		}

		return (
			<div class="col-span-2 py-6 text-sm text-center text-gray-11">
				{props.emptyMessage ??
					(props.variant === "display"
						? "No displays found"
						: "No windows found")}
			</div>
		);
	};

	return (
		<div
			data-variant={props.variant}
			class={cx(
				"grid w-full grid-cols-2 content-start items-start justify-items-stretch gap-2",
				props.class,
			)}
			ref={(node) => {
				containerRef = node ?? undefined;
			}}
		>
			<Switch>
				<Match when={props.errorMessage}>
					<div class="flex flex-col col-span-2 gap-2 justify-center items-center py-6 text-sm text-center text-gray-11">
						<p>{props.errorMessage}</p>
					</div>
				</Match>
				<Match when={props.isLoading}>
					<For each={skeletonItems()}>
						{() => <TargetCardSkeleton class="w-full" />}
					</For>
				</Match>
				<Match when={isEmpty()}>{renderEmptyState()}</Match>
				<Match when={items().length > 0}>
					<Switch>
						<Match when={props.variant === "display"}>
							{(() => {
								const displayProps = props as DisplayGridProps;
								return (
									<For each={items() as CaptureDisplayWithThumbnail[]}>
										{(item, index) => (
											<Transition
												appear
												enterActiveClass="transition duration-200"
												enterClass="scale-95 opacity-0"
												enterToClass="scale-100 opacity-100"
												exitActiveClass="transition duration-200"
												exitClass="scale-100"
												exitToClass="scale-95"
											>
												<div
													style={{ "transition-delay": `${index() * 100}ms` }}
												>
													<TargetCard
														variant="display"
														target={item}
														onClick={() => displayProps.onSelect?.(item)}
														disabled={displayProps.disabled}
														onKeyDown={handleKeyDown}
														class="w-full"
														data-target-menu-card="true"
														highlightQuery={displayProps.highlightQuery}
													/>
												</div>
											</Transition>
										)}
									</For>
								);
							})()}
						</Match>
						<Match when={props.variant === "window"}>
							{(() => {
								const windowProps = props as WindowGridProps;
								return (
									<For each={items() as CaptureWindowWithThumbnail[]}>
										{(item, index) => (
											<Transition
												appear
												enterActiveClass="transition duration-200"
												enterClass="scale-95 opacity-0"
												enterToClass="scale-100 opacity-100"
												exitActiveClass="transition duration-200"
												exitClass="scale-100"
												exitToClass="scale-95"
											>
												<div
													style={{ "transition-delay": `${index() * 100}ms` }}
												>
													<TargetCard
														variant="window"
														target={item}
														onClick={() => windowProps.onSelect?.(item)}
														disabled={windowProps.disabled}
														onKeyDown={handleKeyDown}
														class="w-full"
														data-target-menu-card="true"
														highlightQuery={windowProps.highlightQuery}
													/>
												</div>
											</Transition>
										)}
									</For>
								);
							})()}
						</Match>
						<Match when={props.variant === "recording"}>
							{(() => {
								const recordingProps = props as RecordingGridProps;
								return (
									<>
										<For each={items() as RecordingWithPath[]}>
											{(item, index) => {
												const videoId = () => {
													const upload = item.upload;
													if (!upload) return undefined;
													if (
														upload.state === "MultipartUpload" ||
														upload.state === "SinglePartUpload"
													) {
														return upload.video_id;
													}
													return undefined;
												};
												const progress = () => {
													const id = videoId();
													if (!id || !recordingProps.uploadProgress)
														return undefined;
													return recordingProps.uploadProgress[id];
												};
												const isReuploading = () => {
													return (
														recordingProps.reuploadingPaths?.has(item.path) ??
														false
													);
												};
												return (
													<Transition
														appear
														enterActiveClass="transition duration-200"
														enterClass="scale-95 opacity-0"
														enterToClass="scale-100 opacity-100"
														exitActiveClass="transition duration-200"
														exitClass="scale-100"
														exitToClass="scale-95"
													>
														<div
															style={{
																"transition-delay": `${index() * 100}ms`,
															}}
														>
															<TargetCard
																variant="recording"
																target={item}
																onClick={() => recordingProps.onSelect?.(item)}
																disabled={recordingProps.disabled}
																onKeyDown={handleKeyDown}
																class="w-full"
																data-target-menu-card="true"
																highlightQuery={recordingProps.highlightQuery}
																uploadProgress={progress()}
																isReuploading={isReuploading()}
																onReupload={recordingProps.onReupload}
																onRefetch={recordingProps.onRefetch}
															/>
														</div>
													</Transition>
												);
											}}
										</For>
										<Show when={recordingProps.onViewAll}>
											{(onViewAll) => (
												<ViewAllButton
													onClick={onViewAll()}
													label="View All Recordings"
												/>
											)}
										</Show>
									</>
								);
							})()}
						</Match>
						<Match when={props.variant === "screenshot"}>
							{(() => {
								const screenshotProps = props as ScreenshotGridProps;
								return (
									<>
										<For each={items() as ScreenshotWithPath[]}>
											{(item, index) => (
												<Transition
													appear
													enterActiveClass="transition duration-200"
													enterClass="scale-95 opacity-0"
													enterToClass="scale-100 opacity-100"
													exitActiveClass="transition duration-200"
													exitClass="scale-100"
													exitToClass="scale-95"
												>
													<div
														style={{ "transition-delay": `${index() * 100}ms` }}
													>
														<TargetCard
															variant="screenshot"
															target={item}
															onClick={() => screenshotProps.onSelect?.(item)}
															disabled={screenshotProps.disabled}
															onKeyDown={handleKeyDown}
															class="w-full"
															data-target-menu-card="true"
															highlightQuery={screenshotProps.highlightQuery}
														/>
													</div>
												</Transition>
											)}
										</For>
										<Show when={screenshotProps.onViewAll}>
											{(onViewAll) => (
												<ViewAllButton
													onClick={onViewAll()}
													label="View All Screenshots"
												/>
											)}
										</Show>
									</>
								);
							})()}
						</Match>
					</Switch>
				</Match>
			</Switch>
		</div>
	);
}
