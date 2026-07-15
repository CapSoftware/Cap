"use client";

import {
	Command,
	CommandInput,
	CommandItem,
	CommandList,
	Dialog,
	DialogContent,
	DialogTitle,
} from "@cap/ui";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import {
	BarChart3,
	Bell,
	Building2,
	CreditCard,
	FileVideo,
	FolderSearch,
	Image,
	Layers3,
	Loader2,
	type LucideIcon,
	Radio,
	Search,
	Settings,
	Sparkles,
	Upload,
	UserRound,
	UsersRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
	canViewOrganizationSettings,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { useDashboardContext } from "../../Contexts";
import type { Spaces } from "../../dashboard-data";
import {
	type DashboardVideoSearchResult,
	searchDashboardVideos,
} from "./search";

const MAX_LOCAL_RESULTS = 6;
const MAX_SPACE_RESULTS = 5;
const MAX_VIDEO_CACHE_SIZE = 25;
const MAX_SEARCH_QUERY_LENGTH = 80;
const VIDEO_SEARCH_DEBOUNCE_MS = 180;
const MIN_VIDEO_QUERY_LENGTH = 2;

const videoDateFormatter = new Intl.DateTimeFormat("zh-CN", {
	month: "short",
	day: "numeric",
	year: "numeric",
});

type SearchItem = {
	id: string;
	title: string;
	subtitle: string;
	href: string;
	value: string;
	icon: LucideIcon;
	badge?: string;
};

const normalizeQuery = (query: string) =>
	query.trim().replace(/\s+/g, " ").toLowerCase();

const matchesQuery = (item: SearchItem, query: string) =>
	item.value.toLowerCase().includes(query);

const filterItems = (items: SearchItem[], query: string, limit: number) =>
	(query ? items.filter((item) => matchesQuery(item, query)) : items).slice(
		0,
		limit,
	);

const formatDuration = (duration: number | null) => {
	if (!duration || duration <= 0) return null;
	const totalSeconds = Math.round(duration);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	if (minutes < 60) return `${minutes}:${seconds.toString().padStart(2, "0")}`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}:${remainingMinutes.toString().padStart(2, "0")}:${seconds
		.toString()
		.padStart(2, "0")}`;
};

const formatVideoSubtitle = (video: DashboardVideoSearchResult) => {
	const parts = [
		video.isScreenshot ? "截图" : "视频",
		video.ownerName ? `创建者：${video.ownerName}` : null,
		videoDateFormatter.format(new Date(video.createdAt)),
		formatDuration(video.duration),
	].filter((part): part is string => Boolean(part));

	return parts.join(" · ");
};

const createSpaceItem = (space: Spaces): SearchItem => ({
	id: `space-${space.id}`,
	title: space.name,
	subtitle: `${space.videoCount} 个视频 · ${space.memberCount} 位成员`,
	href: `/dashboard/spaces/${space.id}`,
	value: `${space.name} ${space.description ?? ""} ${space.privacy} space`,
	icon: space.primary ? Building2 : Layers3,
	badge: space.primary ? "组织" : space.privacy === "Public" ? "公开" : "私密",
});

export function DashboardSearch({
	shortcutEnabled = true,
}: {
	shortcutEnabled?: boolean;
} = {}) {
	const router = useRouter();
	const { activeOrganization, spacesData, user } = useDashboardContext();
	const { platform } = useDetectPlatform();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [videoResults, setVideoResults] = useState<
		DashboardVideoSearchResult[]
	>([]);
	const [videoLoading, setVideoLoading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const requestIdRef = useRef(0);
	const videoCacheRef = useRef(new Map<string, DashboardVideoSearchResult[]>());
	const shortcutKey = platform === "macos" ? "⌘K" : "Ctrl K";

	const currentMember = activeOrganization?.members.find(
		(member) => member.userId === user.id,
	);
	const currentRole = getEffectiveOrganizationRole({
		userId: user.id,
		ownerId: activeOrganization?.organization.ownerId,
		memberRole: currentMember?.role,
	});
	const canViewSettings = canViewOrganizationSettings(currentRole);
	const normalizedQuery = normalizeQuery(query);
	const canSearchVideos = normalizedQuery.length >= MIN_VIDEO_QUERY_LENGTH;

	const quickActions = useMemo<SearchItem[]>(
		() => [
			{
				id: "my-caps",
				title: "我的录制",
				subtitle: "打开你的视频库",
				href: "/dashboard/caps",
				value: "我的录制 视频 录像 视频库",
				icon: FileVideo,
			},
			{
				id: "record-cap",
				title: "录制 Cap",
				subtitle: "开始新的浏览器录制",
				href: "/dashboard/caps/record",
				value: "录制 cap 屏幕 视频 浏览器 录像",
				icon: Radio,
			},
			{
				id: "import-video",
				title: "导入媒体",
				subtitle: "将已有视频或图片导入 Cap",
				href: "/dashboard/import",
				value: "导入 上传 loom 视频 图片 媒体 文件",
				icon: Upload,
			},
			{
				id: "analytics",
				title: "数据分析",
				subtitle: "查看播放量和互动数据",
				href: "/dashboard/analytics",
				value: "数据分析 统计 播放 互动",
				icon: BarChart3,
			},
			{
				id: "browse-spaces",
				title: "浏览空间",
				subtitle: "查找组织共享空间",
				href: "/dashboard/spaces/browse",
				value: "浏览 空间 共享 组织",
				icon: FolderSearch,
			},
		],
		[],
	);

	const settingsItems = useMemo<SearchItem[]>(
		() => [
			{
				id: "account-settings",
				title: "账户设置",
				subtitle: "个人资料、头像和个人信息",
				href: "/dashboard/settings/account",
				value: "账户 设置 个人资料 头像 姓名",
				icon: UserRound,
			},
			{
				id: "notification-settings",
				title: "通知设置",
				subtitle: "评论、播放、回复和回应",
				href: "/dashboard/settings/notifications",
				value: "通知 设置 评论 播放 回复 回应",
				icon: Bell,
			},
			...(canViewSettings
				? [
						{
							id: "organization-settings",
							title: "组织设置",
							subtitle: "组织常规配置",
							href: "/dashboard/settings/organization",
							value: "组织 设置 常规 工作区",
							icon: Settings,
						},
						{
							id: "organization-members",
							title: "组织成员",
							subtitle: "邀请和管理团队成员",
							href: "/dashboard/settings/organization/members",
							value: "组织 成员 邀请 团队 席位",
							icon: UsersRound,
						},
						{
							id: "organization-billing",
							title: "账单",
							subtitle: "订阅、席位和发票",
							href: "/dashboard/settings/organization/billing",
							value: "账单 订阅 席位 发票 组织",
							icon: CreditCard,
						},
						{
							id: "organization-preferences",
							title: "Cap 设置",
							subtitle: "默认摘要、字幕和观看者选项",
							href: "/dashboard/settings/organization/preferences",
							value: "cap 设置 偏好 摘要 字幕 章节 评论 回应 文字稿",
							icon: Sparkles,
						},
					]
				: []),
		],
		[canViewSettings],
	);

	const spaceItems = useMemo(
		() => (spacesData ?? []).map(createSpaceItem),
		[spacesData],
	);

	const actionResults = useMemo(
		() => filterItems(quickActions, normalizedQuery, MAX_LOCAL_RESULTS),
		[quickActions, normalizedQuery],
	);
	const spaceResults = useMemo(
		() => filterItems(spaceItems, normalizedQuery, MAX_SPACE_RESULTS),
		[spaceItems, normalizedQuery],
	);
	const settingsResults = useMemo(
		() => filterItems(settingsItems, normalizedQuery, MAX_LOCAL_RESULTS),
		[settingsItems, normalizedQuery],
	);
	const updateQuery = (value: string) => {
		setQuery(value.slice(0, MAX_SEARCH_QUERY_LENGTH));
	};

	useEffect(() => {
		if (!shortcutEnabled) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				setOpen((value) => !value);
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [shortcutEnabled]);

	useEffect(() => {
		if (!open) return;
		const animationFrame = window.requestAnimationFrame(() =>
			inputRef.current?.focus(),
		);

		return () => window.cancelAnimationFrame(animationFrame);
	}, [open]);

	useEffect(() => {
		if (!open || !canSearchVideos) {
			requestIdRef.current += 1;
			setVideoResults([]);
			setVideoLoading(false);
			return;
		}

		const cachedResults = videoCacheRef.current.get(normalizedQuery);
		if (cachedResults) {
			requestIdRef.current += 1;
			setVideoResults(cachedResults);
			setVideoLoading(false);
			return;
		}

		const requestId = requestIdRef.current + 1;
		requestIdRef.current = requestId;
		setVideoLoading(true);

		const timeout = window.setTimeout(() => {
			searchDashboardVideos(normalizedQuery)
				.then((results) => {
					if (requestIdRef.current !== requestId) return;

					videoCacheRef.current.set(normalizedQuery, results);
					if (videoCacheRef.current.size > MAX_VIDEO_CACHE_SIZE) {
						const firstKey = videoCacheRef.current.keys().next().value;
						if (firstKey) videoCacheRef.current.delete(firstKey);
					}
					setVideoResults(results);
				})
				.catch(() => {
					if (requestIdRef.current !== requestId) return;
					setVideoResults([]);
				})
				.finally(() => {
					if (requestIdRef.current === requestId) setVideoLoading(false);
				});
		}, VIDEO_SEARCH_DEBOUNCE_MS);

		return () => {
			requestIdRef.current += 1;
			window.clearTimeout(timeout);
		};
	}, [canSearchVideos, normalizedQuery, open]);

	const navigateTo = (href: string) => {
		setOpen(false);
		setQuery("");
		router.push(href);
	};

	const hasLocalResults =
		actionResults.length > 0 ||
		spaceResults.length > 0 ||
		settingsResults.length > 0;
	const hasVideoResults = videoResults.length > 0;

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="flex group gap-2.5 items-center px-3.5 w-full max-w-[720px] h-10 rounded-xl border transition-colors duration-200 bg-gray-3 border-gray-4 hover:bg-gray-4 hover:border-gray-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-6"
				aria-label="搜索工作台"
			>
				<Search className="flex-shrink-0 size-4 transition-colors text-gray-10 group-hover:text-gray-11" />
				<span className="flex-1 text-[13px] text-left truncate text-gray-10">
					搜索录制内容、空间和设置……
				</span>
				<kbd className="hidden items-center px-1.5 h-5 text-[11px] font-medium rounded-md border select-none sm:inline-flex text-gray-10 border-gray-4 bg-gray-1">
					{shortcutKey}
				</kbd>
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent
					aria-describedby={undefined}
					className="overflow-hidden p-0 w-[calc(100vw-2rem)] !max-w-2xl shadow-2xl outline-none"
				>
					<DialogTitle className="sr-only">搜索工作台</DialogTitle>
					<Command shouldFilter={false}>
						<CommandInput
							ref={inputRef}
							value={query}
							onValueChange={updateQuery}
							placeholder="搜索录制内容、空间和设置……"
							className="h-[52px] text-[15px] pr-12 outline-none"
						/>
						<CommandList className="overflow-y-auto px-2 pt-1 pb-2 h-[min(60vh,440px)] max-h-[min(60vh,440px)]">
							{canSearchVideos && (
								<>
									<SectionHeader>视频和截图</SectionHeader>
									{videoLoading ? (
										<div className="flex gap-3 items-center px-2.5 py-2 text-[13px] text-gray-10">
											<Loader2 className="flex-shrink-0 animate-spin size-4" />
											正在搜索视频……
										</div>
									) : hasVideoResults ? (
										videoResults.map((video) => (
											<ResultRow
												key={video.id}
												icon={video.isScreenshot ? Image : FileVideo}
												title={video.name}
												subtitle={formatVideoSubtitle(video)}
												value={`${video.name} ${video.ownerName ?? ""}`}
												onSelect={() => navigateTo(`/s/${video.id}`)}
											/>
										))
									) : (
										<p className="px-3 py-6 text-[13px] text-center text-gray-10">
											没有匹配的视频或截图：{" "}
											<span className="font-medium text-gray-12">
												“{query.trim()}”
											</span>
										</p>
									)}
								</>
							)}
							{actionResults.length > 0 && (
								<>
									<SectionHeader>
										{normalizedQuery ? "导航" : "快速前往"}
									</SectionHeader>
									{actionResults.map((item) => (
										<ResultRow
											key={item.id}
											icon={item.icon}
											title={item.title}
											subtitle={item.subtitle}
											value={item.value}
											onSelect={() => navigateTo(item.href)}
										/>
									))}
								</>
							)}
							{spaceResults.length > 0 && (
								<>
									<SectionHeader>空间</SectionHeader>
									{spaceResults.map((item) => (
										<ResultRow
											key={item.id}
											icon={item.icon}
											title={item.title}
											subtitle={item.subtitle}
											badge={item.badge}
											value={item.value}
											onSelect={() => navigateTo(item.href)}
										/>
									))}
								</>
							)}
							{settingsResults.length > 0 && (
								<>
									<SectionHeader>设置</SectionHeader>
									{settingsResults.map((item) => (
										<ResultRow
											key={item.id}
											icon={item.icon}
											title={item.title}
											subtitle={item.subtitle}
											value={item.value}
											onSelect={() => navigateTo(item.href)}
										/>
									))}
								</>
							)}
							{normalizedQuery && !canSearchVideos && !hasLocalResults && (
								<p className="px-3 py-6 text-[13px] text-center text-gray-10">
									继续输入以搜索视频……
								</p>
							)}
						</CommandList>
						<div className="hidden gap-4 justify-end items-center px-3 h-10 border-t sm:flex border-gray-4 bg-gray-2">
							<FooterHint keys={["↑", "↓"]} label="导航" />
							<FooterHint keys={["↵"]} label="打开" />
							<FooterHint keys={["esc"]} label="关闭" />
						</div>
					</Command>
				</DialogContent>
			</Dialog>
		</>
	);
}

function SectionHeader({ children }: { children: ReactNode }) {
	return (
		<div className="px-2.5 pt-3 pb-1 text-[11px] font-medium text-gray-9">
			{children}
		</div>
	);
}

function ResultRow({
	icon: Icon,
	title,
	subtitle,
	badge,
	value,
	onSelect,
}: {
	icon: LucideIcon;
	title: string;
	subtitle?: string;
	badge?: string;
	value: string;
	onSelect: () => void;
}) {
	return (
		<CommandItem
			value={value}
			onSelect={onSelect}
			className="flex gap-3 items-center px-2.5 py-2 rounded-lg transition-colors cursor-pointer text-gray-12 aria-selected:bg-gray-3 data-[selected=true]:bg-gray-3"
		>
			<Icon className="flex-shrink-0 size-[18px] text-gray-10" />
			<div className="flex flex-col flex-1 min-w-0">
				<span className="text-[13px] font-medium truncate text-gray-12">
					{title}
				</span>
				{subtitle && (
					<span className="text-[11px] truncate text-gray-10">{subtitle}</span>
				)}
			</div>
			{badge && (
				<span className="flex-shrink-0 text-[10px] font-medium tracking-wide uppercase text-gray-9">
					{badge}
				</span>
			)}
		</CommandItem>
	);
}

function FooterHint({ keys, label }: { keys: string[]; label: string }) {
	return (
		<span className="flex gap-1.5 items-center text-[11px] text-gray-10">
			<span className="flex gap-1 items-center">
				{keys.map((key) => (
					<kbd
						key={key}
						className="inline-flex justify-center items-center px-1 h-5 text-[10px] font-medium rounded-[5px] border min-w-[20px] border-gray-4 bg-gray-1 text-gray-10"
					>
						{key}
					</kbd>
				))}
			</span>
			{label}
		</span>
	);
}
