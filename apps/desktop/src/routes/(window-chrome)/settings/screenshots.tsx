import { Button } from "@cap/ui-solid";
import Tooltip from "@corvu/tooltip";
import {
	createQuery,
	queryOptions,
	useQueryClient,
} from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { remove } from "@tauri-apps/plugin-fs";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	type ParentProps,
	Show,
} from "solid-js";
import { Input } from "~/routes/editor/ui";
import { trackEvent } from "~/utils/analytics";
import { createTauriEventListener } from "~/utils/createEventListener";
import { commands, events, type RecordingMeta } from "~/utils/tauri";

// Icons
import IconCapTrash from "~icons/cap/trash";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideEdit from "~icons/lucide/edit";
import IconLucideFolder from "~icons/lucide/folder";
import IconLucideSearch from "~icons/lucide/search";

type Screenshot = RecordingMeta & {
	path: string;
};

const PAGE_SIZE = 20;

const screenshotsQuery = queryOptions<Screenshot[]>({
	queryKey: ["screenshots"],
	queryFn: async () => {
		const result = await commands.listScreenshots().catch(() => [] as const);
		return result.map(([path, meta]) => ({ ...meta, path }));
	},
	reconcile: "path",
});

export default function Screenshots() {
	const [search, setSearch] = createSignal("");
	const trimmedSearch = createMemo(() => search().trim());
	const normalizedSearch = createMemo(() => trimmedSearch().toLowerCase());
	const [visibleCount, setVisibleCount] = createSignal(PAGE_SIZE);

	const screenshots = createQuery(() => screenshotsQuery);

	createTauriEventListener(events.newScreenshotAdded, () =>
		screenshots.refetch(),
	);

	createEffect(() => {
		trimmedSearch();
		setVisibleCount(PAGE_SIZE);
	});

	const filteredScreenshots = createMemo(() => {
		const data = screenshots.data ?? [];
		const query = normalizedSearch();
		if (!query) return data;
		return data.filter((screenshot) =>
			screenshot.pretty_name.toLowerCase().includes(query),
		);
	});

	const visibleScreenshots = createMemo(() => {
		const items = filteredScreenshots();
		if (normalizedSearch()) return items;
		return items.slice(0, visibleCount());
	});

	const hasMoreScreenshots = createMemo(
		() => !normalizedSearch() && filteredScreenshots().length > visibleCount(),
	);

	const emptyMessage = createMemo(() => {
		const prefix = trimmedSearch() ? "No matching" : "No";
		return `${prefix} screenshots`;
	});

	const handleScreenshotClick = (screenshot: Screenshot) => {
		trackEvent("screenshot_view_clicked");
		// events.newScreenshotAdded.emit({ path: screenshot.path });
		commands.showWindow({
			ScreenshotEditor: {
				path: screenshot.path,
			},
		});
	};

	const handleOpenEditor = (path: string) => {
		trackEvent("screenshot_editor_clicked");
		commands.showWindow({
			ScreenshotEditor: {
				path,
			},
		});
	};

	const handleOpenFolder = (path: string) => {
		trackEvent("screenshot_folder_clicked");
		commands.openFilePath(path);
	};

	const handleCopyImageToClipboard = (path: string) => {
		trackEvent("screenshot_copy_clicked");
		commands.copyScreenshotToClipboard(path);
	};

	return (
		<div class="flex relative flex-col p-4 space-y-4 w-full h-full">
			<div class="flex flex-col">
				<h2 class="text-lg font-medium text-gray-12">Screenshots</h2>
				<p class="text-sm text-gray-10">
					Manage your screenshots and perform actions.
				</p>
			</div>
			<Show
				when={screenshots.data && screenshots.data.length > 0}
				fallback={
					<p class="text-center text-[--text-tertiary] absolute flex items-center justify-center w-full h-full">
						No screenshots found
					</p>
				}
			>
				<div class="flex flex-col gap-3 pb-4 w-full border-b border-gray-2">
					<div class="relative w-full max-w-[260px] h-[36px] flex items-center">
						<IconLucideSearch class="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none size-3 text-gray-10" />
						<Input
							type="search"
							class="py-2 pl-6 h-full w-full"
							value={search()}
							onInput={(event) => setSearch(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape" && search()) {
									event.preventDefault();
									setSearch("");
								}
							}}
							placeholder="Search screenshots"
							autoCapitalize="off"
							autocorrect="off"
							autocomplete="off"
							spellcheck={false}
							aria-label="Search screenshots"
						/>
					</div>
				</div>

				<div class="flex relative flex-col flex-1 mt-4 rounded-xl border custom-scroll bg-gray-2 border-gray-3">
					<Show when={filteredScreenshots().length === 0}>
						<p class="text-center text-[--text-tertiary] absolute flex items-center justify-center w-full h-full">
							{emptyMessage()}
						</p>
					</Show>
					<ul class="flex flex-col w-full text-[--text-primary]">
						<For each={visibleScreenshots()}>
							{(screenshot) => (
								<ScreenshotItem
									screenshot={screenshot}
									onClick={() => handleScreenshotClick(screenshot)}
									onOpenEditor={() => handleOpenEditor(screenshot.path)}
									onOpenFolder={() => handleOpenFolder(screenshot.path)}
									onCopyImageToClipboard={() =>
										handleCopyImageToClipboard(screenshot.path)
									}
								/>
							)}
						</For>
					</ul>
					<Show when={hasMoreScreenshots()}>
						<div class="flex justify-center p-3 border-t border-gray-3">
							<Button
								variant="gray"
								size="sm"
								onClick={() =>
									setVisibleCount((count) =>
										Math.min(count + PAGE_SIZE, filteredScreenshots().length),
									)
								}
							>
								Load more
							</Button>
						</div>
					</Show>
				</div>
			</Show>
		</div>
	);
}

function ScreenshotItem(props: {
	screenshot: Screenshot;
	onClick: () => void;
	onOpenEditor: () => void;
	onOpenFolder: () => void;
	onCopyImageToClipboard: () => void;
}) {
	const [imageExists, setImageExists] = createSignal(true);
	const queryClient = useQueryClient();

	return (
		<li
			onClick={props.onClick}
			class="flex flex-row justify-between p-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-gray-3 items-center w-full cursor-pointer hover:bg-gray-3 transition-colors duration-200"
		>
			<div class="flex gap-5 items-center">
				<Show
					when={imageExists()}
					fallback={<div class="mr-4 rounded bg-gray-10 size-11" />}
				>
					<img
						class="object-cover rounded size-12"
						alt="Screenshot thumbnail"
						src={convertFileSrc(props.screenshot.path)}
						onError={() => setImageExists(false)}
					/>
				</Show>
				<div class="flex flex-col gap-2">
					<span>{props.screenshot.pretty_name}</span>
				</div>
			</div>
			<div class="flex gap-2 items-center">
				<TooltipIconButton
					tooltipText="Open folder"
					onClick={props.onOpenFolder}
				>
					<IconLucideFolder class="size-4" />
				</TooltipIconButton>

				<TooltipIconButton
					tooltipText="Open in editor"
					onClick={props.onOpenEditor}
				>
					<IconLucideEdit class="size-4" />
				</TooltipIconButton>

				<TooltipIconButton
					tooltipText="Copy image"
					onClick={props.onCopyImageToClipboard}
				>
					<IconLucideCopy class="size-4" />
				</TooltipIconButton>

				<TooltipIconButton
					tooltipText="Delete"
					onClick={async () => {
						if (
							!(await ask("Are you sure you want to delete this screenshot?"))
						)
							return;
						// screenshot.path is the png file. Parent is the .cap folder.
						const parent = props.screenshot.path.replace(/[/\\][^/\\]+$/, "");
						await remove(parent, { recursive: true });

						queryClient.invalidateQueries({ queryKey: ["screenshots"] });
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
