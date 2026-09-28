import { convertFileSrc } from "@tauri-apps/api/core";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { commands } from "~/utils/tauri";

const thumbnailCache = new Map<string, string>();
const thumbnailInflight = new Map<string, Promise<string | null>>();
const thumbnailQueue: (() => void)[] = [];
let activeThumbnailLoads = 0;
let thumbnailPumpScheduled = false;

const MAX_THUMBNAIL_LOADS = 2;

export const clipThumbnailKey = (
	projectPath: string,
	recordingSegment: number,
	start: number,
) => `${projectPath}::${recordingSegment}-${Math.round(start * 1000)}`;

const scheduleThumbnailWork = (callback: () => void) => {
	const requestIdle = (
		window as Window & {
			requestIdleCallback?: (
				callback: () => void,
				options?: { timeout: number },
			) => number;
		}
	).requestIdleCallback;

	if (requestIdle) {
		requestIdle(callback, { timeout: 150 });
	} else {
		requestAnimationFrame(callback);
	}
};

const pumpThumbnailQueue = () => {
	if (thumbnailPumpScheduled) return;
	thumbnailPumpScheduled = true;

	scheduleThumbnailWork(() => {
		thumbnailPumpScheduled = false;

		while (
			activeThumbnailLoads < MAX_THUMBNAIL_LOADS &&
			thumbnailQueue.length > 0
		) {
			const run = thumbnailQueue.shift();
			if (!run) return;
			activeThumbnailLoads += 1;
			run();
		}
	});
};

const loadClipThumbnail = (
	recordingSegment: number,
	start: number,
	key: string,
) => {
	let promise = thumbnailInflight.get(key);
	if (promise) return promise;

	promise = new Promise<string | null>((resolve) => {
		thumbnailQueue.push(() => {
			commands
				.getClipThumbnail(recordingSegment, start)
				.then((path) => {
					const url = convertFileSrc(path);
					thumbnailCache.set(key, url);
					resolve(url);
				})
				.catch((error) => {
					console.error("Failed to load clip thumbnail", error);
					resolve(null);
				})
				.finally(() => {
					activeThumbnailLoads -= 1;
					thumbnailInflight.delete(key);
					pumpThumbnailQueue();
				});
		});
		pumpThumbnailQueue();
	});
	thumbnailInflight.set(key, promise);

	return promise;
};

export function ClipThumbnail(props: {
	projectPath: string;
	recordingSegment: number;
	start: number;
	index: number;
}) {
	const [src, setSrc] = createSignal<string | null>(null);
	const [loaded, setLoaded] = createSignal(false);
	const [visible, setVisible] = createSignal(false);
	let container: HTMLDivElement | undefined;
	let disposed = false;

	const cacheKey = createMemo(() =>
		clipThumbnailKey(props.projectPath, props.recordingSegment, props.start),
	);

	const applySrc = (key: string, url: string | null) => {
		if (disposed || key !== cacheKey() || !url) return;
		setSrc(url);
	};

	const load = (key: string, recordingSegment: number, start: number) => {
		const cached = thumbnailCache.get(key);
		if (cached) {
			applySrc(key, cached);
			return;
		}

		const promise = loadClipThumbnail(recordingSegment, start, key);
		void promise.then((url) => applySrc(key, url));
	};

	onMount(() => {
		if (!container) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
			},
			{ rootMargin: "300px" },
		);
		observer.observe(container);
		onCleanup(() => observer.disconnect());
	});

	createEffect(() => {
		const key = cacheKey();
		const cached = thumbnailCache.get(key);
		if (cached) {
			setSrc(cached);
			return;
		}
		setSrc(null);
		setLoaded(false);
		if (visible()) load(key, props.recordingSegment, props.start);
	});

	onCleanup(() => {
		disposed = true;
	});

	return (
		<div ref={container} class="absolute inset-0">
			<div class="flex absolute inset-0 justify-center items-center bg-gray-3 dark:bg-gray-4">
				<span class="text-sm font-semibold tabular-nums text-gray-9">
					{props.index + 1}
				</span>
			</div>
			<Show when={src()}>
				{(url) => (
					<img
						src={url()}
						alt=""
						draggable={false}
						loading="lazy"
						decoding="async"
						onLoad={() => setLoaded(true)}
						class={cx(
							"absolute inset-0 object-cover pointer-events-none size-full transition-opacity duration-200",
							loaded() ? "opacity-100" : "opacity-0",
						)}
					/>
				)}
			</Show>
		</div>
	);
}

/** A loaded thumbnail for this clip start, if one is cached. */
export const cachedClipThumbnail = (key: string) =>
	thumbnailCache.get(key) ?? null;
