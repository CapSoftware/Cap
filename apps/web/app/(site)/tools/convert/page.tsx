import type { Metadata } from "next";
import Link from "next/link";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "文件转换工具 | 免费在线转换器",
	description:
		"Free online file conversion tools. Convert between various file formats directly in your browser with no uploads needed.",
	alternates: {
		canonical: "https://cap.so/tools/convert",
	},
};

interface ConversionTool {
	title: string;
	description: string;
	href: string;
	icon: string;
}

const conversionTools: ConversionTool[] = [
	{
		title: "WebM 转 MP4",
		description: "直接在浏览器中将 WebM 视频转换为 MP4 格式",
		href: "/tools/convert/webm-to-mp4",
		icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z",
	},
	{
		title: "MP4 转 MP3",
		description: "从 MP4 视频提取音频并保存为 MP3 文件",
		href: "/tools/convert/mp4-to-mp3",
		icon: "M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3",
	},
	{
		title: "MP4 转 GIF",
		description: "将 MP4 视频转换为 GIF 动图",
		href: "/tools/convert/mp4-to-gif",
		icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z",
	},
	{
		title: "MOV 转 MP4",
		description: "将 MOV 视频转换为兼容性更好的 MP4 格式",
		href: "/tools/convert/mov-to-mp4",
		icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z",
	},
	{
		title: "AVI 转 MP4",
		description: "将 AVI 视频转换为现代 MP4 格式",
		href: "/tools/convert/avi-to-mp4",
		icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z",
	},
	{
		title: "MKV 转 MP4",
		description: "将 MKV 视频转换为广泛支持的 MP4 格式",
		href: "/tools/convert/mkv-to-mp4",
		icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z",
	},
	{
		title: "MP4 转 WebM",
		description:
			"Convert MP4 videos to WebM format for better web compatibility",
		href: "/tools/convert/mp4-to-webm",
		icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z",
	},
];

const breadcrumbSchema = createBreadcrumbSchema([
	{ name: "Home", url: "https://cap.so" },
	{ name: "Tools", url: "https://cap.so/tools" },
	{ name: "Convert", url: "https://cap.so/tools/convert" },
]);

export default function ConvertToolsPage() {
	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(breadcrumbSchema),
				}}
			/>
			<div className="py-32 md:py-40">
				<div className="wrapper">
					<div className="mb-8">
						<Link
							href="/tools"
							className="inline-flex items-center text-sm text-blue-600 hover:text-blue-800"
						>
							<svg
								className="mr-1 w-5 h-5"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								xmlns="http://www.w3.org/2000/svg"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M10 19l-7-7m0 0l7-7m-7 7h18"
								/>
							</svg>
							Back to All Tools
						</Link>
					</div>

					<h1 className="mb-8 text-3xl font-medium tracking-tight text-gray-900">
						File Conversion Tools
					</h1>
					<p className="mb-12 text-lg text-gray-600">
						Our free online conversion tools help you transform files between
						different formats without uploading them to any server. All
						conversions happen directly in your browser for maximum privacy and
						security.
					</p>

					<div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
						{conversionTools.map((tool) => (
							<Link
								key={tool.href}
								href={tool.href}
								className="block p-6 rounded-lg border border-gray-200 transition-colors group hover:border-blue-500"
							>
								<div className="flex items-center mb-4">
									<div className="flex-shrink-0 p-2 bg-blue-100 rounded-lg">
										<svg
											className="w-6 h-6 text-blue-600"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
											strokeWidth={1.5}
										>
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												d={tool.icon}
											/>
										</svg>
									</div>
									<h2 className="ml-3 text-xl font-semibold text-gray-900 transition-colors group-hover:text-blue-600">
										{tool.title}
									</h2>
								</div>
								<p className="text-gray-600">{tool.description}</p>
							</Link>
						))}
					</div>
				</div>
			</div>
		</>
	);
}
