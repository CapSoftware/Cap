"use client";

import { Button, LogoBadge } from "@cap/ui";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { Clapperboard, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getPlatformIcon,
} from "@/utils/platform";

const recordingModes = [
	{
		name: "即时模式",
		icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
		description:
			"点击录制、停止，再分享链接。视频可在数秒内上线，并自动生成字幕、标题、摘要、章节等内容。适合快速反馈、提交错误报告，或随时清晰演示操作。",
	},
	{
		name: "工作室模式",
		icon: (
			<Clapperboard
				fill="var(--blue-9)"
				className="mb-4 size-8"
				strokeWidth={1.5}
			/>
		),
		description:
			"提供本地编辑、自定义背景和多种导出选项的专业录制模式。适合制作精致演示、教程或体现品牌形象的演示文稿。",
	},
];

export function DownloadPage() {
	const { platform, isIntel } = useDetectPlatform();
	const loading = platform === null;
	const router = useRouter();

	return (
		<div className="flex flex-col gap-12 justify-center items-center min-h-fit lg:gap-20">
			<div className="space-y-10">
				<div className="flex flex-col gap-6 justify-center items-center">
					<LogoBadge className="mx-auto w-auto h-12" />
					<div className="space-y-1 text-center">
						<h1 className="text-3xl font-medium text-gray-12">下载 Cap</h1>
						<p className="text-lg text-center text-gray-11 text-pretty">
							立即开始制作精美的屏幕录像
						</p>
					</div>
				</div>
				<div className="flex flex-wrap gap-10 justify-center items-center w-full max-w-[1000px] mx-auto">
					{recordingModes.map((recordingMode) => (
						<div
							key={recordingMode.name}
							className="flex flex-col w-full max-w-[440px] gap-2 items-center p-6 text-center rounded-xl border bg-gray-2 border-gray-3"
						>
							{recordingMode.icon}
							<h2 className="text-xl font-medium text-gray-12">
								{recordingMode.name}
							</h2>
							<p className="text-base text-gray-10 text-pretty">
								{recordingMode.description}
							</p>
						</div>
					))}
				</div>
			</div>
			<div className="flex flex-wrap gap-4 justify-center">
				<Button
					variant="blue"
					size="lg"
					href={getDownloadUrl(platform, isIntel)}
					className="hidden justify-center items-center py-6 font-medium text-white lg:flex"
				>
					{!loading && getPlatformIcon(platform)}
					{getDownloadButtonText(platform, loading, isIntel)}
				</Button>
				<Button
					onClick={() => router.push("/dashboard/caps")}
					className="min-w-[120px]"
					variant="dark"
					size="lg"
				>
					继续
				</Button>
			</div>
		</div>
	);
}
