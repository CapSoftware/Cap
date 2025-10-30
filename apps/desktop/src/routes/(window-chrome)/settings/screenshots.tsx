import { createQuery } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { createSignal, For, Show } from "solid-js";

import { commands, events } from "~/utils/tauri";

type MediaEntry = {
	path: string;
	prettyName: string;
	isNew: boolean;
	thumbnailPath: string;
};

export default function Screenshots() {
	const fetchScreenshots = createQuery(() => ({
		queryKey: ["screenshots"],
		queryFn: async () => {
			const result = await commands
				.listScreenshots()
				.catch(
					() =>
						Promise.resolve([]) as ReturnType<typeof commands.listScreenshots>,
				);
			const screenshots = await Promise.all(
				result.map(async (file) => {
					const [pngPath, meta] = file;

					return {
						path: pngPath,
						prettyName: meta.pretty_name,
						isNew: false,
						thumbnailPath: pngPath,
					};
				}),
			);
			return screenshots;
		},
	}));

	const handleScreenshotClick = (screenshot: MediaEntry) => {
		events.newScreenshotAdded.emit({ path: screenshot.path });
	};

	const handleOpenFolder = (path: string) => {
		commands.openFilePath(path);
	};

	return (
		<div class="flex flex-col pt-1 pb-12 w-full h-full divide-y divide-gray-200">
			<div class="overflow-y-auto relative flex-1">
				<ul class="p-[0.625rem] flex flex-col gap-[0.5rem] w-full">
					<Show
						when={fetchScreenshots.data && fetchScreenshots.data.length > 0}
						fallback={
							<p class="text-center text-[--text-tertiary] absolute flex items-center justify-center w-full h-full">
								No screenshots found
							</p>
						}
					>
						<For each={fetchScreenshots.data}>
							{(screenshot) => (
								<ScreenshotItem
									screenshot={screenshot}
									onClick={() => handleScreenshotClick(screenshot)}
									onOpenFolder={() => handleOpenFolder(screenshot.path)}
								/>
							)}
						</For>
					</Show>
				</ul>
			</div>
		</div>
	);
}

function ScreenshotItem(props: {
	screenshot: MediaEntry;
	onClick: () => void;
	onOpenFolder: () => void;
}) {
	const [imageExists, setImageExists] = createSignal(true);

	return (
		<li class="flex flex-row justify-between items-center p-2 w-full rounded hover:bg-gray-2 dark:hover:bg-gray-3">
			<div class="flex items-center">
				<Show
					when={imageExists()}
					fallback={<div class="mr-4 w-8 h-8 bg-gray-10 rounded" />}
				>
					<img
						class="object-cover mr-4 w-8 h-8 rounded"
						alt="Screenshot thumbnail"
						src={`${convertFileSrc(
							props.screenshot.thumbnailPath,
						)}?t=${Date.now()}`}
						onError={() => setImageExists(false)}
					/>
				</Show>
				<span class="text-[--text-primary]">
					{props.screenshot.prettyName.replace(".png", "")}
				</span>
			</div>
			<div class="flex items-center">
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						props.onOpenFolder();
					}}
					class="p-2 hover:bg-gray-3 dark:hover:bg-gray-5 text-[--text-tertiary] hover:text-[--text-primary] rounded-full mr-2"
				>
					<IconLucideFolder class="size-5" />
				</button>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						props.onClick();
					}}
					class="p-2 hover:bg-gray-3 dark:hover:bg-gray-5 text-[--text-tertiary] hover:text-[--text-primary] rounded-full"
				>
					<IconLucideEye class="size-5" />
				</button>
			</div>
		</li>
	);
}
