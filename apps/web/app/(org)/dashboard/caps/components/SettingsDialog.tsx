import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Switch,
} from "@cap/ui";
import type { SpaceRuleSource, ViewerSettingKey } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { faGear } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { updateVideoSettings } from "@/actions/videos/settings";
import { DEFAULT_PLAYBACK_SPEED, PLAYBACK_SPEEDS } from "@/lib/playback-speed";
import { useDashboardContext } from "../../Contexts";
import type { OrganizationSettings } from "../../dashboard-data";

interface SettingsDialogProps {
	isOpen: boolean;
	onClose: () => void;
	capId: Video.VideoId;
	settingsData?: OrganizationSettings;
	inheritedSpaceSettings?: Partial<Record<ViewerSettingKey, SpaceRuleSource[]>>;
}

const options: {
	label: string;
	value: ViewerSettingKey;
	description: string;
	pro?: boolean;
}[] = [
	{
		label: "启用评论",
		value: "disableComments",
		description: "允许观看者评论此录制内容",
	},
	{
		label: "启用摘要",
		value: "disableSummary",
		description: "显示 AI 生成的摘要（需要文字稿）",
		pro: true,
	},
	{
		label: "启用字幕",
		value: "disableCaptions",
		description: "允许观看者使用此录制内容的字幕",
	},
	{
		label: "启用章节",
		value: "disableChapters",
		description: "显示 AI 生成的章节（需要文字稿）",
		pro: true,
	},
	{
		label: "启用回应",
		value: "disableReactions",
		description: "允许观看者回应此录制内容",
	},
	{
		label: "启用文字稿",
		value: "disableTranscript",
		description: "启用后也会允许显示摘要和章节",
		pro: true,
	},
];

export const SettingsDialog = ({
	isOpen,
	onClose,
	capId,
	settingsData,
	inheritedSpaceSettings,
}: SettingsDialogProps) => {
	const { user, organizationSettings } = useDashboardContext();
	const [saveLoading, setSaveLoading] = useState(false);
	const buildSettings = useCallback(
		(data?: OrganizationSettings): OrganizationSettings => ({
			disableComments: data?.disableComments,
			disableSummary: data?.disableSummary,
			disableCaptions: data?.disableCaptions,
			disableChapters: data?.disableChapters,
			disableReactions: data?.disableReactions,
			disableTranscript: data?.disableTranscript,
			defaultPlaybackSpeed: data?.defaultPlaybackSpeed,
		}),
		[],
	);

	const [settings, setSettings] = useState<OrganizationSettings>(
		buildSettings(settingsData),
	);

	useEffect(() => {
		if (isOpen) {
			setSettings(buildSettings(settingsData));
		}
	}, [buildSettings, isOpen, settingsData]);

	const saveHandler = async () => {
		if (!settings) return;
		setSaveLoading(true);
		try {
			const payload = Object.fromEntries(
				Object.entries(settings).filter(([, v]) => v !== undefined),
			) as Partial<OrganizationSettings>;
			await updateVideoSettings(capId, payload);
			toast.success("设置已更新");
			onClose();
		} catch (error) {
			console.error("更新视频设置时出错：", error);
			toast.error("更新设置失败");
		} finally {
			setSaveLoading(false);
		}
	};

	const toggleSettingHandler = useCallback(
		(value: ViewerSettingKey) => {
			setSettings((prev) => {
				const key = value;
				const currentValue = prev?.[key];
				const orgValue = organizationSettings?.[key] ?? false;

				const newValue = currentValue === undefined ? !orgValue : !currentValue;

				if (key === "disableTranscript" && newValue === true) {
					return {
						...prev,
						[key]: newValue,
						disableSummary: true,
						disableChapters: true,
					};
				}

				return {
					...prev,
					[key]: newValue,
				};
			});
		},
		[organizationSettings],
	);

	const getEffectiveValue = (key: ViewerSettingKey) => {
		const inheritedSources = inheritedSpaceSettings?.[key];
		if (inheritedSources && inheritedSources.length > 0) return true;
		const videoValue = settings?.[key];
		const orgValue = organizationSettings?.[key] ?? false;
		return videoValue !== undefined || videoValue === true
			? videoValue
			: orgValue;
	};

	const getInheritedLabel = (key: ViewerSettingKey) => {
		const sources = inheritedSpaceSettings?.[key];
		if (!sources || sources.length === 0) return null;
		if (sources.length === 1) return `由 ${sources[0]?.name} 强制设置`;
		return `由 ${sources.length} 个空间强制设置`;
	};

	const handleSpeedChange = (speed: number) =>
		setSettings((prev) => ({ ...prev, defaultPlaybackSpeed: speed }));

	const videoSpeed = settings?.defaultPlaybackSpeed;
	const orgSpeed = organizationSettings?.defaultPlaybackSpeed;
	const selectedSpeed = videoSpeed ?? orgSpeed ?? DEFAULT_PLAYBACK_SPEED;
	const isInheritingSpeed = videoSpeed === undefined;

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="max-w-md min-w-fit">
				<DialogHeader
					description="管理此录制内容的设置"
					icon={<FontAwesomeIcon icon={faGear} className="size-3.5" />}
				>
					<DialogTitle>设置</DialogTitle>
				</DialogHeader>
				<div className="grid grid-cols-2 gap-3 p-5">
					{options.map((option) => {
						const key = option.value;
						const effectiveValue = getEffectiveValue(key);
						const orgValue = organizationSettings?.[key] ?? false;
						const inheritedLabel = getInheritedLabel(key);
						return (
							<div
								key={option.value}
								className="flex gap-10 justify-between items-center p-4 rounded-xl border transition-colors min-w-fit border-gray-3 bg-gray-1"
							>
								<div
									className={clsx(
										"flex flex-col flex-1",
										option.pro && "gap-1",
									)}
								>
									<div className="flex gap-1.5 items-center flex-wrap">
										<p className="text-sm text-gray-12">{option.label}</p>
										{option.pro && (
											<p className="py-1 px-1.5 text-[10px] leading-none font-medium rounded-full text-white bg-blue-11">
												Pro
											</p>
										)}
										{effectiveValue && (
											<p className="py-1 px-1.5 text-[10px] leading-none font-medium rounded-full text-gray-11 bg-gray-5">
												{inheritedLabel ??
													`组织默认${orgValue ? "已禁用" : "已启用"}`}
											</p>
										)}
									</div>
									<p className="text-xs text-gray-10">{option.description}</p>
								</div>
								<Switch
									disabled={
										Boolean(inheritedLabel) ||
										(option.pro && !user.isPro) ||
										((key === "disableSummary" || key === "disableChapters") &&
											getEffectiveValue("disableTranscript"))
									}
									onCheckedChange={() => toggleSettingHandler(option.value)}
									checked={!effectiveValue}
								/>
							</div>
						);
					})}
				</div>
				<div className="px-5 pb-5">
					<div className="flex flex-col gap-3 p-4 rounded-xl border border-gray-3 bg-gray-1">
						<div className="flex flex-col gap-1">
							<div className="flex gap-1.5 items-center flex-wrap">
								<p className="text-sm text-gray-12">默认播放速度</p>
								{isInheritingSpeed && (
									<p className="py-1 px-1.5 text-[10px] leading-none font-medium rounded-full text-gray-11 bg-gray-5">
										组织默认 {orgSpeed ?? DEFAULT_PLAYBACK_SPEED}×
									</p>
								)}
							</div>
							<p className="text-xs text-gray-10">
								此录制内容开始播放时的速度。观看者仍可自行调整。
							</p>
						</div>
						<div className="flex flex-wrap gap-1 items-center p-1 w-fit rounded-lg border bg-gray-2 border-gray-3">
							{PLAYBACK_SPEEDS.map((speed) => (
								<button
									key={speed}
									type="button"
									onClick={() => handleSpeedChange(speed)}
									aria-pressed={selectedSpeed === speed}
									className={clsx(
										"min-w-10 rounded-md px-2 py-1 text-xs font-medium tabular-nums transition-colors",
										selectedSpeed === speed
											? "text-white bg-blue-11"
											: "text-gray-11 hover:bg-gray-3",
									)}
								>
									{speed}×
								</button>
							))}
						</div>
					</div>
				</div>
				<DialogFooter className="p-5 border-t border-gray-4">
					<Button
						variant="gray"
						size="sm"
						onClick={onClose}
						disabled={saveLoading}
					>
						取消
					</Button>
					<Button
						variant="dark"
						size="sm"
						onClick={saveHandler}
						spinner={saveLoading}
						disabled={saveLoading}
					>
						{saveLoading ? "正在保存……" : "保存"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
