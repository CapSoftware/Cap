import { cx } from "cva";
import { Transition } from "solid-transition-group";
import IconLucideArrowLeft from "~icons/lucide/arrow-left";
import IconLucideCamera from "~icons/lucide/camera";

interface MoreOptionsPanelProps {
	onBack: () => void;
	onCameraOnly: () => void;
	disabled?: boolean;
}

export default function MoreOptionsPanel(props: MoreOptionsPanelProps) {
	return (
		<div class="flex flex-col w-full h-full min-h-0">
			<div class="flex gap-3 justify-between items-center mt-3">
				<div
					onClick={() => props.onBack()}
					class="flex gap-1 items-center rounded-md px-1.5 text-xs cursor-pointer
					text-gray-11 transition-opacity hover:opacity-70 hover:text-gray-12
					focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1"
				>
					<IconLucideArrowLeft class="size-3 text-gray-11" />
					<span class="font-medium text-gray-12">Back</span>
				</div>
				<span class="text-xs font-medium text-gray-11">More Options</span>
			</div>
			<div class="flex flex-col flex-1 min-h-0 pt-4">
				<div class="px-1 custom-scroll flex-1 overflow-y-auto">
					<div class="flex flex-col gap-2 pb-4">
						<Transition
							appear
							enterActiveClass="transition duration-200"
							enterClass="scale-95 opacity-0"
							enterToClass="scale-100 opacity-100"
							exitActiveClass="transition duration-200"
							exitClass="scale-100"
							exitToClass="scale-95"
						>
							<div>
								<button
									type="button"
									onClick={() => !props.disabled && props.onCameraOnly()}
									disabled={props.disabled}
									class={cx(
										"relative flex items-center gap-3 p-3 rounded-xl border-2 transition-all duration-200 w-full text-left",
										"border-gray-4 dark:border-gray-5 bg-gray-2 dark:bg-gray-3 hover:border-gray-6 dark:hover:border-gray-6 hover:bg-gray-3 dark:hover:bg-gray-4",
										props.disabled && "opacity-50 cursor-not-allowed",
									)}
								>
									<div class="flex-shrink-0">
										<IconLucideCamera class="size-5 text-gray-11" />
									</div>

									<div class="flex flex-col flex-1 min-w-0">
										<h3 class="text-sm font-semibold text-gray-12">
											Camera only
										</h3>
										<p class="text-xs leading-relaxed text-gray-11">
											Record only your camera without capturing any screen
											content. Perfect for video messages and presentations.
										</p>
									</div>
								</button>
							</div>
						</Transition>
					</div>
				</div>
			</div>
		</div>
	);
}
