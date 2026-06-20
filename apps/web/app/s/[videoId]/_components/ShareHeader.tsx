"use client";

import { buildEnv, NODE_ENV } from "@cap/env";
import { Button, Logo } from "@cap/ui";
import type { ViewerSettingKey } from "@cap/web-backend";
import {
	faChartSimple,
	faChevronDown,
	faLock,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock, Copy, Globe2, Pencil, Scissors, X } from "lucide-react";
import moment from "moment";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	hideShareableLinkCapLogo,
	selectShareableLinkBrandingOrganization,
} from "@/actions/organization/shareable-link-icon";
import { editTitle } from "@/actions/videos/edit-title";
import type { VideoStatusResult } from "@/actions/videos/get-status";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { SharingDialog } from "@/app/(org)/dashboard/caps/components/SharingDialog";
import type { Spaces } from "@/app/(org)/dashboard/dashboard-data";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { UpgradeModal } from "@/components/UpgradeModal";
import { usePublicEnv } from "@/utils/public-env";
import { navigateWithTransition } from "@/utils/view-transition";
import type { SharePageBranding, VideoData } from "../types";
import { VideoDownloadMenu } from "./VideoDownloadMenu";

export const ShareHeader = ({
	data,
	customDomain,
	domainVerified,
	sharedOrganizations = [],
	sharedSpaces = [],
	spacesData = null,
	branding,
	canManageSharePageBranding = false,
	canDownload = false,
	hasEdits = false,
}: {
	data: VideoData;
	customDomain?: string | null;
	domainVerified?: boolean;
	sharedOrganizations?: { id: string; name: string }[];
	userOrganizations?: { id: string; name: string }[];
	sharedSpaces?: {
		id: string;
		name: string;
		iconUrl?: string;
		organizationId: string;
		settings?: Partial<Record<ViewerSettingKey, boolean>> | null;
		hasPassword?: boolean;
	}[];
	userSpaces?: {
		id: string;
		name: string;
		iconUrl?: string;
		organizationId: string;
		settings?: Partial<Record<ViewerSettingKey, boolean>> | null;
		hasPassword?: boolean;
	}[];
	spacesData?: Spaces[] | null;
	branding?: SharePageBranding | null;
	canManageSharePageBranding?: boolean;
	canDownload?: boolean;
	hasEdits?: boolean;
}) => {
	const user = useCurrentUser();
	const { push, refresh } = useRouter();
	const queryClient = useQueryClient();
	const { data: videoStatus } = useQuery<VideoStatusResult>({
		queryKey: ["videoStatus", data.id],
		queryFn: skipToken,
	});
	const [isEditing, setIsEditing] = useState(false);
	const [displayTitle, setDisplayTitle] = useState(data.name);
	const [editValue, setEditValue] = useState(data.name);
	const [isTitleRevealing, setIsTitleRevealing] = useState(false);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
	const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);
	const [linkCopied, setLinkCopied] = useState(false);
	const [showCopyOptions, setShowCopyOptions] = useState(false);
	const [capturedTime, setCapturedTime] = useState(0);
	const [isHidingBranding, setIsHidingBranding] = useState(false);
	const [isOpeningBrandingSettings, setIsOpeningBrandingSettings] =
		useState(false);
	const copyOptionsRef = useRef<HTMLDivElement>(null);
	const suppressTitleRevealRef = useRef(false);
	const titleSwapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const titleRevealEndTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	useEffect(() => {
		if (!showCopyOptions) return;
		const handler = (e: MouseEvent) => {
			if (
				copyOptionsRef.current &&
				!copyOptionsRef.current.contains(e.target as Node)
			) {
				setShowCopyOptions(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [showCopyOptions]);

	const contextData = useDashboardContext();
	const contextSharedSpaces = contextData?.sharedSpaces || null;
	const effectiveSharedSpaces = contextSharedSpaces || sharedSpaces;

	const isOwner = user && user.id === data.owner.id;

	const { webUrl } = usePublicEnv();

	const resolvedTitle = videoStatus?.name ?? data.name;

	useEffect(() => {
		if (isEditing) return;
		if (resolvedTitle === displayTitle) return;

		if (suppressTitleRevealRef.current) {
			suppressTitleRevealRef.current = false;
			setDisplayTitle(resolvedTitle);
			return;
		}

		const prefersReducedMotion =
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;

		if (prefersReducedMotion) {
			setDisplayTitle(resolvedTitle);
			return;
		}

		setIsTitleRevealing(true);
		if (titleSwapTimeoutRef.current) clearTimeout(titleSwapTimeoutRef.current);
		if (titleRevealEndTimeoutRef.current)
			clearTimeout(titleRevealEndTimeoutRef.current);

		titleSwapTimeoutRef.current = setTimeout(() => {
			setDisplayTitle(resolvedTitle);
		}, 160);
		titleRevealEndTimeoutRef.current = setTimeout(() => {
			setIsTitleRevealing(false);
		}, 1000);
	}, [resolvedTitle, displayTitle, isEditing]);

	useEffect(
		() => () => {
			if (titleSwapTimeoutRef.current)
				clearTimeout(titleSwapTimeoutRef.current);
			if (titleRevealEndTimeoutRef.current)
				clearTimeout(titleRevealEndTimeoutRef.current);
		},
		[],
	);

	const startEditing = () => {
		setEditValue(displayTitle);
		setIsEditing(true);
	};

	const handleBlur = async () => {
		setIsEditing(false);
		const next = editValue.trim();
		if (next === "" || next === displayTitle) return;
		try {
			await editTitle(data.id, next);
			toast.success("Video title updated");
			suppressTitleRevealRef.current = true;
			queryClient.setQueryData<VideoStatusResult>(
				["videoStatus", data.id],
				(old) => (old ? { ...old, name: next } : old),
			);
			refresh();
		} catch (error) {
			if (error instanceof Error) {
				toast.error(error.message);
			} else {
				toast.error("Failed to update title - please try again.");
			}
		}
	};

	const handleKeyDown = async (event: { key: string }) => {
		if (event.key === "Enter") {
			handleBlur();
		}
	};

	const getVideoLink = () => {
		if (NODE_ENV === "development" && customDomain && domainVerified) {
			return `https://${customDomain}/s/${data.id}`;
		} else if (NODE_ENV === "development" && !customDomain && !domainVerified) {
			return `${webUrl}/s/${data.id}`;
		} else if (buildEnv.NEXT_PUBLIC_IS_CAP && customDomain && domainVerified) {
			return `https://${customDomain}/s/${data.id}`;
		} else if (
			buildEnv.NEXT_PUBLIC_IS_CAP &&
			!customDomain &&
			!domainVerified
		) {
			return `https://cap.link/${data.id}`;
		} else {
			return `${webUrl}/s/${data.id}`;
		}
	};

	const getDisplayLink = () => {
		if (NODE_ENV === "development" && customDomain && domainVerified) {
			return `${customDomain}/s/${data.id}`;
		} else if (NODE_ENV === "development" && !customDomain && !domainVerified) {
			return `${webUrl}/s/${data.id}`;
		} else if (buildEnv.NEXT_PUBLIC_IS_CAP && customDomain && domainVerified) {
			return `${customDomain}/s/${data.id}`;
		} else if (
			buildEnv.NEXT_PUBLIC_IS_CAP &&
			!customDomain &&
			!domainVerified
		) {
			return `cap.link/${data.id}`;
		} else {
			return `${webUrl}/s/${data.id}`;
		}
	};

	const formatTimestamp = (seconds: number): string => {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = seconds % 60;
		if (h > 0)
			return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
		return `${m}:${String(s).padStart(2, "0")}`;
	};

	const handleCopyClick = () => {
		const video = document.querySelector("video");
		const currentTime = video ? Math.floor(video.currentTime) : 0;

		if (currentTime > 3) {
			setCapturedTime(currentTime);
			setShowCopyOptions(true);
		} else {
			navigator.clipboard.writeText(getVideoLink());
			setLinkCopied(true);
			setTimeout(() => setLinkCopied(false), 2000);
		}
	};

	const handleCopyLink = (withTimestamp: boolean) => {
		const link = withTimestamp
			? `${getVideoLink()}?t=${capturedTime}`
			: getVideoLink();
		navigator.clipboard.writeText(link);
		setShowCopyOptions(false);
		setLinkCopied(true);
		setTimeout(() => setLinkCopied(false), 2000);
	};

	const handleSharingUpdated = () => {
		refresh();
	};

	const renderSharedStatus = () => {
		if (isOwner) {
			const hasSpaceSharing =
				sharedOrganizations?.length > 0 || effectiveSharedSpaces?.length > 0;
			const isPublic = data.public;

			if (!hasSpaceSharing && !isPublic) {
				return (
					<Button
						className="px-3 w-fit"
						size="xs"
						variant="outline"
						onClick={() => setIsSharingDialogOpen(true)}
					>
						Not shared{" "}
						<FontAwesomeIcon className="ml-2 size-2.5" icon={faChevronDown} />
					</Button>
				);
			} else {
				return (
					<Button
						className="px-3 w-fit"
						size="xs"
						variant="outline"
						onClick={() => setIsSharingDialogOpen(true)}
					>
						Shared{" "}
						<FontAwesomeIcon className="ml-1 size-2.5" icon={faChevronDown} />
					</Button>
				);
			}
		} else {
			return (
				<Button
					className="px-3 pointer-events-none w-fit"
					size="xs"
					variant="outline"
				>
					Shared with you
				</Button>
			);
		}
	};

	const userIsOwnerAndNotPro = user?.id === data.owner.id && !data.owner.isPro;
	const canEditVideo =
		isOwner &&
		!data.isScreenshot &&
		!data.hasActiveUpload &&
		(data.source.type === "desktopMP4" || data.source.type === "webMP4");
	const handleEditVideo = () => {
		if (userIsOwnerAndNotPro) {
			setUpgradeModalOpen(true);
			return;
		}

		navigateWithTransition("edit-enter", () => push(`/s/${data.id}/edit`));
	};

	const handleHideBranding = async () => {
		if (!user?.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		setIsHidingBranding(true);

		try {
			await hideShareableLinkCapLogo(data.orgId);
			toast.success("Cap logo hidden");
			refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to hide Cap logo",
			);
		} finally {
			setIsHidingBranding(false);
		}
	};

	const handleEditBranding = async () => {
		if (!user?.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		setIsOpeningBrandingSettings(true);

		try {
			await selectShareableLinkBrandingOrganization(data.orgId);
			push("/dashboard/settings/organization");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to open organization settings",
			);
			setIsOpeningBrandingSettings(false);
		}
	};

	const renderBranding = () => {
		if (!branding) return null;

		return (
			<div className="group relative inline-flex shrink-0 items-center">
				{canManageSharePageBranding && (
					<div className="pointer-events-none absolute left-0 top-full z-10 pt-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
						<div className="flex items-center gap-1 rounded-full border border-gray-5 bg-white p-1 shadow-sm">
							<Button
								variant="gray"
								size="xs"
								aria-label="Edit shareable link branding"
								className="h-7 gap-1 whitespace-nowrap rounded-full px-2 text-[11px]"
								disabled={isOpeningBrandingSettings}
								onClick={handleEditBranding}
							>
								<Pencil className="size-3.5 text-gray-12" />
								Change logo
							</Button>
							{branding.type === "cap" && (
								<Button
									variant="gray"
									size="xs"
									aria-label="Hide Cap logo"
									className="h-7 gap-1 whitespace-nowrap rounded-full px-2 text-[11px]"
									disabled={isHidingBranding}
									onClick={handleHideBranding}
								>
									<X className="size-3.5 text-gray-12" />
									Remove
								</Button>
							)}
						</div>
					</div>
				)}
				{branding.type === "custom" ? (
					<div className="inline-flex h-11 max-w-56 items-center justify-center">
						<Image
							src={branding.imageUrl}
							alt={`${branding.name} logo`}
							width={176}
							height={32}
							unoptimized
							className="max-h-8 w-auto max-w-44 object-contain"
						/>
					</div>
				) : (
					<a
						target="_blank"
						rel="noreferrer"
						href={`/?ref=video_${data.id}`}
						className="inline-flex h-11 items-center"
					>
						<Logo className="h-7 w-auto" />
					</a>
				)}
			</div>
		);
	};

	return (
		<>
			{userIsOwnerAndNotPro && (
				<div className="flex sticky flex-col sm:flex-row inset-x-0 top-0 z-10 gap-4 justify-center items-center px-3 py-2 mx-auto w-[calc(100%-20px)] max-w-fit rounded-b-xl border bg-gray-4 border-gray-6">
					<p className="text-center text-gray-12">
						Shareable links are limited to 5 mins on the free plan.
					</p>
					<Button
						type="button"
						onClick={() => setUpgradeModalOpen(true)}
						size="sm"
						variant="blue"
					>
						Upgrade To Cap Pro
					</Button>
				</div>
			)}
			<SharingDialog
				isOpen={isSharingDialogOpen}
				onClose={() => setIsSharingDialogOpen(false)}
				capId={data.id}
				capName={data.name}
				sharedSpaces={effectiveSharedSpaces || []}
				onSharingUpdated={handleSharingUpdated}
				isPublic={data.public}
				spacesData={spacesData}
				hasPassword={!!data.hasPassword}
				inheritedPasswordSources={data.inheritedPasswordSources}
				onPasswordUpdated={() => refresh()}
				user={user}
				onUpgradeRequest={setUpgradeModalOpen}
			/>
			<div className="mt-8">
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
						<div className="flex min-w-0 items-center gap-3 lg:min-w-[400px]">
							{renderBranding()}
							{branding && <div className="h-7 w-px shrink-0 bg-gray-6" />}
							<div className="min-w-0 flex-1">
								{isEditing ? (
									<input
										value={editValue}
										onChange={(e) => setEditValue(e.target.value)}
										onBlur={handleBlur}
										onKeyDown={handleKeyDown}
										className="w-full min-w-0 text-xl sm:text-2xl"
									/>
								) : (
									<div className="relative inline-flex min-w-0 max-w-full align-middle">
										<h1
											role={isOwner ? "button" : undefined}
											tabIndex={isOwner ? 0 : undefined}
											className="truncate text-xl sm:text-2xl"
											onClick={() => {
												if (isOwner) {
													startEditing();
												}
											}}
											onKeyDown={(event) => {
												if (
													isOwner &&
													(event.key === "Enter" || event.key === " ")
												) {
													event.preventDefault();
													startEditing();
												}
											}}
										>
											{displayTitle}
										</h1>
										{isTitleRevealing && (
											<span aria-hidden className="ai-title-skeleton" />
										)}
									</div>
								)}
							</div>
						</div>
						{user !== null && (
							<div>
								<div className="flex gap-2 items-center">
									{(data.hasPassword || data.hasInheritedPassword) && (
										<FontAwesomeIcon
											className="text-amber-600 size-4"
											icon={faLock}
										/>
									)}
									<div className="relative" ref={copyOptionsRef}>
										<Button
											variant="white"
											className="max-w-full px-3"
											onClick={handleCopyClick}
										>
											<span className="max-w-[70vw] truncate sm:max-w-96">
												{getDisplayLink()}
											</span>
											{linkCopied ? (
												<Check className="ml-2 w-4 h-4 svgpathanimation" />
											) : (
												<Copy className="ml-2 w-4 h-4" />
											)}
										</Button>
										{showCopyOptions && (
											<div className="absolute right-0 top-full z-50 mt-1 min-w-full w-max overflow-hidden rounded-lg border border-gray-6 bg-white shadow-lg">
												<button
													type="button"
													className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:bg-gray-3"
													onClick={() => handleCopyLink(false)}
												>
													<Copy className="w-3.5 h-3.5 shrink-0" />
													Copy link
												</button>
												<button
													type="button"
													className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:bg-gray-3"
													onClick={() => handleCopyLink(true)}
												>
													<Clock className="w-3.5 h-3.5 shrink-0" />
													Copy link at {formatTimestamp(capturedTime)}
												</button>
											</div>
										)}
									</div>
									{canDownload && (
										<VideoDownloadMenu
											videoId={data.id}
											hasEdits={hasEdits}
											triggerClassName="size-11 rounded-full border border-gray-5 bg-gray-3 text-gray-12 transition hover:border-gray-6 hover:bg-gray-6"
										/>
									)}
								</div>
								{userIsOwnerAndNotPro && (
									<button
										type="button"
										className="flex items-center mt-2 mb-3 text-sm text-gray-400 duration-200 cursor-pointer hover:text-blue-500"
										onClick={() => setUpgradeModalOpen(true)}
									>
										<Globe2 className="mr-1 w-4 h-4" />
										Connect a custom domain
									</button>
								)}
							</div>
						)}
					</div>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<div className="flex flex-wrap gap-x-7 gap-y-2 items-center">
							<div className="flex gap-2 items-center">
								{data.name && (
									<SignedImageUrl
										name={data.name}
										image={data.owner.image}
										className="size-8"
										letterClass="text-base"
									/>
								)}
								<div className="flex flex-col text-left">
									<p className="text-sm text-gray-12">{data.owner.name}</p>
									<p className="text-xs text-gray-10">
										{moment(data.createdAt).fromNow()}
									</p>
								</div>
							</div>
							{user && renderSharedStatus()}
						</div>
						{user !== null && (
							<div className="flex flex-wrap items-center gap-2 sm:justify-end">
								{isOwner && (
									<>
										{canEditVideo && (
											<Button
												variant="gray"
												size="xs"
												className="h-8 gap-1.5 rounded-full px-2.5 text-xs"
												onClick={handleEditVideo}
											>
												<Scissors className="size-3.5 text-gray-12" />
												Edit video
											</Button>
										)}
										<Button
											variant="gray"
											size="xs"
											className="h-8 gap-1.5 rounded-full px-2.5 text-xs"
											onClick={() => {
												push(`/dashboard/analytics?capId=${data.id}`);
											}}
										>
											<FontAwesomeIcon
												className="size-3.5 text-gray-12"
												icon={faChartSimple}
											/>
											View analytics
										</Button>
									</>
								)}
								<Button
									size="xs"
									className="h-8 rounded-full px-2.5 text-xs"
									onClick={() => {
										push("/dashboard/caps?page=1");
									}}
								>
									Go to dashboard
								</Button>
							</div>
						)}
					</div>
				</div>
			</div>
			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
		</>
	);
};
