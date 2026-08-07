"use client";

import { buildEnv, NODE_ENV } from "@cap/env";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Logo,
} from "@cap/ui";
import type { ViewerSettingKey } from "@cap/web-backend";
import {
	faChartSimple,
	faChevronDown,
	faEllipsis,
	faGear,
	faLock,
	faShare,
	faTrash,
	faUnlock,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
	Check,
	Clock,
	Copy,
	Download,
	Globe2,
	LayoutDashboard,
	Lock,
	Pencil,
	Scissors,
	Users,
	X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Suspense, use, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	hideShareableLinkCapLogo,
	selectShareableLinkBrandingOrganization,
} from "@/actions/organization/shareable-link-icon";
import { editTitle } from "@/actions/videos/edit-title";
import type { VideoStatusResult } from "@/actions/videos/get-status";
import { useDashboardContext } from "@/app/(org)/dashboard/DashboardContext";
import type { Spaces } from "@/app/(org)/dashboard/dashboard-data";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { Tooltip } from "@/components/Tooltip";
import {
	copyRichVideoLink,
	videoPreviewImageUrl,
} from "@/lib/video-share-clipboard";
import { usePublicEnv } from "@/utils/public-env";
import { navigateWithTransition } from "@/utils/view-transition";
import type { SharePageBranding, VideoData } from "../types";
import { describeShareAudience } from "./share-audience";
import { useVideoDownload } from "./use-video-download";
import { fromNow } from "./utils/from-now";
import { VideoDownloadMenu } from "./VideoDownloadMenu";

/**
 * Off the header's critical path: brand SVGs and the embed snippet are dead
 * weight for the (many) viewers who never open the share sheet. Hovering the
 * button warms the chunk, so the click still feels instant.
 */
const importShareLinkDialog = () => import("./ShareLinkDialog");
const ShareLinkDialog = dynamic(importShareLinkDialog, { ssr: false });

/**
 * Same treatment for the rest of the header's interaction-only surfaces. The
 * owner dialogs and the upgrade modal (which carries the Rive animation
 * runtime) are mounted behind latches; the two RPC-backed pieces additionally
 * keep the Effect runtime chunk out of every plain page view.
 */
const importUpgradeModal = () =>
	import("@/components/UpgradeModal").then((m) => m.UpgradeModal);
const UpgradeModal = dynamic(importUpgradeModal, { ssr: false });
const SharingDialog = dynamic(
	() =>
		import("@/app/(org)/dashboard/caps/components/SharingDialog").then(
			(m) => m.SharingDialog,
		),
	{ ssr: false },
);
const SettingsDialog = dynamic(
	() =>
		import("@/app/(org)/dashboard/caps/components/SettingsDialog").then(
			(m) => m.SettingsDialog,
		),
	{ ssr: false },
);
const PasswordDialog = dynamic(
	() =>
		import("@/app/(org)/dashboard/caps/components/PasswordDialog").then(
			(m) => m.PasswordDialog,
		),
	{ ssr: false },
);
const DeleteCapDialog = dynamic(() => import("./DeleteCapDialog"), {
	ssr: false,
});
const DuplicateCapMenuItem = dynamic(() => import("./DuplicateCapMenuItem"), {
	ssr: false,
});

/**
 * Where a signed-out viewer can go next. Three, not the full site nav: this
 * shares the row with the video's title and has to stay out of its way.
 */
const SIGNED_OUT_LINKS = [
	{ label: "Download", href: "/download" },
	{ label: "Blog", href: "/blog" },
	{ label: "Pricing", href: "/pricing" },
];

/**
 * Shared by the heading and the rename field. Renaming is meant to read as a
 * caret appearing in the title, so both have to render the same glyphs at the
 * same size on the same baseline — the line heights are spelled out because a
 * bare `h1` and a bare `input` each pick up a different one from the base layer.
 */
const TITLE_TEXT_CLASS =
	"text-xl leading-7 font-normal sm:text-2xl sm:leading-8";

const TITLE_PLACEHOLDER = "Cap title";

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
	views,
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
	/**
	 * Shown to every viewer, not just the owner. The sidebar's analytics row is
	 * members-only, which left a shared link with no sense of reach at all.
	 * Resolves late and never blocks the header (see `ViewCount`).
	 */
	views?: MaybePromise<number | null>;
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
	const [upgradeModalOpen, setUpgradeModalOpenRaw] = useState(false);
	const [isSharingDialogOpen, setIsSharingDialogOpenRaw] = useState(false);
	const [isShareLinkDialogOpen, setIsShareLinkDialogOpen] = useState(false);
	// Latched so each lazy chunk is only ever pulled in once, and so a dialog
	// keeps its exit animation instead of being torn out of the tree on close.
	const [shareLinkDialogMounted, setShareLinkDialogMounted] = useState(false);
	const [upgradeModalMounted, setUpgradeModalMounted] = useState(false);
	const [sharingDialogMounted, setSharingDialogMounted] = useState(false);
	const [settingsDialogMounted, setSettingsDialogMounted] = useState(false);
	const [passwordDialogMounted, setPasswordDialogMounted] = useState(false);
	const [deleteDialogMounted, setDeleteDialogMounted] = useState(false);
	const [isSettingsDialogOpen, setIsSettingsDialogOpenRaw] = useState(false);
	const [isPasswordDialogOpen, setIsPasswordDialogOpenRaw] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpenRaw] = useState(false);
	const setUpgradeModalOpen = (open: boolean) => {
		if (open) setUpgradeModalMounted(true);
		setUpgradeModalOpenRaw(open);
	};
	const setIsSharingDialogOpen = (open: boolean) => {
		if (open) setSharingDialogMounted(true);
		setIsSharingDialogOpenRaw(open);
	};
	const setIsSettingsDialogOpen = (open: boolean) => {
		if (open) setSettingsDialogMounted(true);
		setIsSettingsDialogOpenRaw(open);
	};
	const setIsPasswordDialogOpen = (open: boolean) => {
		if (open) setPasswordDialogMounted(true);
		setIsPasswordDialogOpenRaw(open);
	};
	const setIsDeleteDialogOpen = (open: boolean) => {
		if (open) setDeleteDialogMounted(true);
		setIsDeleteDialogOpenRaw(open);
	};
	const [passwordProtected, setPasswordProtected] = useState(
		Boolean(data.hasPassword),
	);
	const [linkCopied, setLinkCopied] = useState(false);
	const [showCopyOptions, setShowCopyOptions] = useState(false);
	const [capturedTime, setCapturedTime] = useState(0);
	const [isHidingBranding, setIsHidingBranding] = useState(false);
	const [isOpeningBrandingSettings, setIsOpeningBrandingSettings] =
		useState(false);
	const copyOptionsRef = useRef<HTMLDivElement>(null);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const titleButtonRef = useRef<HTMLButtonElement>(null);
	/**
	 * The name a rename put on screen before the server had it. Held until the
	 * server agrees, so the effect below can't shimmer the stale title back in
	 * over the one the owner just typed.
	 */
	const pendingTitleRef = useRef<string | null>(null);
	const cancelTitleEditRef = useRef(false);
	const restoreTitleFocusRef = useRef(false);
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
	const { download, isDownloading } = useVideoDownload(data.id);

	const resolvedTitle = videoStatus?.name ?? data.name;
	const effectivePasswordProtected =
		passwordProtected || Boolean(data.hasInheritedPassword);

	useEffect(() => {
		setPasswordProtected(Boolean(data.hasPassword));
	}, [data.hasPassword]);

	useEffect(() => {
		if (isEditing) return;

		if (pendingTitleRef.current !== null) {
			// Hold the owner's own edit until the server echoes it back; anything
			// else arriving in the meantime is a value we already know is stale.
			if (resolvedTitle !== pendingTitleRef.current) return;
			pendingTitleRef.current = null;
		}

		if (resolvedTitle === displayTitle) return;

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

	/**
	 * Opening the field focuses and selects it — clicking a title is a request to
	 * rename it, not to go hunting for the caret. Closing it hands focus back to
	 * the title, but only when the keyboard closed it: a click elsewhere has
	 * already chosen where focus should land.
	 */
	useEffect(() => {
		if (isEditing) {
			titleInputRef.current?.focus();
			titleInputRef.current?.select();
			return;
		}
		if (!restoreTitleFocusRef.current) return;
		restoreTitleFocusRef.current = false;
		titleButtonRef.current?.focus();
	}, [isEditing]);

	const setTitleEverywhere = (name: string) => {
		setDisplayTitle(name);
		queryClient.setQueryData<VideoStatusResult>(
			["videoStatus", data.id],
			(old) => (old ? { ...old, name } : old),
		);
	};

	const commitTitle = async () => {
		setIsEditing(false);
		const next = editValue.trim();
		if (next === "" || next === displayTitle) return;

		// The new name lands on the heading immediately and the write catches up
		// behind it. A rename that waits on a round-trip before showing anything
		// (and then announces itself with a toast) feels like a form submission,
		// not like editing the title in place.
		const previous = displayTitle;
		pendingTitleRef.current = next;
		setTitleEverywhere(next);

		try {
			await editTitle(data.id, next);
			refresh();
		} catch (error) {
			pendingTitleRef.current = null;
			setTitleEverywhere(previous);
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update title - please try again.",
			);
		}
	};

	// Blur is the only path that writes, so Enter and the click-away it causes
	// can't both fire the same rename.
	const handleTitleBlur = () => {
		if (cancelTitleEditRef.current) {
			cancelTitleEditRef.current = false;
			setEditValue(displayTitle);
			setIsEditing(false);
			return;
		}
		void commitTitle();
	};

	const handleTitleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter" || event.key === "Escape") {
			event.preventDefault();
			cancelTitleEditRef.current = event.key === "Escape";
			restoreTitleFocusRef.current = true;
			titleInputRef.current?.blur();
		}
	};

	const getVideoLink = () => {
		if (
			(NODE_ENV === "development" || buildEnv.NEXT_PUBLIC_IS_CAP) &&
			customDomain &&
			domainVerified
		) {
			return `https://${customDomain}/s/${data.id}`;
		}
		return `${webUrl}/s/${data.id}`;
	};

	const getDisplayLink = () => {
		if (
			(NODE_ENV === "development" || buildEnv.NEXT_PUBLIC_IS_CAP) &&
			customDomain &&
			domainVerified
		) {
			return `${customDomain}/s/${data.id}`;
		}
		return `${webUrl}/s/${data.id}`;
	};

	const formatTimestamp = (seconds: number): string => {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = seconds % 60;
		if (h > 0)
			return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
		return `${m}:${String(s).padStart(2, "0")}`;
	};

	const copyShareLink = (url: string) =>
		copyRichVideoLink({
			url,
			title: displayTitle || "Cap Recording",
			previewImageUrl: videoPreviewImageUrl(webUrl, data.id),
		});

	const handleCopyClick = () => {
		const video = document.querySelector("video");
		const currentTime = video ? Math.floor(video.currentTime) : 0;

		if (currentTime > 3) {
			setCapturedTime(currentTime);
			setShowCopyOptions(true);
		} else {
			copyShareLink(getVideoLink());
			setLinkCopied(true);
			setTimeout(() => setLinkCopied(false), 2000);
		}
	};

	const handleCopyLink = (withTimestamp: boolean) => {
		const link = withTimestamp
			? `${getVideoLink()}?t=${capturedTime}`
			: getVideoLink();
		copyShareLink(link);
		setShowCopyOptions(false);
		setLinkCopied(true);
		setTimeout(() => setLinkCopied(false), 2000);
	};

	const openShareLinkDialog = () => {
		setShareLinkDialogMounted(true);
		setIsShareLinkDialogOpen(true);
	};

	const handleSharingUpdated = () => {
		refresh();
	};

	const handlePasswordUpdated = (protectedStatus: boolean) => {
		setPasswordProtected(protectedStatus);
		refresh();
	};

	/**
	 * Who can actually watch this, in words. "Shared" on its own told the owner
	 * nothing: not whether the link is public, not who it reaches. The label
	 * names the widest audience and the tooltip spells out what that means.
	 */
	const audience = describeShareAudience({
		isPublic: Boolean(data.public),
		passwordProtected: effectivePasswordProtected,
		audienceNames: [
			...(sharedOrganizations ?? []).map((org) => org.name),
			...(effectiveSharedSpaces ?? []).map((space) => space.name),
		],
	});

	const renderSharedStatus = () => {
		if (!isOwner) {
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

		const AudienceIcon =
			audience.kind === "public"
				? Globe2
				: audience.kind === "spaces"
					? Users
					: Lock;

		return (
			<Tooltip content={audience.tooltip} position="bottom">
				<Button
					className="gap-1.5 px-3 w-fit"
					size="xs"
					variant="outline"
					aria-label={`Sharing: ${audience.label}. Click to manage access.`}
					onClick={() => setIsSharingDialogOpen(true)}
				>
					<AudienceIcon className="size-3.5 text-gray-11" />
					{audience.label}
					<FontAwesomeIcon
						className="size-2.5 text-gray-10"
						icon={faChevronDown}
					/>
				</Button>
			</Tooltip>
		);
	};

	/**
	 * Distribution, next to the audience pill that says who it can reach. The
	 * pill answers "who can see this"; this answers "get it in front of them".
	 * Signed-out viewers get it too on a public Cap — passing a link on is the
	 * one thing they can usefully do here.
	 */
	const renderShareButton = () => (
		<Button
			className="gap-1.5 px-3 w-fit"
			size="xs"
			variant="blue"
			aria-label="Share this Cap"
			onClick={openShareLinkDialog}
			onPointerEnter={() => {
				void importShareLinkDialog();
			}}
			onFocus={() => {
				void importShareLinkDialog();
			}}
		>
			<FontAwesomeIcon className="size-3" icon={faShare} />
			Share
		</Button>
	);

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

	/**
	 * A quiet way out for signed-out viewers. A shared Cap is often someone's
	 * first sight of the product, and until now the page offered them nowhere
	 * to go. Deliberately understated: muted text links and one small button,
	 * not a marketing bar competing with the video.
	 *
	 * Only shown alongside Cap's own logo. An org paying to white-label or hide
	 * the branding has bought the right not to be advertised at.
	 */
	const renderSignedOutNav = () => {
		if (user !== null || branding?.type !== "cap") return null;

		return (
			<nav
				aria-label="Cap"
				className="flex shrink-0 flex-wrap items-center justify-end gap-x-5 gap-y-2"
			>
				<div className="hidden items-center gap-5 md:flex">
					{SIGNED_OUT_LINKS.map((link) => (
						<a
							key={link.href}
							href={`${link.href}?ref=video_${data.id}`}
							className="text-[13px] text-gray-10 transition-colors hover:text-gray-12"
						>
							{link.label}
						</a>
					))}
				</div>
				<div className="flex items-center gap-3">
					<a
						href="/login"
						className="text-[13px] text-gray-11 transition-colors hover:text-gray-12"
					>
						Log in
					</a>
					<Button
						variant="dark"
						size="xs"
						href={`/signup?ref=video_${data.id}`}
						className="h-8 rounded-full px-3 text-xs"
					>
						Get Cap free
					</Button>
				</div>
			</nav>
		);
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
			{sharingDialogMounted && (
				<SharingDialog
					isOpen={isSharingDialogOpen}
					onClose={() => setIsSharingDialogOpen(false)}
					capId={data.id}
					capName={data.name}
					sharedSpaces={effectiveSharedSpaces || []}
					onSharingUpdated={handleSharingUpdated}
					isPublic={data.public}
					spacesData={spacesData}
					hasPassword={passwordProtected}
					inheritedPasswordSources={data.inheritedPasswordSources}
					onPasswordUpdated={handlePasswordUpdated}
					user={user}
					onUpgradeRequest={setUpgradeModalOpen}
				/>
			)}
			{shareLinkDialogMounted && (
				<ShareLinkDialog
					open={isShareLinkDialogOpen}
					onOpenChange={setIsShareLinkDialogOpen}
					videoId={data.id}
					videoTitle={displayTitle}
					shareUrl={getVideoLink()}
					isPublic={Boolean(data.public)}
					canManageAccess={Boolean(isOwner)}
					onManageAccess={() => {
						setIsShareLinkDialogOpen(false);
						setIsSharingDialogOpen(true);
					}}
				/>
			)}
			{isOwner && (
				<>
					{settingsDialogMounted && (
						<SettingsDialog
							isOpen={isSettingsDialogOpen}
							onClose={() => setIsSettingsDialogOpen(false)}
							capId={data.id}
							settingsData={data.videoSettings ?? undefined}
							inheritedSpaceSettings={data.inheritedSpaceSettings}
							user={user}
							organizationSettings={data.orgSettings}
							onSaved={refresh}
						/>
					)}
					{passwordDialogMounted && (
						<PasswordDialog
							isOpen={isPasswordDialogOpen}
							onClose={() => setIsPasswordDialogOpen(false)}
							videoId={data.id}
							hasPassword={passwordProtected}
							onPasswordUpdated={handlePasswordUpdated}
						/>
					)}
					{deleteDialogMounted && (
						<DeleteCapDialog
							open={isDeleteDialogOpen}
							videoId={data.id}
							videoTitle={displayTitle}
							onClose={() => setIsDeleteDialogOpen(false)}
						/>
					)}
				</>
			)}
			{/* Sits in the page bar above both panes, so the spacing is the bar's
			    own padding rather than a top margin against the video. */}
			<div className="py-4">
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
						{/* The title takes the row's slack rather than splitting it with
						    the link button: `justify-between` on two shrinkable items had
						    both of them truncating at once, so the title ran out of room
						    while there was still empty header to its right. */}
						<div className="flex min-w-0 items-center gap-3 lg:min-w-[400px] lg:flex-1">
							{renderBranding()}
							{branding && <div className="h-7 w-px shrink-0 bg-gray-6" />}
							<div className="min-w-0 flex-1">
								{/*
								 * Heading and rename field are the same box: same width, same
								 * type, same position, so opening the field changes nothing on
								 * screen but the caret.
								 *
								 * The box is as wide as the words and no wider, and it grows as
								 * you type until it runs out of header — `minmax(0, max-content)`
								 * is what caps it there, and the hidden sizer is what gives it
								 * its width. The field can't size itself: an input is 20
								 * characters wide whatever it holds, which is what collapsed the
								 * title into a stub the moment you clicked it.
								 *
								 * The negative margins let the surface behind the text breathe
								 * without moving the text off the header's alignment.
								 */}
								<div
									className={clsx(
										"relative -ml-2 -my-1 inline-grid min-w-0 max-w-full grid-cols-[minmax(0,max-content)] items-center rounded-lg px-2 py-1 align-middle ring-1 ring-transparent transition duration-150",
										isEditing
											? "bg-gray-1 ring-blue-500/50"
											: isOwner &&
													"cursor-text hover:bg-gray-3 has-[:focus-visible]:bg-gray-3 has-[:focus-visible]:ring-blue-500/50",
									)}
								>
									<span
										aria-hidden
										className={clsx(
											TITLE_TEXT_CLASS,
											"invisible col-start-1 row-start-1 overflow-hidden whitespace-pre",
										)}
									>
										{(isEditing ? editValue : displayTitle) ||
											TITLE_PLACEHOLDER}
									</span>
									{isEditing ? (
										<input
											ref={titleInputRef}
											value={editValue}
											// Sized by the grid track, not by this — but the browser's
											// 20-character default would otherwise be the track's floor
											// and short titles would get a box far wider than the word.
											size={1}
											maxLength={255}
											spellCheck={false}
											autoComplete="off"
											aria-label="Cap title"
											placeholder={TITLE_PLACEHOLDER}
											onChange={(e) => setEditValue(e.target.value)}
											onBlur={handleTitleBlur}
											onKeyDown={handleTitleKeyDown}
											className={clsx(
												TITLE_TEXT_CLASS,
												"col-start-1 row-start-1 w-full min-w-0 border-0 bg-transparent p-0 outline-none placeholder:text-gray-9",
											)}
										/>
									) : (
										<h1
											className={clsx(
												TITLE_TEXT_CLASS,
												"col-start-1 row-start-1 min-w-0 truncate",
											)}
										>
											{isOwner ? (
												<button
													ref={titleButtonRef}
													type="button"
													// `leading-[inherit]`: the base layer gives every bare
													// button a 1.5rem line height, which would leave the
													// heading stubbier than the field and bump the text
													// every time you clicked it.
													className="block w-full cursor-text truncate text-left leading-[inherit] outline-none"
													onClick={startEditing}
												>
													{displayTitle}
												</button>
											) : (
												displayTitle
											)}
										</h1>
									)}
									{isTitleRevealing && (
										<span aria-hidden className="ai-title-skeleton" />
									)}
								</div>
							</div>
						</div>
						{user !== null && (
							// Holds its own width so the title, not this, absorbs what the
							// row has left over. Its own link label already truncates.
							<div className="lg:shrink-0">
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
						{renderSignedOutNav()}
					</div>
					{/* One row at every width. On phones the owner's side of it is a
					    single "Manage Cap" button, so it sits alongside the byline
					    instead of claiming a row of its own. */}
					<div className="flex flex-wrap gap-3 items-center justify-between">
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
										{fromNow(data.createdAt)}
										{views !== undefined && (
											<Suspense fallback={null}>
												<ViewCount views={views} />
											</Suspense>
										)}
									</p>
								</div>
							</div>
							{/*
							 * Share survives every width — it's the point of the page.
							 * The audience pill doesn't: on phones its readout moves into
							 * the "Sharing & access" row of "Manage Cap", and the viewer's
							 * version of it was inert anyway.
							 */}
							<div className="flex flex-wrap gap-2 items-center">
								{user && (
									<div className="hidden sm:flex">{renderSharedStatus()}</div>
								)}
								{(user || data.public) && renderShareButton()}
							</div>
						</div>
						{user !== null && (
							// `ml-auto` rather than relying on the parent's justify-between:
							// when this wraps onto its own line on a phone, a lone flex item
							// would otherwise sit left, orphaned under the byline.
							<div className="flex flex-wrap items-center gap-2 ml-auto justify-end">
								{isOwner && (
									<>
										{canEditVideo && (
											<Button
												variant="gray"
												size="xs"
												className="hidden h-8 gap-1.5 rounded-full px-2.5 text-xs sm:flex"
												onClick={handleEditVideo}
											>
												<Scissors className="size-3.5 text-gray-12" />
												Edit video
											</Button>
										)}
										<Button
											variant="gray"
											size="xs"
											className="hidden h-8 gap-1.5 rounded-full px-2.5 text-xs sm:flex"
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
										<DropdownMenu modal={false}>
											<DropdownMenuTrigger asChild>
												<Button
													variant="dark"
													size="xs"
													className="h-8 gap-1.5 rounded-full px-3 text-xs"
												>
													<FontAwesomeIcon
														className="size-3.5"
														icon={faEllipsis}
													/>
													Manage Cap
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end" sideOffset={5}>
												{/* The header buttons phones don't show. Hidden from
												    `sm` up so nothing is offered twice. Share isn't
												    among them: it keeps its own button at every width. */}
												{canEditVideo && (
													<DropdownMenuItem
														onClick={handleEditVideo}
														className="flex items-center gap-2 rounded-lg sm:hidden"
													>
														<Scissors className="size-3.5" />
														<p className="text-sm text-gray-12">Edit video</p>
													</DropdownMenuItem>
												)}
												<DropdownMenuItem
													onClick={() => {
														push(`/dashboard/analytics?capId=${data.id}`);
													}}
													className="flex items-center gap-2 rounded-lg sm:hidden"
												>
													<FontAwesomeIcon
														className="size-3"
														icon={faChartSimple}
													/>
													<p className="text-sm text-gray-12">View analytics</p>
												</DropdownMenuItem>
												<DropdownMenuSeparator className="sm:hidden" />
												<DropdownMenuItem
													onClick={() => setIsSharingDialogOpen(true)}
													className="flex items-center gap-2 rounded-lg"
												>
													<FontAwesomeIcon className="size-3" icon={faShare} />
													<p className="text-sm text-gray-12">
														Sharing & access
													</p>
													{/* The audience pill is desktop-only, so its readout
													    has to live here on phones. */}
													<span className="ml-auto max-w-[9rem] truncate pl-3 text-xs text-gray-10 sm:hidden">
														{audience.label}
													</span>
												</DropdownMenuItem>
												<DropdownMenuItem
													onClick={() => setIsSettingsDialogOpen(true)}
													className="flex items-center gap-2 rounded-lg"
												>
													<FontAwesomeIcon className="size-3" icon={faGear} />
													<p className="text-sm text-gray-12">Video settings</p>
												</DropdownMenuItem>
												<DropdownMenuItem
													onClick={() => {
														if (!user.isPro) setUpgradeModalOpen(true);
														else setIsPasswordDialogOpen(true);
													}}
													className="flex items-center gap-2 rounded-lg"
												>
													<FontAwesomeIcon
														className="size-3"
														icon={
															effectivePasswordProtected ? faLock : faUnlock
														}
													/>
													<p className="text-sm text-gray-12">
														{passwordProtected
															? "Edit password"
															: "Add password"}
													</p>
												</DropdownMenuItem>
												<DuplicateCapMenuItem
													videoId={data.id}
													disabled={data.hasActiveUpload}
												/>
												{/* Downloads used to live behind a second dots button next to
												    the link. There is one "everything else about this Cap"
												    menu, and this is it. */}
												{canDownload && (
													<>
														<DropdownMenuSeparator />
														<DropdownMenuItem
															onClick={() => download("current")}
															disabled={isDownloading}
															className="flex items-center gap-2 rounded-lg"
														>
															<Download className="size-3.5" />
															<p className="text-sm text-gray-12">
																{hasEdits
																	? "Download current video"
																	: "Download video"}
															</p>
														</DropdownMenuItem>
														{hasEdits && (
															<DropdownMenuItem
																onClick={() => download("original")}
																disabled={isDownloading}
																className="flex items-center gap-2 rounded-lg"
															>
																<Download className="size-3.5" />
																<p className="text-sm text-gray-12">
																	Download original video
																</p>
															</DropdownMenuItem>
														)}
													</>
												)}
												<DropdownMenuSeparator />
												<DropdownMenuItem
													onClick={() => push("/dashboard/caps?page=1")}
													className="flex items-center gap-2 rounded-lg"
												>
													<LayoutDashboard className="size-3.5" />
													<p className="text-sm text-gray-12">
														Go to dashboard
													</p>
												</DropdownMenuItem>
												<DropdownMenuItem
													onClick={() => setIsDeleteDialogOpen(true)}
													className="flex items-center gap-2 rounded-lg text-red-500 focus:text-red-600"
												>
													<FontAwesomeIcon className="size-3" icon={faTrash} />
													<p className="text-sm text-inherit">Delete Cap</p>
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									</>
								)}
								{!isOwner && (
									<>
										{/* Space and org members can download someone else's Cap,
										    and they never see "Manage Cap" — so the action has to
										    stand on its own for them. */}
										{canDownload &&
											(hasEdits ? (
												<VideoDownloadMenu
													videoId={data.id}
													hasEdits
													triggerLabel="Download"
													triggerClassName="h-8 gap-1.5 rounded-full border border-gray-5 bg-gray-3 px-2.5 text-xs text-gray-12 transition hover:bg-gray-6"
													trigger={
														<>
															<Download className="size-3.5" aria-hidden />
															Download
														</>
													}
												/>
											) : (
												<Button
													variant="gray"
													size="xs"
													className="h-8 gap-1.5 rounded-full px-2.5 text-xs"
													disabled={isDownloading}
													onClick={() => download("current")}
												>
													<Download className="size-3.5 text-gray-12" />
													Download
												</Button>
											))}
										<Button
											size="xs"
											className="h-8 rounded-full px-2.5 text-xs"
											onClick={() => {
												push("/dashboard/caps?page=1");
											}}
										>
											Go to dashboard
										</Button>
									</>
								)}
							</div>
						)}
					</div>
				</div>
			</div>
			{upgradeModalMounted && (
				<UpgradeModal
					open={upgradeModalOpen}
					onOpenChange={setUpgradeModalOpen}
				/>
			)}
		</>
	);
};

/**
 * Suspends on the count alone, inside the meta line, so the rest of the header
 * paints immediately. A failed lookup resolves to null and simply says nothing
 * rather than taking the header down with it.
 */
function ViewCount({ views }: { views: MaybePromise<number | null> }) {
	const count = views instanceof Promise ? use(views) : views;
	if (count === null || count === undefined) return null;
	return <>{` · ${count} ${count === 1 ? "view" : "views"}`}</>;
}
