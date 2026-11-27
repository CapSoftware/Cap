import { Collapsible as KCollapsible } from "@kobalte/core/collapsible";
import IconLucideInfo from "~icons/lucide/info";

export function ZoomModeHelper(props: { mode: "auto" | "manual" }) {
	return (
		<KCollapsible>
			<KCollapsible.Trigger class="flex flex-row gap-1.5 items-center w-full text-xs font-medium transition-colors duration-200 group text-gray-11 hover:text-gray-12 outline-hidden">
				<IconLucideInfo class="size-3.5" />
				How does it work?
				<IconCapChevronDown class="ml-auto transition-transform duration-200 size-3.5 group-data-expanded:rotate-180" />
			</KCollapsible.Trigger>
			<KCollapsible.Content class="overflow-hidden opacity-0 transition-opacity animate-collapsible-up data-expanded:animate-collapsible-down data-expanded:opacity-100">
				<div class="pt-2 space-y-1.5">
					<style>
						{`
						@keyframes cap-zoom-mode-helper-path {
							0% { left: 26%; top: 36%; }
							30% { left: 72%; top: 30%; }
							55% { left: 64%; top: 68%; }
							80% { left: 32%; top: 64%; }
							100% { left: 26%; top: 36%; }
						}
						.cap-zoom-mode-helper-cursor,
						.cap-zoom-mode-helper-viewport-auto {
							left: 26%;
							top: 36%;
							animation: cap-zoom-mode-helper-path 7s ease-in-out infinite;
						}
						.cap-zoom-mode-helper-viewport-auto {
							animation-delay: 0.35s;
						}
						@media (prefers-reduced-motion: reduce) {
							.cap-zoom-mode-helper-cursor,
							.cap-zoom-mode-helper-viewport-auto {
								animation: none;
							}
						}
						`}
					</style>
					<div class="overflow-hidden relative w-full rounded-lg border bg-gray-3 border-gray-4 h-[88px]">
						<div
							data-visible={props.mode === "auto"}
							class="cap-zoom-mode-helper-viewport-auto absolute rounded-md border-2 opacity-0 transition-opacity duration-300 -translate-x-1/2 -translate-y-1/2 border-blue-9/60 bg-blue-9/10 w-[42%] h-[55%] data-[visible='true']:opacity-100"
						/>
						<div
							data-visible={props.mode === "manual"}
							class="absolute left-1/2 top-1/2 rounded-md border-2 opacity-0 transition-opacity duration-300 -translate-x-1/2 -translate-y-1/2 border-blue-9/60 bg-blue-9/10 w-[42%] h-[55%] data-[visible='true']:opacity-100"
						/>
						<div class="cap-zoom-mode-helper-cursor absolute">
							<IconCapCursor class="text-gray-12 size-3.5" />
						</div>
					</div>
					<p class="text-xs text-gray-11">
						{props.mode === "auto"
							? "Automatic zoom follows your cursor around the screen."
							: "Manual zoom stays on a fixed spot you pick below."}
					</p>
				</div>
			</KCollapsible.Content>
		</KCollapsible>
	);
}
