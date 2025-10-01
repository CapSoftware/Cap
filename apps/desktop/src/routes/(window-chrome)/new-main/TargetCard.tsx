import { cx } from "cva";
import type { ComponentProps } from "solid-js";
import { createMemo, Show, splitProps } from "solid-js";
import type {
	CaptureDisplayWithThumbnail,
	CaptureWindowWithThumbnail,
} from "~/utils/tauri";
import IconLucideAppWindowMac from "~icons/lucide/app-window-mac";
import IconMdiMonitor from "~icons/mdi/monitor";

function formatResolution(width?: number, height?: number) {
	if (!width || !height) return undefined;

	const roundedWidth = Math.round(width);
	const roundedHeight = Math.round(height);

	if (roundedWidth <= 0 || roundedHeight <= 0) return undefined;

	return `${roundedWidth}×${roundedHeight}`;
}

function formatRefreshRate(refreshRate?: number) {
	if (!refreshRate) return undefined;

	return `${refreshRate} Hz`;
}

type TargetCardProps = (
	| {
			variant: "display";
			target: CaptureDisplayWithThumbnail;
	  }
	| {
			variant: "window";
			target: CaptureWindowWithThumbnail;
	  }
) &
	Omit<ComponentProps<"button">, "children"> & {
		highlightQuery?: string;
	};

export default function TargetCard(props: TargetCardProps) {
	const [local, rest] = splitProps(props, [
		"variant",
		"target",
		"class",
		"disabled",
		"highlightQuery",
	]);

	const displayTarget = createMemo(() => {
		if (local.variant !== "display") return undefined;
		return local.target as CaptureDisplayWithThumbnail;
	});

	const windowTarget = createMemo(() => {
		if (local.variant !== "window") return undefined;
		return local.target as CaptureWindowWithThumbnail;
	});

	const renderIcon = (className: string) =>
		local.variant === "display" ? (
			<IconMdiMonitor class={className} />
		) : (
			<IconLucideAppWindowMac class={className} />
		);

	const label = createMemo(() => {
		const display = displayTarget();
		if (display) return display.name;
		const target = windowTarget();
		return target?.name || target?.owner_name;
	});

	const subtitle = createMemo(() => windowTarget()?.owner_name);

	const metadata = createMemo(() => {
		if (local.variant === "window") {
			const target = windowTarget();
			if (!target) return undefined;
			const bounds = target.bounds;
			const resolution = formatResolution(
				bounds?.size.width,
				bounds?.size.height,
			);
			const refreshRate = formatRefreshRate(target.refresh_rate);

			if (resolution && refreshRate) return `${resolution} @ ${refreshRate}`;
			return resolution ?? refreshRate ?? undefined;
		}

		const target = displayTarget();
		return target ? formatRefreshRate(target.refresh_rate) : undefined;
	});

	const thumbnailSrc = createMemo(() => {
		const target = displayTarget() ?? windowTarget();
		if (!target?.thumbnail) return undefined;
		return `data:image/png;base64,${target.thumbnail}`;
	});

	const appIconSrc = createMemo(() => {
		const target = windowTarget();
		if (!target?.app_icon) return undefined;
		return `data:image/png;base64,${target.app_icon}`;
	});

	const normalizedQuery = createMemo(() => local.highlightQuery?.trim() ?? "");

	const highlight = (text?: string | null) => {
		if (!text) return text;
		const query = normalizedQuery();
		if (!query) return text;

		const regex = new RegExp(`(${escapeRegExp(query)})`, "ig");
		const parts = text.split(regex);
		if (parts.length === 1) return text;

		const lowercaseQuery = query.toLowerCase();

		return parts.map((part) => {
			if (part.toLowerCase() === lowercaseQuery) {
				return (
					<span class="rounded bg-blue-9/20 px-[1px] text-gray-12">{part}</span>
				);
			}
			return part;
		});
	};

	return (
		<button
			type="button"
			{...rest}
			disabled={local.disabled}
			data-variant={local.variant}
			class={cx(
				"group flex flex-col overflow-hidden rounded-lg border border-transparent bg-gray-3 text-left outline-none transition-colors duration-100 hover:bg-gray-4 focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1",
				local.disabled && "pointer-events-none opacity-60",
				local.class,
			)}
		>
			<div class="relative h-[4.75rem] w-full overflow-hidden bg-gray-4/40">
				<Show
					when={thumbnailSrc()}
					fallback={
						<div class="flex justify-center items-center w-full h-full bg-gray-4">
							{renderIcon("size-6 text-gray-9 opacity-70")}
						</div>
					}
				>
					<img
						src={thumbnailSrc()!}
						alt={`${
							local.variant === "display" ? "Display" : "Window"
						} preview for ${label()}`}
						class="object-cover w-full h-full"
						loading="lazy"
						draggable={false}
					/>
				</Show>
				<Show when={appIconSrc()}>
					<div class="flex absolute inset-0 justify-center items-center pointer-events-none bg-black/45">
						<img
							src={appIconSrc()!}
							alt={`${label()} icon`}
							class="h-16 w-16 max-h-[55%] max-w-[55%] rounded-lg border border-black/20 object-contain shadow-lg shadow-black/30"
							draggable={false}
						/>
					</div>
				</Show>
				<div class="absolute inset-0 border opacity-60 pointer-events-none border-black/5" />
				<div class="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent pointer-events-none from-black/40" />
			</div>
			<div class="flex flex-row items-start gap-2 px-2 py-1.5">
				<div class="flex-1 min-w-0">
					<p class="truncate text-[11px] font-medium text-gray-12">
						{highlight(label())}
					</p>
					<Show when={subtitle()}>
						<p class="truncate text-[11px] text-gray-11">
							{highlight(subtitle())}
						</p>
					</Show>
					<Show when={metadata()}>
						<p class="truncate text-[11px] text-gray-10">
							{highlight(metadata())}
						</p>
					</Show>
				</div>
			</div>
		</button>
	);
}

function escapeRegExp(value: string) {
	return value.replace(/[\^$*+?.()|[\]{}-]/g, "\\$&");
}

export function TargetCardSkeleton(props: { class?: string }) {
	return (
		<div
			class={cx(
				"flex flex-col overflow-hidden rounded-lg bg-gray-3",
				props.class,
			)}
		>
			<div class="h-[4.75rem] w-full animate-pulse bg-gray-4" />
			<div class="flex flex-row items-start gap-2 px-2 py-1.5">
				<div class="flex-1 space-y-1">
					<div class="w-3/4 h-3 rounded bg-gray-4" />
					<div class="h-2.5 w-1/2 rounded bg-gray-4" />
					<div class="h-2.5 w-2/5 rounded bg-gray-4" />
				</div>
			</div>
		</div>
	);
}
