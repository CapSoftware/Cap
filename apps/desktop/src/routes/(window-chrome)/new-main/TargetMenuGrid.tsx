import { cx } from "cva";
import { createEffect, createMemo, For, Match, Switch } from "solid-js";
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

	let cardRefs: (HTMLButtonElement | undefined)[] = [];

	createEffect(() => {
		const currentItems = items();
		if (cardRefs.length > currentItems.length) {
			cardRefs.length = currentItems.length;
		}
	});

	const registerRef =
		(index: number) => (el: HTMLButtonElement | null) => {
			cardRefs[index] = el || undefined;
		};

	const focusAt = (index: number) => {
		const target = cardRefs[index];
		if (target) target.focus();
	};

	const handleKeyDown = (event: KeyboardEvent, index: number) => {
		const totalItems = items().length;
		if (!totalItems) return;
		const columns = 2;
		let nextIndex = index;

		switch (event.key) {
			case "ArrowRight":
				nextIndex = (index + 1) % totalItems;
				event.preventDefault();
				break;
			case "ArrowLeft":
				nextIndex = (index - 1 + totalItems) % totalItems;
				event.preventDefault();
				break;
			case "ArrowDown":
				nextIndex = Math.min(index + columns, totalItems - 1);
				event.preventDefault();
				break;
			case "ArrowUp":
				nextIndex = Math.max(index - columns, 0);
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

		focusAt(nextIndex);
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
			role="listbox"
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
											ref={registerRef(index())}
											onKeyDown={(event) => handleKeyDown(event, index())}
											role="option"
											class="w-full"
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
											ref={registerRef(index())}
											onKeyDown={(event) => handleKeyDown(event, index())}
											role="option"
											class="w-full"
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
