import { cx } from "cva";
import { For } from "solid-js";
import { Transition } from "solid-transition-group";
import { commands, type RecordingMode } from "~/utils/tauri";
import IconLucideArrowLeft from "~icons/lucide/arrow-left";
import { useRecordingOptions } from "../OptionsContext";

interface ModeInfoPanelProps {
	onBack: () => void;
}

const modeOptions = [
	{
		mode: "instant" as RecordingMode,
		title: "即时模式",
		description: "通过链接即时分享。录制内容会同步上传，结束后即可立即分享。",
		icon: IconCapInstant,
	},
	{
		mode: "studio" as RecordingMode,
		title: "工作室模式",
		description:
			"以最高画质在本地录制，便于稍后编辑。适合制作带有效果和转场的精致内容。",
		icon: IconCapFilmCut,
	},
	{
		mode: "screenshot" as RecordingMode,
		title: "截图模式",
		description: "快速截取并标注屏幕画面，适合随手截图、提交问题和可视化沟通。",
		icon: IconCapScreenshot,
	},
];

export default function ModeInfoPanel(props: ModeInfoPanelProps) {
	const { rawOptions, setOptions } = useRecordingOptions();

	const handleModeSelect = (mode: RecordingMode) => {
		setOptions({ mode });
		commands.setRecordingMode(mode);
		props.onBack();
	};

	return (
		<div class="flex flex-col w-full h-full min-h-0">
			<div class="flex gap-3 justify-between items-center mt-3">
				<button
					type="button"
					onClick={() => props.onBack()}
					class="flex gap-1 items-center rounded-md px-1.5 text-xs
					text-gray-11 transition-opacity hover:opacity-70 hover:text-gray-12
					focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1"
				>
					<IconLucideArrowLeft class="size-3 text-gray-11" />
					<span class="font-medium text-gray-12">返回</span>
				</button>
				<span class="text-xs font-medium text-gray-11">录制模式</span>
			</div>
			<div class="flex flex-col flex-1 min-h-0 pt-4">
				<div class="px-1 custom-scroll flex-1 overflow-y-auto">
					<div class="flex flex-col gap-2 pb-4">
						<For each={modeOptions}>
							{(option, index) => {
								const isSelected = () => rawOptions.mode === option.mode;

								return (
									<Transition
										appear
										enterActiveClass="transition duration-200"
										enterClass="scale-95 opacity-0"
										enterToClass="scale-100 opacity-100"
										exitActiveClass="transition duration-200"
										exitClass="scale-100"
										exitToClass="scale-95"
									>
										<div style={{ "transition-delay": `${index() * 100}ms` }}>
											<button
												type="button"
												onClick={() => handleModeSelect(option.mode)}
												class={cx(
													"relative flex items-center gap-3 p-3 w-full text-left rounded-xl border-2 transition-all duration-200",
													isSelected()
														? "border-blue-9 bg-blue-3 dark:bg-blue-3/30"
														: "border-gray-4 dark:border-gray-5 bg-gray-2 dark:bg-gray-3 hover:border-gray-6 dark:hover:border-gray-6 hover:bg-gray-3 dark:hover:bg-gray-4",
												)}
											>
												{isSelected() && (
													<div class="absolute top-2 right-2 flex items-center justify-center size-4 rounded-full bg-blue-9">
														<IconLucideCheck class="size-2.5 text-white" />
													</div>
												)}

												<div class="shrink-0">
													<option.icon
														class={cx(
															"size-5 invert dark:invert-0",
															isSelected() && "text-blue-11",
														)}
													/>
												</div>

												<div class="flex flex-col flex-1 min-w-0">
													<h3
														class={cx(
															"text-sm font-semibold",
															isSelected() ? "text-blue-11" : "text-gray-12",
														)}
													>
														{option.title}
													</h3>
													<p class="text-xs leading-relaxed text-gray-11">
														{option.description}
													</p>
												</div>
											</button>
										</div>
									</Transition>
								);
							}}
						</For>
					</div>
				</div>
			</div>
		</div>
	);
}
