import { cx } from "cva";
import { createMemo, For, Match, Switch } from "solid-js";
import { Motion } from "solid-motionone";
import type {
	CaptureDisplayWithThumbnail,
	CaptureWindowWithThumbnail,
} from "~/utils/tauri";
import TargetCard, { TargetCardSkeleton } from "./TargetCard";

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

type TargetMenuGridProps = DisplayGridProps | WindowGridProps;

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
		props.variant === "display" ? "No displays found" : "No windows found";

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
							<For each={items() as CaptureDisplayWithThumbnail[]}>
								{(item, index) => (
									<Motion.div
										initial={{ scale: 0.95, opacity: 0 }}
										animate={{ scale: 1, opacity: 1 }}
										exit={{ scale: 0.95 }}
										transition={{ duration: 0.2, delay: index() * 0.1 }}
									>
										<TargetCard
											variant="display"
											target={item}
											onClick={() => props.onSelect?.(item)}
											disabled={props.disabled}
											onKeyDown={handleKeyDown}
											class="w-full"
											data-target-menu-card="true"
											highlightQuery={props.highlightQuery}
										/>
									</Motion.div>
								)}
							</For>
						</Match>
						<Match when={props.variant === "window"}>
							<For each={items() as CaptureWindowWithThumbnail[]}>
								{(item, index) => (
									<Motion.div
										initial={{ scale: 0.95, opacity: 0 }}
										animate={{ scale: 1, opacity: 1 }}
										exit={{ scale: 0.95 }}
										transition={{ duration: 0.2, delay: index() * 0.1 }}
									>
										<TargetCard
											variant="window"
											target={item}
											onClick={() => props.onSelect?.(item)}
											disabled={props.disabled}
											onKeyDown={handleKeyDown}
											class="w-full"
											data-target-menu-card="true"
											highlightQuery={props.highlightQuery}
										/>
									</Motion.div>
								)}
							</For>
						</Match>
					</Switch>
				</Match>
			</Switch>
		</div>
	);
}
