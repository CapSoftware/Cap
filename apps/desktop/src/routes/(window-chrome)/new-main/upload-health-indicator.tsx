import { cx } from "cva";
import { createEffect, createSignal, onMount, Show } from "solid-js";

import Tooltip from "~/components/Tooltip";
import { authStore } from "~/store";
import { createTauriEventListener } from "~/utils/createEventListener";
import { commands, events, type UploadHealthStatus } from "~/utils/tauri";
import {
	uploadHealthDisplay,
	uploadHealthVisible,
} from "~/utils/upload-health";
import IconLucideGauge from "~icons/lucide/gauge";
import IconLucideRefreshCw from "~icons/lucide/refresh-cw";

const DOT_COLORS = {
	ok: "bg-jade-9",
	warn: "bg-yellow-9",
	error: "bg-red-9",
	muted: "bg-gray-8",
} as const;

export default function UploadHealthIndicator() {
	const auth = authStore.createQuery();
	const [status, setStatus] = createSignal<UploadHealthStatus | null>(null);

	onMount(() => {
		commands
			.getUploadHealth()
			.then(setStatus)
			.catch(() => undefined);
	});

	createEffect(() => {
		if (auth.data) {
			void commands
				.runUploadHealthCheck()
				.then(setStatus)
				.catch(() => undefined);
		}
	});

	createTauriEventListener(events.uploadHealthChanged, setStatus);

	const display = () => {
		const current = status();
		return current ? uploadHealthDisplay(current) : null;
	};

	const tooltipContent = () => {
		const current = status();
		const d = display();
		if (!current || !d) return null;
		return (
			<div class="flex max-w-[240px] flex-col gap-1">
				<span class="font-medium">{d.label}</span>
				<Show when={d.detail}>{(detail) => <span>{detail()}</span>}</Show>
				<Show when={current.recommendedMaxWidth}>
					{(width) => (
						<span>
							Instant recordings are capped at {width()}px wide based on the
							measured upload speed.
						</span>
					)}
				</Show>
				<Show when={current.recordingActive}>
					<span>Upload checks are paused while recording.</span>
				</Show>
			</div>
		);
	};

	const refresh = () => {
		void commands
			.runUploadHealthCheck()
			.then(setStatus)
			.catch(() => undefined);
	};

	return (
		<Show when={auth.data && status()}>
			{(current) => (
				<Show when={uploadHealthVisible(current())}>
					<div class="flex items-center gap-1 rounded-md bg-gray-3 px-1.5 py-1">
						<Tooltip content={tooltipContent()}>
							<div class="flex items-center gap-1.5">
								<span
									class={cx(
										"size-1.5 rounded-full",
										DOT_COLORS[display()?.severity ?? "muted"],
									)}
								/>
								<IconLucideGauge class="size-3 text-gray-11" />
								<span class="text-[11px] font-medium leading-none text-gray-12">
									{display()?.label}
								</span>
							</div>
						</Tooltip>
						<Show when={display()?.showSupport}>
							<button
								type="button"
								class="text-[11px] font-medium leading-none text-blue-10 underline underline-offset-2 hover:text-blue-11"
								onClick={() =>
									void commands.showWindow({
										Settings: { page: "feedback" },
									})
								}
							>
								Contact support
							</button>
						</Show>
						<Tooltip content={<span>Re-check upload speed</span>}>
							<button
								type="button"
								class="flex size-4 items-center justify-center rounded text-gray-10 transition-colors hover:text-gray-12 disabled:opacity-40"
								disabled={
									current().state === "checking" || current().recordingActive
								}
								onClick={refresh}
								aria-label="Re-check upload speed"
							>
								<IconLucideRefreshCw class="size-3" />
							</button>
						</Tooltip>
					</div>
				</Show>
			)}
		</Show>
	);
}
