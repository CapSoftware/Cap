import { cx } from "cva";
import { createEffect, createMemo, For, Match, Switch } from "solid-js";
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

function isDisplayProps(props: TargetMenuGridProps): props is DisplayGridProps {
	return props.variant === "display";
}

function isWindowProps(props: TargetMenuGridProps): props is WindowGridProps {
	return props.variant === "window";
}

export default function TargetMenuGrid(props: TargetMenuGridProps) {
	const items = createMemo(() => props.targets ?? []);
	const skeletonItems = createMemo(() =>
		Array.from({ length: props.skeletonCount ?? DEFAULT_SKELETON_COUNT }),
	);
	const isEmpty = createMemo(
		() => !props.isLoading && items().length === 0 && !props.errorMessage,
	);

	let cardRefs: HTMLButtonElement[] = [];

	createEffect(() => {
		items();
		cardRefs = [];
	});

	const registerRef = (index: number) => (el: HTMLButtonElement) => {
		cardRefs[index] = el;
	};

	const focusAt = (index: number) => {
		const target = cardRefs[index];
		if (target) target.focus();
	};

	const handleKeyDown = (event: KeyboardEvent, index: number) => {
		if (!cardRefs.length) return;
		const columns = 2;
		let nextIndex = index;

		switch (event.key) {
			case "ArrowRight":
				nextIndex = (index + 1) % cardRefs.length;
				event.preventDefault();
				break;
			case "ArrowLeft":
				nextIndex = (index - 1 + cardRefs.length) % cardRefs.length;
				event.preventDefault();
				break;
			case "ArrowDown":
				nextIndex = Math.min(index + columns, cardRefs.length - 1);
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
				nextIndex = cardRefs.length - 1;
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
				"grid w-full grid-cols-2 content-start items-start justify-items-stretch gap-4",
				props.class,
			)}
			role="listbox"
		>
			<Switch>
				<Match when={props.errorMessage}>
					<div class="col-span-2 flex flex-col items-center justify-center gap-2 py-6 text-center text-sm text-gray-11">
						<p>{props.errorMessage}</p>
					</div>
				</Match>
				<Match when={props.isLoading}>
					<For each={skeletonItems()}>
						{() => <TargetCardSkeleton class="w-full" />}
					</For>
				</Match>
				<Match when={isEmpty()}>
					<div class="col-span-2 py-6 text-center text-sm text-gray-11">
						{props.emptyMessage ?? defaultEmptyMessage()}
					</div>
				</Match>
				<Match when={items().length > 0}>
					<Switch>
						<Match when={props.variant === "display"}>
							{(() => {
								if (!isDisplayProps(props)) return null;
								const displayProps = props;
								const targets = displayProps.targets ?? [];
								const onSelect = displayProps.onSelect;

								return (
									<For each={targets}>
										{(item, index) => (
											<TargetCard
												variant="display"
												target={item}
												onClick={() => onSelect?.(item)}
												disabled={displayProps.disabled}
												ref={registerRef(index())}
												onKeyDown={(event) => handleKeyDown(event, index())}
												role="option"
												class="w-full"
												highlightQuery={displayProps.highlightQuery}
											/>
										)}
									</For>
								);
							})()}
						</Match>
						<Match when={props.variant === "window"}>
							{(() => {
								if (!isWindowProps(props)) return null;
								const windowProps = props;
								const targets = windowProps.targets ?? [];
								const onSelect = windowProps.onSelect;

								return (
									<For each={targets}>
										{(item, index) => (
											<TargetCard
												variant="window"
												target={item}
												onClick={() => onSelect?.(item)}
												disabled={windowProps.disabled}
												ref={registerRef(index())}
												onKeyDown={(event) => handleKeyDown(event, index())}
												role="option"
												class="w-full"
												highlightQuery={windowProps.highlightQuery}
											/>
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
