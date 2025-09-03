"use client";

import type { userSelectProps } from "@cap/database/auth/session";
import type { videos } from "@cap/database/schema";
import { buildEnv, NODE_ENV } from "@cap/env";
import { Button } from "@cap/ui";
import { userIsPro } from "@cap/utils";
import { faChevronDown, faLock } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { Copy, Globe2 } from "lucide-react";
import moment from "moment";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { editTitle } from "@/actions/videos/edit-title";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { SharingDialog } from "@/app/(org)/dashboard/caps/components/SharingDialog";
import type { Spaces } from "@/app/(org)/dashboard/dashboard-data";
import { UpgradeModal } from "@/components/UpgradeModal";
import { usePublicEnv } from "@/utils/public-env";
import { db } from "@cap/database";
import { useQuery } from "@tanstack/react-query";
import { getUploadProgress } from "./server";

export const ShareHeader = ({
	data,
	user,
	customDomain,
	domainVerified,
	sharedOrganizations = [],
	sharedSpaces = [],
	spacesData = null,
}: {
	data: typeof videos.$inferSelect;
	user: typeof userSelectProps | null;
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
	const { push, refresh } = useRouter();
	const [isEditing, setIsEditing] = useState(false);
	const [title, setTitle] = useState(data.name);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
	const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);

	const contextData = useDashboardContext();
	const contextSharedSpaces = contextData?.sharedSpaces || null;
	const effectiveSharedSpaces = contextSharedSpaces || sharedSpaces;

	const isOwner = user && user.id.toString() === data.ownerId;

	const { webUrl } = usePublicEnv();

	useEffect(() => {
		setTitle(data.name);
	}, [data.name]);

	const handleBlur = async () => {
		setIsEditing(false);

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

	const isUserPro = userIsPro(user);

	const handleSharingUpdated = () => {
		refresh();
	};

	const renderSharedStatus = () => {
		const baseClassName =
			"text-sm text-gray-10 transition-colors duration-200 flex items-center";

		if (isOwner) {
			const hasSpaceSharing =
				sharedOrganizations?.length > 0 || effectiveSharedSpaces?.length > 0;
			const isPublic = data.public;

			if (!hasSpaceSharing && !isPublic) {
				return (
					<p
						className={clsx(baseClassName, "cursor-pointer hover:text-gray-12")}
						onClick={() => setIsSharingDialogOpen(true)}
					>
						Not shared{" "}
						<FontAwesomeIcon className="ml-2 size-2.5" icon={faChevronDown} />
					</p>
				);
			} else {
				return (
					<p
						className={clsx(baseClassName, "cursor-pointer hover:text-gray-12")}
						onClick={() => setIsSharingDialogOpen(true)}
					>
						Shared{" "}
						<FontAwesomeIcon className="ml-1 size-2.5" icon={faChevronDown} />
					</p>
				);
			}
		} else {
			return <p className={baseClassName}>Shared with you</p>;
		}
	};

	return (
		<>
			<SharingDialog
				isOpen={isSharingDialogOpen}
				onClose={() => setIsSharingDialogOpen(false)}
				capId={data.id}
				capName={data.name}
				sharedSpaces={effectiveSharedSpaces || []}
				onSharingUpdated={handleSharingUpdated}
				isPublic={data.public}
				spacesData={spacesData}
			/>
			<div>
				<div className="space-x-0 md:flex md:items-center md:justify-between md:space-x-6">
					<div className="items-center md:flex md:justify-between md:space-x-6">
						<div className="mb-3 md:mb-0">
							<div className="flex items-center space-x-3  lg:min-w-[400px]">
								{isEditing ? (
									<input
										value={title}
										onChange={(e) => setTitle(e.target.value)}
										onBlur={handleBlur}
										onKeyDown={handleKeyDown}
										autoFocus
										className="w-full text-xl font-semibold sm:text-2xl"
									/>
								) : (
									<h1
										className="text-xl sm:text-2xl"
										onClick={() => {
											if (user && user.id.toString() === data.ownerId) {
												setIsEditing(true);
											}
										}}
									>
										{title}
									</h1>
								)}
							</div>
							{user && renderSharedStatus()}
							<p className="mt-1 text-sm text-gray-10">
								{moment(data.createdAt).fromNow()}
							</p>

							<Suspense>
								<UploadProgress videoId={data.id} />
							</Suspense>
						</div>
					</div>
					{user !== null && (
						<div className="flex space-x-2">
							<div>
								<div className="flex gap-2 items-center">
									{data.password && (
										<FontAwesomeIcon
											className="text-amber-600 size-4"
											icon={faLock}
										/>
									)}
									<Button
										variant="white"
										onClick={() => {
											navigator.clipboard.writeText(getVideoLink());
											toast.success("Link copied to clipboard!");
										}}
									>
										{getDisplayLink()}
										<Copy className="ml-2 w-4 h-4" />
									</Button>
								</div>
								{user !== null && !isUserPro && (
									<button
										className="flex items-center mt-1 text-sm text-gray-400 cursor-pointer hover:text-blue-500"
										onClick={() => setUpgradeModalOpen(true)}
									>
										<Globe2 className="mr-1 w-4 h-4" />
										Connect a custom domain
									</button>
								)}
							</div>
							{user !== null && (
								<div className="hidden md:flex">
									<Button
										onClick={() => {
											push("/dashboard");
										}}
									>
										<span className="hidden text-sm text-white lg:block">
											Go to
										</span>{" "}
										Dashboard
									</Button>
								</div>
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

const fiveMinutes = 5 * 60 * 1000;
function UploadProgress({ videoId }: { videoId: string }) {
	const result = useQuery({
		queryKey: ["uploadProgress", videoId],
		queryFn: () => getUploadProgress({ videoId }),
		// if a result is returned then an upload is in progress.
		// refetchInterval: (query) => (!!query.state.data ? 3000 : undefined),

		// TODO: Fix this
		refetchInterval: 3000,
	});
	if (!result.data) return null;

	const hasUploadFailed =
		Date.now() - new Date(result.data.updatedAt).getTime() > fiveMinutes;

	console.log(result.data);

	const isPreparing = result.data.total === 0; // `0/0` for progress is `NaN`
	const progress = isPreparing
		? 0
		: (result.data.total / result.data.uploaded) * 100;

	return (
		<p>
			{isPreparing ? (
				<span>Preparing...</span>
			) : hasUploadFailed ? (
				<span className="text-red-600">Upload failed</span>
			) : (
				<span>{progress.toFixed(0)}% </span>
			)}
		</p>
	);
}
