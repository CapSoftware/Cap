import * as shell from "@tauri-apps/plugin-shell";
import { cx } from "cva";
import { createMemo, Show } from "solid-js";
import toast from "solid-toast";
import {
	describeUploadHealth,
	type UploadHealthStatus,
} from "~/utils/upload-health";
import IconLucideRefreshCw from "~icons/lucide/refresh-cw";
import Tooltip from "./Tooltip";

export default function UploadHealthIndicator(props: {
	status: UploadHealthStatus | null;
	refreshing: boolean;
	disabled: boolean;
	onRefresh: () => void;
}) {
	const presentation = createMemo(() => describeUploadHealth(props.status));
	const toneClass = createMemo(() => {
		switch (presentation().tone) {
			case "good":
				return "border-green-6 bg-green-3 text-green-12";
			case "warning":
				return "border-amber-6 bg-amber-3 text-amber-12";
			case "danger":
				return "border-red-6 bg-red-3 text-red-12";
			default:
				return "border-gray-5 bg-gray-3 text-gray-11";
		}
	});
	const statusLabel = () =>
		`${presentation().label}. ${presentation().detail}.`;

	return (
		<div class="flex min-w-0 max-w-full items-center gap-1.5">
			<Tooltip
				childClass="min-w-0"
				content={
					<span>
						{props.status?.message || "Check the API upload connection"}
					</span>
				}
			>
				<button
					type="button"
					disabled={props.disabled || props.refreshing}
					onClick={props.onRefresh}
					aria-label={
						props.refreshing
							? `Checking upload. ${statusLabel()}`
							: `Refresh upload check. ${statusLabel()}`
					}
					aria-busy={props.refreshing}
					class={cx(
						"flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] leading-none transition hover:opacity-80 disabled:pointer-events-none disabled:opacity-70",
						toneClass(),
					)}
				>
					<span
						class="flex min-w-0 items-center gap-1.5"
						aria-live="polite"
						aria-atomic="true"
					>
						<span class="truncate font-medium">{presentation().label}</span>
						<span class="truncate opacity-75">{presentation().detail}</span>
					</span>
					<IconLucideRefreshCw
						aria-hidden="true"
						class={cx("size-3 shrink-0", props.refreshing && "animate-spin")}
					/>
				</button>
			</Tooltip>
			<Show when={props.status?.kind === "unavailable" && !props.status.stale}>
				<button
					type="button"
					aria-label="Contact Cap support about the upload check"
					class="shrink-0 text-[11px] underline text-gray-11 hover:text-gray-12"
					onClick={() => {
						void shell.open("mailto:hello@cap.so").catch((error) => {
							console.error("Failed to open support email:", error);
							toast.error("Contact Cap support at hello@cap.so");
						});
					}}
				>
					Support
				</button>
			</Show>
		</div>
	);
}
