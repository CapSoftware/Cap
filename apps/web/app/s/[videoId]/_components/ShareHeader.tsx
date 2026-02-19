"use client";

import { buildEnv, NODE_ENV } from "@cap/env";
import { Button } from "@cap/ui";
import {
	faChartSimple,
	faChevronDown,
	faLock,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Check, Copy, Globe2, Pencil } from "lucide-react";
import moment from "moment";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { editTitle } from "@/actions/videos/edit-title";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { SharingDialog } from "@/app/(org)/dashboard/caps/components/SharingDialog";
import type { Spaces } from "@/app/(org)/dashboard/dashboard-data";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { Tooltip } from "@/components/Tooltip";
import { UpgradeModal } from "@/components/UpgradeModal";
import { usePublicEnv } from "@/utils/public-env";
import type { VideoData } from "../types";

export const ShareHeader = ({
	data,
	customDomain,
	domainVerified,
	sharedOrganizations = [],
	sharedSpaces = [],
	spacesData = null,
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
	}[];
	userSpaces?: {
		id: string;
		name: string;
		iconUrl?: string;
		organizationId: string;
	}[];
	spacesData?: Spaces[] | null;
}) => {
	const user = useCurrentUser();
	const { push, refresh } = useRouter();
	const [isEditing, setIsEditing] = useState(false);
	const [title, setTitle] = useState(data.name);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
	const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);
	const [linkCopied, setLinkCopied] = useState(false);

	const contextData = useDashboardContext();
	const contextSharedSpaces = contextData?.sharedSpaces || null;
	const effectiveSharedSpaces = contextSharedSpaces || sharedSpaces;

	const isOwner = user && user.id === data.owner.id;

	const { webUrl } = usePublicEnv();

	useEffect(() => {
		setTitle(data.name);
	}, [data.name]);

	const maxTitleLength = 56;
	const isTitleTruncated = title.length > maxTitleLength;
	const displayTitle = isTitleTruncated
		? `${title.slice(0, maxTitleLength - 3)}...`
		: title;

	const handleCopyTitle = async () => {
		try {
			await navigator.clipboard.writeText(title);
			toast.success("Copied to clipboard");
		} catch {
			toast.error("Failed to copy to clipboard");
		}
	};

	const handleBlur = async () => {
		setIsEditing(false);
		const next = title.trim();
		if (next === "" || next === data.name) return;
		try {
			await editTitle(data.id, title);
			toast.success("Video title updated");
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
				onPasswordUpdated={() => refresh()}
				user={user}
				onUpgradeRequest={setUpgradeModalOpen}
			/>
			<div className="mt-8">
				<div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-0">
					<div className="items-center md:flex md:justify-between md:space-x-6">
						<div className="space-y-3">
							<div className="flex flex-col lg:min-w-[400px]">
								{isEditing ? (
									<input
										value={title}
										onChange={(e) => setTitle(e.target.value)}
										onBlur={handleBlur}
										onKeyDown={handleKeyDown}
										className="w-full text-xl sm:text-2xl"
									/>
								) : isOwner ? (
									<h1 className="text-xl sm:text-2xl">
										<Tooltip
											content={title}
											className="bg-gray-12 text-gray-1 border-gray-11 shadow-lg"
											delayDuration={100}
											disable={!isTitleTruncated}
										>
											<button
												type="button"
												onClick={() => setIsEditing(true)}
												className="w-full bg-transparent border-0 m-0 p-0 text-left text-xl sm:text-2xl text-gray-12 cursor-text focus:outline-none"
											>
												{displayTitle}
											</button>
										</Tooltip>
									</h1>
								) : (
									<h1 className="text-xl sm:text-2xl">
										<Tooltip
											content={
												<button
													type="button"
													onClick={handleCopyTitle}
													className="block -mx-3 -my-2 px-3 py-2 w-full bg-transparent border-0 text-left text-gray-1 cursor-pointer focus:outline-none"
												>
													{title}
												</button>
											}
											className="bg-gray-12 text-gray-1 border-gray-11 shadow-lg"
											delayDuration={100}
											disable={!isTitleTruncated}
										>
											<button
												type="button"
												onClick={handleCopyTitle}
												className="w-full bg-transparent border-0 m-0 p-0 text-left text-xl sm:text-2xl text-gray-12 cursor-pointer focus:outline-none"
											>
												{displayTitle}
											</button>
										</Tooltip>
									</h1>
								)}
							</div>
							<div className="flex gap-7 items-center">
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
								{user && (
									<div className="flex gap-2 items-center">
										{renderSharedStatus()}
										{isOwner && (
											<Tooltip
												content="View analytics"
												className="bg-gray-12 text-gray-1 border-gray-11 shadow-lg"
												delayDuration={100}
											>
												<Button
													variant="gray"
													size="xs"
													className="px-3 w-fit"
													onClick={() => {
														push(`/dashboard/analytics?capId=${data.id}`);
													}}
												>
													<FontAwesomeIcon
														className="size-4 text-gray-12"
														icon={faChartSimple}
													/>
												</Button>
											</Tooltip>
										)}
									</div>
								)}
							</div>
						</div>
					</div>
					{user !== null && (
						<div className="flex flex-col items-start gap-1">
							<div className="flex flex-wrap gap-2 items-center">
								<div className="flex gap-2 items-center">
									{data.hasPassword && (
										<FontAwesomeIcon
											className="text-amber-600 size-4"
											icon={faLock}
										/>
									)}
									<Button
										variant="white"
										onClick={() => {
											navigator.clipboard.writeText(getVideoLink());
											setLinkCopied(true);
											setTimeout(() => {
												setLinkCopied(false);
											}, 2000);
										}}
									>
										<span className="truncate max-w-[150px] sm:max-w-none">
											{getDisplayLink()}
										</span>
										{linkCopied ? (
											<Check className="ml-2 w-4 h-4 shrink-0 svgpathanimation" />
										) : (
											<Copy className="ml-2 w-4 h-4 shrink-0" />
										)}
									</Button>
								</div>
								{isOwner && (
									<Button
										variant="white"
										onClick={() => {
											push(`/editor/${data.id}`);
										}}
									>
										Edit Video
										<Pencil className="ml-1 w-4 h-4 shrink-0" />
									</Button>
								)}
								<Button
									onClick={() => {
										push("/dashboard/caps?page=1");
									}}
								>
									Dashboard
								</Button>
							</div>
							{userIsOwnerAndNotPro && (
								<button
									type="button"
									className="flex items-center text-sm text-gray-400 duration-200 cursor-pointer hover:text-blue-500"
									onClick={() => setUpgradeModalOpen(true)}
								>
									<Globe2 className="mr-1 w-4 h-4" />
									Connect a custom domain
								</button>
							)}
						</div>
					)}
				</div>
			</div>
			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
		</>
	);
};
