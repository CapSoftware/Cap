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
import type { Organisation } from "@cap/web-domain";
import { faShare } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
	BarChart3,
	Check,
	ChevronDown,
	Clock,
	Copy,
	Download,
	Globe2,
	Image as ImageIcon,
	Link2,
	Lock,
	LockOpen,
	MoreHorizontal,
	MousePointer2,
	Pencil,
	Scissors,
	Settings2,
	Trash2,
	Users,
	X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	type MouseEvent as ReactMouseEvent,
	Suspense,
	use,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	hideShareableLinkCapLogo,
	selectShareableLinkBrandingOrganization,
} from "@/actions/organization/shareable-link-icon";
import { editTitle } from "@/actions/videos/edit-title";
import type { VideoStatusResult } from "@/actions/videos/get-status";
import { updateActiveOrganization } from "@/app/(org)/dashboard/_components/Navbar/server";
import { useDashboardContext } from "@/app/(org)/dashboard/DashboardContext";
import type { Spaces } from "@/app/(org)/dashboard/dashboard-data";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import {
	EditorShellBar,
	EditorShellBrand,
	EditorShellTab,
	EditorTabLabel,
	RecordVideoLink,
} from "@/components/editor-shell/editor-shell-bar";
import { ShareLinkTab } from "@/components/editor-shell/share-link-tab";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { Tooltip } from "@/components/Tooltip";
import { rememberEntryFrame } from "@/lib/editor-entry-frame";
import type { ShareDashboardDestination } from "@/lib/share-dashboard-destination";
import { formatTimestamp, shareLinkUrl } from "@/lib/share-link";
import {
	type LinkPreviewState,
	linkPreviewDisplayHost,
} from "@/lib/share-link-preview";
import {
	copyRichVideoLink,
	videoPreviewImageUrl,
} from "@/lib/video-share-clipboard";
import { usePublicEnv } from "@/utils/public-env";
import { navigateWithTransition, nextPageReady } from "@/utils/view-transition";
import type { SharePageBranding, VideoData } from "../types";
import { DashboardBackLink } from "./DashboardBackLink";
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
const CallToActionDialog = dynamic(
	() =>
		import("./call-to-action/CallToActionDialog").then(
			(m) => m.CallToActionDialog,
		),
	{ ssr: false },
);
const LinkPreviewDialog = dynamic(
	() =>
		import("./link-preview/LinkPreviewDialog").then((m) => m.LinkPreviewDialog),
	{ ssr: false },
);
const DuplicateCapMenuItem = dynamic(() => import("./DuplicateCapMenuItem"), {
	ssr: false,
});

/**
 * Where a signed-out viewer can go next. Three, not the full site nav: the
 * brand bar is chrome, and has to stay out of the video's way.
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
	"text-xl leading-7 font-medium tracking-[-0.015em] text-gray-12 sm:text-2xl sm:leading-8";

const TITLE_PLACEHOLDER = "Cap title";

/** `overflow-wrap: anywhere` so a title with no spaces still breaks onto line two. */
const TITLE_CLAMP_CLASS =
	"block truncate sm:line-clamp-2 sm:whitespace-normal sm:[overflow-wrap:anywhere]";

/** Every control in the title row's action cluster: one height, one radius. */
const ACTION_BUTTON_CLASS =
	"h-9 gap-1.5 rounded-full px-3 text-[13px] sm:h-8 sm:text-xs";

const ICON_BUTTON_CLASS = "w-9 shrink-0 px-0 sm:w-8";

export const ShareHeader = ({
	data,
	customDomain,
	domainVerified,
	allowedEmailDomain,
	sharedOrganizations = [],
	sharedSpaces = [],
	viewerCount = 0,
	spacesData = null,
	branding,
	canManageSharePageBranding = false,
	canDownload = false,
	hasEdits = false,
	opensStudio = false,
	views,
	dashboardDestination = null,
	linkPreview = null,
}: {
	/** The owner's link preview overrides; null for everyone else. */
	linkPreview?: LinkPreviewState | null;
	data: VideoData;
	customDomain?: string | null;
	domainVerified?: boolean;
	allowedEmailDomain?: string | null;
	sharedOrganizations?: { id: string; name: string }[];
	viewerCount?: number;
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
	/** The owner edits in the studio editor, which doesn't need Cap Pro to open. */
	opensStudio?: boolean;
	/**
	 * Shown to every viewer, not just the owner. The sidebar's analytics row is
	 * members-only, which left a shared link with no sense of reach at all.
	 * Resolves late and never blocks the header (see `ViewCount`).
	 */
	views?: MaybePromise<number | null>;
	dashboardDestination?: ShareDashboardDestination | null;
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
	const [ctaDialogMounted, setCtaDialogMounted] = useState(false);
	const [isCtaDialogOpen, setIsCtaDialogOpenRaw] = useState(false);
	const [linkPreviewDialogMounted, setLinkPreviewDialogMounted] =
		useState(false);
	const [isLinkPreviewDialogOpen, setIsLinkPreviewDialogOpenRaw] =
		useState(false);
	const [linkPreviewState, setLinkPreviewState] = useState(linkPreview);
	useEffect(() => setLinkPreviewState(linkPreview), [linkPreview]);
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
	const setIsLinkPreviewDialogOpen = (open: boolean) => {
		if (open) setLinkPreviewDialogMounted(true);
		setIsLinkPreviewDialogOpenRaw(open);
	};
	const setIsCtaDialogOpen = (open: boolean) => {
		if (open) setCtaDialogMounted(true);
		setIsCtaDialogOpenRaw(open);
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

	// Coming back from the editor, its transition waits for this page.
	useEffect(() => nextPageReady(), []);

	useEffect(() => {
		if (!showCopyOptions) return;
		// The control renders twice (full link on desktop, compact button below
		// it) with only one visible, so "outside" means outside either copy.
		const handler = (e: MouseEvent) => {
			if (
				e.target instanceof Element &&
				e.target.closest("[data-copy-link-control]")
			) {
				return;
			}
			setShowCopyOptions(false);
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

	const getVideoLink = () =>
		shareLinkUrl(data.id, domainVerified ? (customDomain ?? null) : null);

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
		allowedEmailDomain,
		passwordProtected: effectivePasswordProtected,
		audienceNames: [
			...(sharedOrganizations ?? []).map((org) => org.name),
			...(effectiveSharedSpaces ?? [])
				.filter(
					(space) => !sharedOrganizations.some((org) => org.id === space.id),
				)
				.map((space) => space.name),
		],
		viewerCount,
	});

	const renderAudiencePill = (className?: string) => {
		const AudienceIcon =
			audience.kind === "public"
				? Globe2
				: audience.kind === "spaces" || audience.kind === "people"
					? Users
					: Lock;

		return (
			<Tooltip content={audience.tooltip} position="bottom">
				<Button
					className={clsx(ACTION_BUTTON_CLASS, "min-w-0 max-w-full", className)}
					size="xs"
					variant="outline"
					aria-label={`Sharing: ${audience.label}. Click to manage access.`}
					onClick={() => setIsSharingDialogOpen(true)}
				>
					<AudienceIcon className="size-3.5 shrink-0 text-gray-11" />
					<span className="truncate">{audience.label}</span>
					{effectivePasswordProtected && audience.kind !== "public" && (
						<Lock
							className="size-3 shrink-0 text-amber-600"
							aria-label="Password protected"
						/>
					)}
					<ChevronDown className="size-3.5 shrink-0 text-gray-10" />
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
	const renderShareButton = (className?: string) => (
		<Button
			className={clsx(ACTION_BUTTON_CLASS, "px-4", className)}
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

	/**
	 * The link itself, one click from the Share button. Icon-only: the share
	 * sheet already shows the URL, and the header's job is the title.
	 */
	const renderCopyLinkControl = () => (
		<div className="relative shrink-0" data-copy-link-control>
			<Tooltip
				content={linkCopied ? "Copied" : `Copy ${getDisplayLink()}`}
				position="bottom"
			>
				<Button
					variant="outline"
					size="xs"
					className={clsx(ACTION_BUTTON_CLASS, ICON_BUTTON_CLASS)}
					aria-label={linkCopied ? "Link copied" : "Copy link"}
					onClick={handleCopyClick}
				>
					{linkCopied ? (
						<Check className="size-4 text-green-600 svgpathanimation" />
					) : (
						<Link2 className="size-4 text-gray-11" />
					)}
				</Button>
			</Tooltip>
			{showCopyOptions && (
				<div className="absolute right-0 top-full z-50 mt-1.5 w-max overflow-hidden rounded-xl border border-gray-5 bg-white p-1 shadow-lg">
					<button
						type="button"
						className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-12 transition-colors hover:bg-gray-3"
						onClick={() => handleCopyLink(false)}
					>
						<Copy className="w-3.5 h-3.5 shrink-0" />
						Copy link
					</button>
					<button
						type="button"
						className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-12 transition-colors hover:bg-gray-3"
						onClick={() => handleCopyLink(true)}
					>
						<Clock className="w-3.5 h-3.5 shrink-0" />
						Copy link at {formatTimestamp(capturedTime)}
					</button>
				</div>
			)}
		</div>
	);

	const userIsOwnerAndNotPro = user?.id === data.owner.id && !data.owner.isPro;
	const canEditVideo =
		isOwner &&
		!data.isScreenshot &&
		!data.hasActiveUpload &&
		(data.source.type === "desktopMP4" || data.source.type === "webMP4");
	// Owners who edit in Studio get the editor's bar here too: the share link
	// and the editor as two sides of one toggle.
	const showsEditorBar =
		isOwner &&
		opensStudio &&
		!data.isScreenshot &&
		(data.source.type === "desktopMP4" || data.source.type === "webMP4");
	const handleEditVideo = () => {
		if (userIsOwnerAndNotPro && !opensStudio) {
			setUpgradeModalOpen(true);
			return;
		}

		rememberEntryFrame(
			data.id,
			document.querySelector<HTMLVideoElement>("[data-edit-video] video"),
		);
		navigateWithTransition(
			"edit-enter",
			() => push(`/s/${data.id}/edit${opensStudio ? "/studio" : ""}`),
			{ waitForNextPage: opensStudio },
		);
	};

	// The editor bar's way back goes where the dashboard link would, switching
	// to the Cap's organization first like it does.
	const dashboardBackHref = dashboardDestination?.href ?? "/dashboard/caps";
	const handleEditorBarBack = async (
		event: ReactMouseEvent<HTMLAnchorElement>,
	) => {
		const organizationId = dashboardDestination?.switchOrganizationId;
		if (!organizationId) return;
		event.preventDefault();
		try {
			await updateActiveOrganization(
				organizationId as Organisation.OrganisationId,
			);
		} catch (error) {
			console.error("Failed to switch organization", error);
			toast.error("Couldn't open your dashboard. Please try again.");
			return;
		}
		push(dashboardBackHref);
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
				className="flex shrink-0 items-center justify-end gap-5"
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
						className="h-8 rounded-full px-3.5 text-xs"
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
					<div className="pointer-events-none absolute left-0 top-full z-20 pt-1.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
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
					<div className="inline-flex h-8 max-w-48 items-center justify-center">
						<Image
							src={branding.imageUrl}
							alt={`${branding.name} logo`}
							width={176}
							height={32}
							unoptimized
							className="max-h-7 w-auto max-w-44 object-contain"
						/>
					</div>
				) : (
					<a
						target="_blank"
						rel="noreferrer"
						href={`/?ref=video_${data.id}`}
						className="inline-flex h-8 items-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
					>
						<Logo className="h-6 w-auto" />
					</a>
				)}
			</div>
		);
	};

	/**
	 * Everything else about this Cap, behind one quiet button at the end of the
	 * action row. Analytics leads it: the view count in the meta line opens the
	 * same page, so this is the second way in, not the only one.
	 */
	const renderManageMenu = () => {
		if (!isOwner) return null;
		const itemClass = "flex items-center gap-2.5 rounded-lg";
		return (
			<DropdownMenu modal={false}>
				<Tooltip content="Manage this Cap" position="bottom">
					<DropdownMenuTrigger asChild>
						<Button
							variant="outline"
							size="xs"
							aria-label="Manage Cap"
							className={clsx(
								ACTION_BUTTON_CLASS,
								"w-9 shrink-0 px-0 sm:w-auto sm:pl-2.5 sm:pr-3.5",
							)}
						>
							<MoreHorizontal className="size-4 text-gray-11" />
							<span className="hidden sm:inline">Manage</span>
						</Button>
					</DropdownMenuTrigger>
				</Tooltip>
				<DropdownMenuContent align="end" sideOffset={6} className="min-w-60">
					{/* Phones drop Edit and Copy link from the row, so they live
					    here below `sm`. With the editor bar, Edit has no row
					    button at any width. */}
					{canEditVideo && (
						<DropdownMenuItem
							onClick={handleEditVideo}
							className={clsx(itemClass, !showsEditorBar && "sm:hidden")}
						>
							<Scissors className="size-3.5" />
							<p className="text-sm text-gray-12">Edit video</p>
						</DropdownMenuItem>
					)}
					{!showsEditorBar && (
						<DropdownMenuItem
							onClick={() => handleCopyLink(false)}
							className={clsx(itemClass, "sm:hidden")}
						>
							<Link2 className="size-3.5" />
							<p className="text-sm text-gray-12">Copy link</p>
						</DropdownMenuItem>
					)}
					<DropdownMenuItem asChild className={itemClass}>
						<Link href={`/dashboard/analytics?capId=${data.id}`}>
							<BarChart3 className="size-3.5" />
							<p className="text-sm text-gray-12">View analytics</p>
						</Link>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={() => setIsSharingDialogOpen(true)}
						className={itemClass}
					>
						<Users className="size-3.5" />
						<p className="text-sm text-gray-12">Sharing & access</p>
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => setIsSettingsDialogOpen(true)}
						className={itemClass}
					>
						<Settings2 className="size-3.5" />
						<p className="text-sm text-gray-12">Video settings</p>
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							if (!data.owner.isPro) setUpgradeModalOpen(true);
							else setIsCtaDialogOpen(true);
						}}
						className={itemClass}
					>
						<MousePointer2 className="size-3.5" />
						<p className="text-sm text-gray-12">
							{data.callToAction ? "Edit call to action" : "Add call to action"}
						</p>
						{!data.owner.isPro ? (
							<span className="ml-auto pl-3 text-xs text-gray-10">Pro</span>
						) : data.callToAction ? (
							<span className="ml-auto pl-3 text-xs text-gray-10">On</span>
						) : null}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							// A downgraded owner still sees what they set, and can reset it.
							if (data.owner.isPro || linkPreviewState)
								setIsLinkPreviewDialogOpen(true);
							else setUpgradeModalOpen(true);
						}}
						className={itemClass}
					>
						<ImageIcon className="size-3.5" />
						<p className="text-sm text-gray-12">Link preview</p>
						{!data.owner.isPro ? (
							<span className="ml-auto pl-3 text-xs text-gray-10">Pro</span>
						) : linkPreviewState ? (
							<span className="ml-auto pl-3 text-xs text-gray-10">Custom</span>
						) : null}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							if (!user.isPro) setUpgradeModalOpen(true);
							else setIsPasswordDialogOpen(true);
						}}
						className={itemClass}
					>
						{effectivePasswordProtected ? (
							<Lock className="size-3.5" />
						) : (
							<LockOpen className="size-3.5" />
						)}
						<p className="text-sm text-gray-12">
							{passwordProtected ? "Edit password" : "Add password"}
						</p>
					</DropdownMenuItem>
					{userIsOwnerAndNotPro && (
						<DropdownMenuItem
							onClick={() => setUpgradeModalOpen(true)}
							className={itemClass}
						>
							<Globe2 className="size-3.5" />
							<p className="text-sm text-gray-12">Connect a custom domain</p>
							<span className="ml-auto pl-3 text-xs text-gray-10">Pro</span>
						</DropdownMenuItem>
					)}
					<DuplicateCapMenuItem
						videoId={data.id}
						disabled={data.hasActiveUpload}
					/>
					{canDownload && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								onClick={() => download("current")}
								disabled={isDownloading}
								className={itemClass}
							>
								<Download className="size-3.5" />
								<p className="text-sm text-gray-12">
									{hasEdits ? "Download current video" : "Download video"}
								</p>
							</DropdownMenuItem>
							{hasEdits && (
								<DropdownMenuItem
									onClick={() => download("original")}
									disabled={isDownloading}
									className={itemClass}
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
						onClick={() => setIsDeleteDialogOpen(true)}
						className={clsx(itemClass, "text-red-500 focus:text-red-600")}
					>
						<Trash2 className="size-3.5" />
						<p className="text-sm text-inherit">Delete Cap</p>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		);
	};

	// Nothing to put in it: an organization that hid the logo, shown to someone
	// with no dashboard to go back to.
	const hasBrandBar =
		Boolean(branding) || Boolean(dashboardDestination) || user === null;

	return (
		<>
			{sharingDialogMounted && (
				<SharingDialog
					isOpen={isSharingDialogOpen}
					onClose={() => setIsSharingDialogOpen(false)}
					capId={data.id}
					capName={data.name}
					sharedSpaces={effectiveSharedSpaces || []}
					onSharingUpdated={handleSharingUpdated}
					isPublic={data.public}
					allowedEmailDomain={allowedEmailDomain}
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
					{ctaDialogMounted && (
						<CallToActionDialog
							open={isCtaDialogOpen}
							onOpenChange={setIsCtaDialogOpen}
							videoId={data.id}
							callToAction={data.callToAction ?? null}
							onSaved={refresh}
							onUpgradeRequest={() => setUpgradeModalOpen(true)}
						/>
					)}
					{linkPreviewDialogMounted && (
						<LinkPreviewDialog
							open={isLinkPreviewDialogOpen}
							onOpenChange={setIsLinkPreviewDialogOpen}
							videoId={data.id}
							videoName={displayTitle}
							ownerName={data.owner.name ?? ""}
							host={linkPreviewDisplayHost(
								(NODE_ENV === "development" || buildEnv.NEXT_PUBLIC_IS_CAP) &&
									domainVerified
									? (customDomain ?? null)
									: null,
								webUrl,
							)}
							linkPreview={linkPreviewState}
							canEdit={data.owner.isPro}
							onSaved={(next) => {
								setLinkPreviewState(next);
								refresh();
							}}
							onUpgradeRequest={() => setUpgradeModalOpen(true)}
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
			{/* The page's chrome, spanning the video column and the comments rail.
			    Studio owners get the editor's own bar, so the share link and the
			    editor read as two sides of one toggle; everyone else gets a quiet
			    brand bar. Both hide in timeline view, which has its own title row. */}
			<div className="min-w-0 bg-white lg:col-span-2 group-data-[share-view=timeline]/share:hidden">
				{userIsOwnerAndNotPro && (
					<div className="flex items-center justify-center gap-3 border-b border-gray-5 bg-gray-2 px-4 py-2 text-center text-[13px] text-gray-11">
						<p className="min-w-0">
							Shareable links are limited to 5 mins on the free plan.
						</p>
						<button
							type="button"
							onClick={() => setUpgradeModalOpen(true)}
							className="shrink-0 font-medium text-blue-600 transition-colors hover:text-blue-700"
						>
							Upgrade to Cap Pro
						</button>
					</div>
				)}
				{showsEditorBar ? (
					<div className="border-b border-gray-5">
						<EditorShellBar
							light="white"
							left={
								<EditorShellBrand
									title={<span className="max-sm:sr-only">Dashboard</span>}
									backHref={dashboardBackHref}
									onClick={(event) => void handleEditorBarBack(event)}
									prefetchOnHover
								/>
							}
							center={
								<>
									<ShareLinkTab
										active
										videoId={data.id}
										shareUrl={getVideoLink()}
										title={displayTitle}
										isPublic={Boolean(data.public)}
										playbackTime={() =>
											document.querySelector<HTMLVideoElement>(
												"[data-edit-video] video",
											)?.currentTime ?? 0
										}
										onPrivacyClick={() => setIsSharingDialogOpen(true)}
									/>
									<EditorShellTab
										active={false}
										disabled={!canEditVideo}
										onClick={handleEditVideo}
									>
										<EditorTabLabel />
									</EditorShellTab>
								</>
							}
							right={<RecordVideoLink prefetchOnHover compact />}
						/>
					</div>
				) : (
					hasBrandBar && (
						<header className="flex h-12 items-center justify-between gap-3 border-b border-gray-5 px-3 sm:px-4">
							<div className="flex min-w-0 items-center gap-1">
								{renderBranding()}
								{branding && dashboardDestination && (
									<span
										aria-hidden
										className="mx-1.5 h-4 w-px shrink-0 bg-gray-5"
									/>
								)}
								{dashboardDestination && (
									<DashboardBackLink destination={dashboardDestination} />
								)}
							</div>
							{renderSignedOutNav()}
						</header>
					)
				)}
			</div>
			{/* Title, who made it, and what you can do with it, held to the video
			    card's edges below so the actions sit with the video rather than at
			    the far edge of the window. */}
			<div className="min-w-0 lg:col-start-1 lg:row-start-2 group-data-[share-view=timeline]/share:hidden">
				{/* Where the actions go is fixed per breakpoint, never decided by
				    how long the title is: beside the title once the column is
				    wide enough for the whole group (`xl` for the owner's, `sm` for
				    a viewer's two or three buttons), under the meta line before
				    that. A long title only ever clamps; it never moves them. */}
				<div
					className={clsx(
						"mx-auto flex w-full max-w-[80rem] flex-col gap-3 px-4 pt-5 lg:px-8 lg:pt-6",
						isOwner
							? "xl:flex-row xl:items-center xl:justify-between xl:gap-8"
							: "sm:flex-row sm:items-center sm:justify-between sm:gap-8",
					)}
				>
					<div className="min-w-0 flex-1">
						<div
							className={clsx(
								"relative -ml-2 -my-1 inline-grid min-w-0 max-w-full grid-cols-[minmax(0,max-content)] items-start rounded-lg px-2 py-1 align-middle ring-1 ring-transparent transition duration-150",
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
								{(isEditing ? editValue : displayTitle) || TITLE_PLACEHOLDER}
							</span>
							{isEditing && (
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
										"relative z-10 col-start-1 row-start-1 w-full min-w-0 border-0 bg-transparent p-0 outline-none placeholder:text-gray-9",
									)}
								/>
							)}
							{/*
							 * One line on phones, two from `sm`, then an ellipsis, so the
							 * header is the same height for any title. The whole title
							 * is in the hover tooltip and in the rename field. The
							 * heading stays mounted (invisible) while renaming so the
							 * field opening doesn't drop a two-line title to one line
							 * and pull the video up under the cursor.
							 */}
							<h1
								title={displayTitle}
								className={clsx(
									TITLE_TEXT_CLASS,
									"col-start-1 row-start-1 min-w-0",
									isEditing && "invisible",
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
										className="block w-full cursor-text text-left leading-[inherit] outline-none"
										onClick={startEditing}
									>
										<span className={TITLE_CLAMP_CLASS}>{displayTitle}</span>
									</button>
								) : (
									<span className={TITLE_CLAMP_CLASS}>{displayTitle}</span>
								)}
							</h1>
							{isTitleRevealing && (
								<span aria-hidden className="ai-title-skeleton" />
							)}
						</div>
						<div className="mt-1.5 flex min-w-0 items-center gap-2 text-[13px] leading-5 text-gray-10">
							{data.name && (
								<SignedImageUrl
									name={data.owner.name ?? data.name}
									image={data.owner.image}
									className="size-5 shrink-0"
									letterClass="text-[10px]"
								/>
							)}
							<p className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
								<span className="truncate font-medium text-gray-12">
									{data.owner.name}
								</span>
								<MetaDot />
								{/* Relative to now, so the server's render can be a unit behind. */}
								<span suppressHydrationWarning>{fromNow(data.createdAt)}</span>
								{views !== undefined && (
									<Suspense fallback={null}>
										<ViewCount
											views={views}
											analyticsHref={
												isOwner
													? `/dashboard/analytics?capId=${data.id}`
													: undefined
											}
										/>
									</Suspense>
								)}
								{user !== null && !isOwner && (
									<>
										<MetaDot />
										<span className="inline-flex items-center gap-1">
											<Users className="size-3.5" aria-hidden />
											Shared with you
										</span>
									</>
								)}
							</p>
						</div>
					</div>
					{isOwner ? (
						<div className="flex w-full min-w-0 flex-nowrap items-center gap-1.5 sm:w-auto sm:gap-2 sm:self-start xl:shrink-0 xl:self-auto">
							{renderAudiencePill("flex-1 sm:max-w-[13rem] sm:flex-none")}
							{!showsEditorBar && (
								<div className="hidden sm:block">{renderCopyLinkControl()}</div>
							)}
							{renderShareButton("shrink-0")}
							{canEditVideo && !showsEditorBar && (
								<Button
									variant="gray"
									size="xs"
									className={clsx(
										ACTION_BUTTON_CLASS,
										"hidden shrink-0 sm:flex",
									)}
									onClick={handleEditVideo}
								>
									<Scissors className="size-3.5 text-gray-12" />
									Edit
								</Button>
							)}
							{renderManageMenu()}
						</div>
					) : (
						(user !== null || data.public || canDownload) && (
							<div className="flex shrink-0 flex-nowrap items-center gap-2 self-start sm:self-auto">
								{(user !== null || data.public) && renderCopyLinkControl()}
								{(user !== null || data.public) &&
									renderShareButton("shrink-0")}
								{/* Space and org members can download someone else's
								    Cap, and they never see the owner's menu, so the action
								    has to stand on its own for them. */}
								{canDownload &&
									(hasEdits ? (
										<VideoDownloadMenu
											videoId={data.id}
											hasEdits
											triggerLabel="Download"
											triggerClassName={clsx(
												ACTION_BUTTON_CLASS,
												"flex items-center justify-center border border-gray-5 bg-gray-3 font-medium text-gray-12 transition hover:bg-gray-5",
											)}
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
											className={ACTION_BUTTON_CLASS}
											disabled={isDownloading}
											onClick={() => download("current")}
										>
											<Download className="size-3.5 text-gray-12" />
											Download
										</Button>
									))}
							</div>
						)
					)}
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
function ViewCount({
	views,
	analyticsHref,
}: {
	views: MaybePromise<number | null>;
	/** The owner's count opens the Cap's analytics. */
	analyticsHref?: string;
}) {
	const count = views instanceof Promise ? use(views) : views;
	if (count === null || count === undefined) return null;
	const label = `${count} ${count === 1 ? "view" : "views"}`;
	return (
		<>
			<MetaDot />
			{analyticsHref ? (
				<Tooltip content="View analytics" position="bottom">
					<Link
						href={analyticsHref}
						className="inline-flex items-center gap-1 rounded transition-colors hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
					>
						<BarChart3 className="size-3.5" aria-hidden />
						{label}
					</Link>
				</Tooltip>
			) : (
				<span>{label}</span>
			)}
		</>
	);
}

function MetaDot() {
	return (
		<span aria-hidden className="text-gray-8">
			·
		</span>
	);
}
