import { convertFileSrc } from "@tauri-apps/api/core";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import IconLucideClapperboard from "~icons/lucide/clapperboard";
import IconLucideHistory from "~icons/lucide/history";
import IconLucideImage from "~icons/lucide/image";
import IconLucideSquarePlay from "~icons/lucide/square-play";
import IconLucideZap from "~icons/lucide/zap";
import type { RecordingWithPath, ScreenshotWithPath } from "./TargetCard";

export type RecentMediaItem =
	| {
			kind: "recording";
			target: RecordingWithPath;
			createdAt: number;
			previewPath?: string;
			previewVersion?: number;
	  }
	| {
			kind: "screenshot";
			target: ScreenshotWithPath;
			createdAt: number;
			previewPath: string;
			previewVersion: number;
	  };

function RecentCarousel(props: { children: JSX.Element; itemCount: number }) {
	let scrollContainer!: HTMLDivElement;
	let measureFrame: number | undefined;
	const [canScrollLeft, setCanScrollLeft] = createSignal(false);
	const [canScrollRight, setCanScrollRight] = createSignal(false);

	const measure = () => {
		const maxScrollLeft = Math.max(
			0,
			scrollContainer.scrollWidth - scrollContainer.clientWidth,
		);
		setCanScrollLeft(scrollContainer.scrollLeft > 1);
		setCanScrollRight(maxScrollLeft - scrollContainer.scrollLeft > 1);
	};

	const scheduleMeasure = () => {
		if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
		measureFrame = requestAnimationFrame(() => {
			measureFrame = undefined;
			measure();
		});
	};

	createEffect(() => {
		props.itemCount;
		scheduleMeasure();
	});

	onMount(() => {
		const observer = new ResizeObserver(scheduleMeasure);
		observer.observe(scrollContainer);
		scheduleMeasure();

		onCleanup(() => {
			observer.disconnect();
			if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
		});
	});

	const maskImage = () =>
		`linear-gradient(to right, transparent, black ${canScrollLeft() ? "22px" : "0px"}, black calc(100% - ${canScrollRight() ? "34px" : "0px"}), transparent)`;
	const handleWheel: JSX.EventHandler<HTMLDivElement, WheelEvent> = (event) => {
		if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
		const maxScrollLeft = Math.max(
			0,
			event.currentTarget.scrollWidth - event.currentTarget.clientWidth,
		);
		const nextScrollLeft = Math.min(
			maxScrollLeft,
			Math.max(0, event.currentTarget.scrollLeft + event.deltaY),
		);
		if (nextScrollLeft === event.currentTarget.scrollLeft) return;
		event.preventDefault();
		event.currentTarget.scrollLeft = nextScrollLeft;
	};

	return (
		<div
			ref={scrollContainer}
			onScroll={scheduleMeasure}
			onWheel={handleWheel}
			class="hide-scroll flex snap-x snap-proximity gap-2 overflow-x-auto overscroll-x-contain scroll-smooth pb-1 pr-8"
			style={{
				"-webkit-mask-image": maskImage(),
				"mask-image": maskImage(),
				"scrollbar-width": "none",
			}}
		>
			{props.children}
		</div>
	);
}

function RecentCard(props: {
	item: RecentMediaItem;
	disabled?: boolean;
	onClick: () => void;
}) {
	const [imageAvailable, setImageAvailable] = createSignal(true);
	const title = () => props.item.target.pretty_name;
	const typeLabel = () => {
		if (props.item.kind === "screenshot") return "Screenshot";
		return props.item.target.mode === "studio" ? "Studio Mode" : "Instant Mode";
	};
	const TypeIcon = () => {
		if (props.item.kind === "screenshot") {
			return <IconLucideImage class="size-2.5" />;
		}
		if (props.item.target.mode === "studio") {
			return <IconLucideClapperboard class="size-2.5" />;
		}
		return <IconLucideZap class="size-2.5" />;
	};
	const thumbnailSrc = createMemo(() => {
		if (!props.item.previewPath || !imageAvailable()) return undefined;
		return `${convertFileSrc(props.item.previewPath)}?v=${props.item.previewVersion ?? 0}`;
	});

	return (
		<button
			type="button"
			disabled={props.disabled}
			onClick={props.onClick}
			aria-label={`Open ${typeLabel()}: ${title()}`}
			class={cx(
				"group relative h-28 w-[196px] shrink-0 snap-start overflow-hidden rounded-xl border border-gray-5 bg-gray-3 text-left shadow-sm outline-hidden transition-[transform,border-color,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-gray-7 hover:shadow-md focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1",
				props.disabled && "pointer-events-none opacity-60",
			)}
		>
			<Show
				when={thumbnailSrc()}
				fallback={
					<div class="flex h-full w-full items-center justify-center bg-linear-to-br from-gray-3 to-gray-5 text-gray-9">
						<Show
							when={props.item.kind === "screenshot"}
							fallback={<IconLucideSquarePlay class="size-7" />}
						>
							<IconLucideImage class="size-7" />
						</Show>
					</div>
				}
			>
				{(src) => (
					<img
						src={src()}
						alt=""
						loading="lazy"
						decoding="async"
						draggable={false}
						onError={() => setImageAvailable(false)}
						class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]"
					/>
				)}
			</Show>
			<div class="absolute inset-0 bg-linear-to-t from-black/80 via-black/10 to-black/5" />
			<div class="absolute left-2 top-2 flex items-center gap-1 rounded-full border border-white/15 bg-black/45 px-2 py-0.5 text-[9px] font-medium text-white/90 backdrop-blur-sm">
				<TypeIcon />
				{typeLabel()}
			</div>
			<div class="absolute inset-x-0 bottom-0 px-2.5 pb-2 pt-5">
				<p class="truncate text-[11px] font-medium text-white">{title()}</p>
				<Show
					when={
						props.item.kind === "recording" && props.item.target.clip_count > 1
					}
				>
					<p class="mt-0.5 text-[9px] text-white/65">
						{props.item.kind === "recording"
							? `${props.item.target.clip_count} clips`
							: null}
					</p>
				</Show>
			</div>
		</button>
	);
}

export default function Recents(props: {
	items?: RecentMediaItem[];
	isLoading: boolean;
	errorMessage?: string;
	disabled?: boolean;
	onSelect: (item: RecentMediaItem) => void;
}) {
	return (
		<section class="animate-in overflow-hidden fade-in slide-in-from-bottom-1 duration-200">
			<div class="mb-2 flex items-center px-0.5">
				<h2 class="text-xs font-semibold text-gray-12">Recents</h2>
			</div>
			<Show when={props.errorMessage}>
				<div class="flex h-28 items-center justify-center rounded-xl border border-dashed border-gray-5 bg-gray-2 px-4 text-center text-xs text-gray-10">
					{props.errorMessage}
				</div>
			</Show>
			<Show when={!props.errorMessage && props.isLoading}>
				<RecentCarousel itemCount={3}>
					<For each={[0, 1, 2]}>
						{() => (
							<div class="h-28 w-[196px] shrink-0 snap-start animate-pulse rounded-xl bg-gray-3" />
						)}
					</For>
				</RecentCarousel>
			</Show>
			<Show
				when={
					!props.errorMessage &&
					!props.isLoading &&
					(props.items?.length ?? 0) === 0
				}
			>
				<div class="flex h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-gray-5 bg-gray-2 text-center">
					<IconLucideHistory class="size-5 text-gray-9" />
					<p class="text-xs text-gray-10">
						Your latest captures will appear here.
					</p>
				</div>
			</Show>
			<Show
				when={!props.errorMessage && !props.isLoading && props.items?.length}
			>
				<RecentCarousel itemCount={props.items?.length ?? 0}>
					<For each={props.items}>
						{(item) => (
							<RecentCard
								item={item}
								disabled={props.disabled}
								onClick={() => props.onSelect(item)}
							/>
						)}
					</For>
				</RecentCarousel>
			</Show>
		</section>
	);
}
