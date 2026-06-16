"use client";

import { Button } from "@cap/ui";
import { type Folder, PublicCollection } from "@cap/web-domain";
import {
	faCheck,
	faCopy,
	faGlobe,
	faSliders,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { setCollectionLogo } from "@/actions/collections/logo";
import { setSpaceCollectionVisibility } from "@/actions/collections/visibility";
import { Tooltip } from "@/components/Tooltip";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { useCopyCollectionLink } from "@/lib/public-collection-client";
import { useDashboardContext } from "../Contexts";
import { CollectionShareDialog } from "./CollectionShareDialog";

type PublicPageSettings = PublicCollection.PublicPageSettings;
type PublicPageSettingsUpdate = PublicCollection.PublicPageSettingsUpdate;

interface CollectionShareControlProps {
	kind: "folder" | "space";
	collectionId: string;
	isPublic: boolean;
	canManage: boolean;
	isPro: boolean;
	settings: PublicPageSettings | null;
}

export const CollectionShareControl = ({
	kind,
	collectionId,
	isPublic,
	canManage,
	isPro,
	settings,
}: CollectionShareControlProps) => {
	const router = useRouter();
	const rpc = useRpcClient();
	const { setUpgradeModalOpen } = useDashboardContext();
	const { url, copied, copy } = useCopyCollectionLink(collectionId);
	const displayUrl = url.replace(/^https?:\/\//, "");

	const [pub, setPub] = useState(isPublic);
	const [draft, setDraft] = useState(() =>
		PublicCollection.resolvePublicPageSettings(settings),
	);
	const [open, setOpen] = useState(false);

	useEffect(() => setPub(isPublic), [isPublic]);
	useEffect(
		() => setDraft(PublicCollection.resolvePublicPageSettings(settings)),
		[settings],
	);

	const onError = (error: unknown) => {
		setPub(isPublic);
		setDraft(PublicCollection.resolvePublicPageSettings(settings));
		toast.error(
			error instanceof Error ? error.message : "Something went wrong",
		);
	};
	const onSuccess = () => router.refresh();

	const folderMutation = useEffectMutation({
		mutationFn: (data: {
			public?: boolean;
			settings?: PublicPageSettingsUpdate;
		}) =>
			rpc.FolderUpdate({
				id: collectionId as Folder.FolderId,
				public: data.public,
				publicPage: data.settings,
			}),
		onSuccess,
		onError,
	});

	const spaceMutation = useMutation({
		mutationFn: async (data: {
			public?: boolean;
			settings?: PublicPageSettingsUpdate;
		}) => {
			const result = await setSpaceCollectionVisibility({
				spaceId: collectionId,
				public: data.public,
				settings: data.settings,
			});
			if (!result.success) throw new Error(result.error);
		},
		onSuccess,
		onError,
	});

	const persist = (data: {
		public?: boolean;
		settings?: PublicPageSettingsUpdate;
	}) =>
		kind === "folder"
			? folderMutation.mutate(data)
			: spaceMutation.mutate(data);

	const logoMutation = useMutation({
		mutationFn: async (file: File | null) => {
			const formData = new FormData();
			formData.append("collectionId", collectionId);
			formData.append("kind", kind);
			if (file) formData.append("logo", file);
			else formData.append("remove", "true");

			const result = await setCollectionLogo(formData);
			if (!result.success) throw new Error(result.error);
		},
		onSuccess: (_data, file) => {
			router.refresh();
			toast.success(file ? "Logo updated" : "Logo removed");
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Failed to update logo",
			),
	});

	const isPending =
		folderMutation.isPending ||
		spaceMutation.isPending ||
		logoMutation.isPending;

	const handleTogglePublic = (next: boolean) => {
		if (next) {
			if (!isPro) {
				setOpen(false);
				setUpgradeModalOpen(true);
				return;
			}
			setPub(true);
			persist({ public: true });
			return;
		}
		setPub(false);
		persist({ public: false });
	};

	// Optimistically merge into the local draft but persist only the patch —
	// the server merges it into the stored settings, so a concurrent logo
	// upload (or another in-flight patch) is never overwritten.
	const updateSettings = (patch: PublicPageSettingsUpdate) => {
		setDraft((prev) => ({ ...prev, ...patch }));
		persist({ settings: patch });
	};

	if (!pub && !canManage) return null;

	const dialog = canManage ? (
		<CollectionShareDialog
			open={open}
			onOpenChange={setOpen}
			kind={kind}
			collectionId={collectionId}
			isPublic={pub}
			isPro={isPro}
			isPending={isPending}
			settings={draft}
			onTogglePublic={handleTogglePublic}
			onUpdateSettings={updateSettings}
			onUploadLogo={(file) => logoMutation.mutate(file)}
			onRemoveLogo={() => logoMutation.mutate(null)}
			isUploadingLogo={logoMutation.isPending}
		/>
	) : null;

	if (pub) {
		return (
			<div className="flex gap-2 items-center">
				<Tooltip content="Copy public link">
					<button
						type="button"
						onClick={copy}
						className="group flex gap-2.5 items-center pr-2.5 pl-3 h-10 text-sm rounded-xl border transition-colors border-gray-4 bg-gray-2 hover:bg-gray-3 hover:border-gray-5"
					>
						<FontAwesomeIcon icon={faGlobe} className="text-blue-9 size-3" />
						<span className="max-w-[140px] truncate text-gray-11 sm:max-w-[220px]">
							{displayUrl}
						</span>
						<span className="flex justify-center items-center rounded-md transition-colors size-6 text-gray-10 group-hover:text-gray-12">
							<FontAwesomeIcon
								icon={copied ? faCheck : faCopy}
								className={copied ? "size-3 text-blue-11" : "size-3"}
							/>
						</span>
					</button>
				</Tooltip>
				{canManage && (
					<Button
						type="button"
						variant="gray"
						size="sm"
						disabled={isPending}
						onClick={() => setOpen(true)}
					>
						<FontAwesomeIcon icon={faSliders} className="size-3" />
						Customize
					</Button>
				)}
				{dialog}
			</div>
		);
	}

	return (
		<>
			<Button
				type="button"
				variant="gray"
				size="sm"
				disabled={isPending}
				onClick={() => setOpen(true)}
			>
				<FontAwesomeIcon icon={faGlobe} className="size-3" />
				Share
			</Button>
			{dialog}
		</>
	);
};
