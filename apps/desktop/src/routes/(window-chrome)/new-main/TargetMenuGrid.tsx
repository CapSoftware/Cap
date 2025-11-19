import { cx } from "cva";
import { createMemo, For, Match, Switch } from "solid-js";
import { Transition } from "solid-transition-group";
import type {
	CaptureDisplayWithThumbnail,
	CaptureWindowWithThumbnail,
} from "~/utils/tauri";
import TargetCard, {
	type RecordingWithPath,
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
};

type TargetMenuGridProps =
	| DisplayGridProps
	| WindowGridProps
	| RecordingGridProps;

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

	const defaultEmptyMessage = () =>
		props.variant === "display"
			? "No displays found"
			: props.variant === "window"
				? "No windows found"
				: "No recordings found";

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
				<Match when={isEmpty()}>
					<div class="col-span-2 py-6 text-sm text-center text-gray-11">
						{props.emptyMessage ?? defaultEmptyMessage()}
					</div>
				</Match>
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
												exitToClass="scale-100"
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
									<For each={items() as RecordingWithPath[]}>
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
														variant="recording"
														target={item}
														onClick={() => recordingProps.onSelect?.(item)}
														disabled={recordingProps.disabled}
														onKeyDown={handleKeyDown}
														class="w-full"
														data-target-menu-card="true"
														highlightQuery={recordingProps.highlightQuery}
													/>
												</div>
											</Transition>
										)}
									</For>
								);
							})()}
						</Match>
					</Switch>
				</Match>
			</Switch>
		</div>
	);
}
