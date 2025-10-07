"use client";

import type { userSelectProps } from "@cap/database/auth/session";
import type { videos } from "@cap/database/schema";
import { buildEnv, NODE_ENV } from "@cap/env";
import { Avatar, Button } from "@cap/ui";
import { userIsPro } from "@cap/utils";
import { faChevronDown, faLock } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { Check, Copy, Globe2 } from "lucide-react";
import moment from "moment";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { editTitle } from "@/actions/videos/edit-title";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { SharingDialog } from "@/app/(org)/dashboard/caps/components/SharingDialog";
import type { Spaces } from "@/app/(org)/dashboard/dashboard-data";
import { UpgradeModal } from "@/components/UpgradeModal";
import { usePublicEnv } from "@/utils/public-env";

export const ShareHeader = ({
	data,
	user,
	customDomain,
	domainVerified,
	sharedOrganizations = [],
	sharedSpaces = [],
	spacesData = null,
}: {
	data: typeof videos.$inferSelect & {
		organizationIconUrl?: string | null;
		organizationName?: string | null;
	};
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
	const [linkCopied, setLinkCopied] = useState(false);

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
		if (title === data.name) {
			return;
		}
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
	const showUpgradeBanner =
		user && data.ownerId === user.id && !userIsPro(user);

	const handleSharingUpdated = () => {
		refresh();
	};

	const renderSharedStatus = () => {
		const baseClassName =
			"text-sm text-gray-10 justify-center lg:justify-start transition-colors duration-200 flex items-center";

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
			{showUpgradeBanner && (
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
			/>
			<div className="mt-8">
				<div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-0">
					<div className="justify-center items-center mb-3 w-full md:flex lg:justify-between md:space-x-6 md:mb-0">
						<div className="flex flex-col gap-5 md:gap-10 lg:flex-row">
							<div className="flex flex-col flex-1 justify-center items-center w-full lg:justify-evenly">
								{data.organizationIconUrl ? (
									<Image
										className="rounded-full size-9"
										src={data.organizationIconUrl}
										alt="Organization icon"
										width={36}
										height={36}
									/>
								) : (
									<Avatar
										className="rounded-full size-9"
										name={data.organizationName ?? "Organization"}
										letterClass="text-sm"
									/>
								)}
								<p className="text-sm font-medium text-gray-12">
									{data.organizationName}
								</p>
							</div>
							<div className="flex flex-col justify-center text-center lg:text-left lg:justify-start">
								{isEditing ? (
									<input
										value={title}
										onChange={(e) => setTitle(e.target.value)}
										onBlur={handleBlur}
										onKeyDown={handleKeyDown}
										autoFocus
										className="w-full text-xl sm:text-2xl"
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
								{user && renderSharedStatus()}
								<p className="mt-1 text-sm text-gray-10">
									{moment(data.createdAt).fromNow()}
								</p>
							</div>
						</div>
					</div>
					{user !== null && (
						<div className="flex justify-center space-x-2 w-full lg:justify-end">
							<div className="w-fit">
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
											setLinkCopied(true);
											setTimeout(() => {
												setLinkCopied(false);
											}, 2000);
										}}
									>
										{getDisplayLink()}
										{linkCopied ? (
											<Check className="ml-2 w-4 h-4 svgpathanimation" />
										) : (
											<Copy className="ml-2 w-4 h-4" />
										)}
									</Button>
								</div>
								{user !== null && !isUserPro && (
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
							{user !== null && (
								<div className="hidden md:flex">
									<Button
										onClick={() => {
											push("/dashboard/caps?page=1");
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
