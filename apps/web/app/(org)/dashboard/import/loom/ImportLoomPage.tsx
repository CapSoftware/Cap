"use client";

import {
	Button,
	Input,
	SelectContent,
	SelectItem,
	SelectRoot,
	SelectTrigger,
	SelectValue,
} from "@cap/ui";
import { Folder } from "@cap/web-domain";
import {
	faArrowLeft,
	faFileCsv,
	faLink,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { getLoomImportFolders, importFromLoom } from "@/actions/loom";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { UpgradeModal } from "@/components/UpgradeModal";
import type { LoomImportJobSummary } from "@/lib/loom-import/jobs";
import {
	type LoomImportDestination,
	loomImportDestinationHref,
	loomImportPageHref,
} from "@/lib/loom-import-destination";
import { buildMoveFolderDestinationRows } from "@/lib/move-items";
import {
	canManageOrganizationSettings,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { BulkImport } from "./_components/bulk-import";
import { LoomMark } from "./_components/doodles";
import { RecentImports } from "./_components/recent-imports";

type Mode = "single" | "csv";

const ROOT_FOLDER_VALUE = "__cap_root_folder__";

export const ImportLoomPage = ({
	initialDestination = {},
	recentJobs = [],
}: {
	initialDestination?: LoomImportDestination;
	recentJobs?: LoomImportJobSummary[];
}) => {
	const { user, activeOrganization, spacesData } = useDashboardContext();
	const router = useRouter();
	const searchParams = useSearchParams();
	const prefilledLoomUrl = searchParams?.get("url")?.trim() ?? "";
	const prefilledMode: Mode =
		searchParams?.get("mode") === "csv" ? "csv" : "single";

	const currentMember = activeOrganization?.members.find(
		(member) => member.userId === user?.id,
	);
	const currentRole = getEffectiveOrganizationRole({
		userId: user?.id,
		ownerId: activeOrganization?.organization.ownerId,
		memberRole: currentMember?.role,
	});
	const isAdmin = canManageOrganizationSettings(currentRole);

	const [mode, setMode] = useState<Mode>(prefilledMode);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);

	const [selectedFolderId, setSelectedFolderId] = useState(
		initialDestination.folderId ?? ROOT_FOLDER_VALUE,
	);
	const destinationInputId = useId();
	const orgId = activeOrganization?.organization.id;
	const spaceId = initialDestination.spaceId;
	const foldersQuery = useQuery({
		queryKey: ["loom-import-folders", user.id, orgId, spaceId],
		queryFn: () =>
			orgId ? getLoomImportFolders({ orgId, spaceId }) : Promise.resolve([]),
		enabled: Boolean(orgId) && mode === "single",
	});
	const folderRows = useMemo(
		() => buildMoveFolderDestinationRows(foldersQuery.data ?? []),
		[foldersQuery.data],
	);
	const destination: LoomImportDestination = {
		folderId:
			selectedFolderId === ROOT_FOLDER_VALUE
				? undefined
				: Folder.FolderId.make(selectedFolderId),
		spaceId,
	};
	const rootLabel = !spaceId
		? "My Caps"
		: spaceId === orgId
			? (activeOrganization?.organization.name ?? "Organization")
			: (spacesData?.find((space) => space.id === spaceId)?.name ?? "Space");
	const selectedFolder = folderRows.find(
		(folder) => folder.id === selectedFolderId,
	);
	const destinationAvailable =
		foldersQuery.isSuccess &&
		(selectedFolderId === ROOT_FOLDER_VALUE || Boolean(selectedFolder));
	const destinationLabel = selectedFolder
		? `${rootLabel} / ${selectedFolder.path}`
		: rootLabel;
	const importPageHref = loomImportPageHref(destination);

	const [loomUrl, setLoomUrl] = useState(prefilledLoomUrl);
	const [isImporting, setIsImporting] = useState(false);

	const isValidLoomUrl = (() => {
		try {
			const parsed = new URL(loomUrl.trim());
			return parsed.hostname.includes("loom.com");
		} catch {
			return false;
		}
	})();

	const handleSingleImport = async () => {
		if (!user || !activeOrganization) return;

		if (!user.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		if (!loomUrl.trim() || !destinationAvailable || isImporting) return;

		setIsImporting(true);

		try {
			const importResult = await importFromLoom({
				loomUrl: loomUrl.trim(),
				orgId: activeOrganization.organization.id,
				...destination,
			});

			if (!importResult?.success) {
				toast.error(importResult?.error || "Failed to import video.");
				setIsImporting(false);
				return;
			}

			toast.success(`Loom import started in ${destinationLabel}.`);
			router.push(loomImportDestinationHref(destination));
			router.refresh();
		} catch {
			toast.error("An unexpected error occurred. Please try again.");
		} finally {
			setIsImporting(false);
		}
	};

	return (
		<div className="flex flex-col w-full h-full">
			<div className="mb-8">
				<Link
					href={importPageHref}
					className="inline-flex gap-2 items-center mb-4 text-sm transition-colors text-gray-10 hover:text-gray-12"
				>
					<FontAwesomeIcon className="size-3" icon={faArrowLeft} />
					Back to Import
				</Link>
				<div className="flex gap-4 items-start">
					<div className="flex flex-shrink-0 justify-center items-center rounded-full size-12 bg-gray-3">
						<LoomMark size={20} />
					</div>
					<div>
						<h1 className="text-2xl font-medium text-gray-12">
							Import from Loom
						</h1>
						<p className="mt-1 max-w-xl text-sm text-gray-10">
							Bring one Loom over with a link, or move a whole library from a
							CSV. Titles and original recording dates come with them.
						</p>
					</div>
				</div>
			</div>

			<div className="flex flex-col gap-6 w-full max-w-4xl">
				<div
					role="tablist"
					aria-label="Loom import mode"
					className="flex gap-1 p-1 rounded-full border w-fit border-gray-3 bg-gray-2"
				>
					<ModeTab
						active={mode === "single"}
						icon={faLink}
						label="Single Video"
						onClick={() => setMode("single")}
					/>
					<ModeTab
						active={mode === "csv"}
						icon={faFileCsv}
						label="Bulk Import"
						onClick={() => setMode("csv")}
					/>
				</div>

				{mode === "single" ? (
					<div className="flex overflow-hidden flex-col rounded-xl border bg-gray-1 border-gray-3">
						<div className="flex flex-col gap-1 px-6 py-5 border-b border-gray-3">
							<p className="text-sm font-medium text-gray-12">Loom video URL</p>
							<p className="text-xs text-gray-10">
								Paste any Loom share link. The video downloads and processes in
								the background.
							</p>
						</div>

						<div className="flex flex-col gap-4 p-6">
							<Input
								value={loomUrl}
								onChange={(event) => setLoomUrl(event.target.value)}
								placeholder="https://www.loom.com/share/..."
								onKeyDown={(event) => {
									if (
										event.key === "Enter" &&
										isValidLoomUrl &&
										!isImporting &&
										destinationAvailable
									) {
										handleSingleImport();
									}
								}}
							/>

							<div className="flex flex-col gap-2">
								<label
									htmlFor={destinationInputId}
									className="text-sm font-medium text-gray-12"
								>
									Import to
								</label>
								<SelectRoot
									value={foldersQuery.isPending ? "" : selectedFolderId}
									onValueChange={setSelectedFolderId}
									disabled={
										foldersQuery.isPending ||
										foldersQuery.isError ||
										isImporting
									}
								>
									<SelectTrigger
										id={destinationInputId}
										className="w-full min-w-0 [&_span]:truncate"
									>
										<SelectValue
											placeholder={
												foldersQuery.isPending
													? "Loading folders..."
													: "Choose a destination"
											}
										/>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ROOT_FOLDER_VALUE}>
											{rootLabel}
										</SelectItem>
										{folderRows.map((folder) => (
											<SelectItem key={folder.id} value={folder.id}>
												{rootLabel} / {folder.path}
											</SelectItem>
										))}
									</SelectContent>
								</SelectRoot>
								{foldersQuery.isError ? (
									<div
										role="alert"
										className="flex flex-wrap gap-2 items-center text-sm text-red-11"
									>
										<p>
											We couldn't load this destination. Check your access or
											try again.
										</p>
										<Button
											type="button"
											size="sm"
											variant="gray"
											onClick={() => foldersQuery.refetch()}
											disabled={foldersQuery.isFetching}
										>
											Retry
										</Button>
										{spaceId && (
											<Link href="/dashboard/import/loom" className="underline">
												Import to My Caps instead
											</Link>
										)}
									</div>
								) : foldersQuery.isSuccess && !destinationAvailable ? (
									<p role="alert" className="text-sm text-red-11">
										This folder is no longer available. Choose another
										destination.
									</p>
								) : spaceId ? (
									<p className="text-xs text-gray-10">
										This video will be shared with {rootLabel}.
									</p>
								) : null}
							</div>

							<div className="flex flex-col-reverse gap-3 justify-end sm:flex-row">
								<Button
									type="button"
									size="sm"
									variant="gray"
									onClick={() => router.push(importPageHref)}
								>
									Cancel
								</Button>
								<Button
									type="button"
									onClick={handleSingleImport}
									size="sm"
									spinner={isImporting}
									variant="dark"
									disabled={
										!isValidLoomUrl || isImporting || !destinationAvailable
									}
								>
									{isImporting ? "Importing..." : "Import Loom"}
								</Button>
							</div>
						</div>
					</div>
				) : orgId ? (
					<BulkImport orgId={orgId} isAdmin={isAdmin} isPro={user.isPro} />
				) : null}

				{mode === "csv" && <RecentImports jobs={recentJobs} />}
			</div>

			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
		</div>
	);
};

const ModeTab = ({
	active,
	icon,
	label,
	onClick,
}: {
	active: boolean;
	icon: typeof faLink;
	label: string;
	onClick: () => void;
}) => (
	<button
		type="button"
		role="tab"
		aria-selected={active}
		onClick={onClick}
		className={clsx(
			"relative flex items-center gap-2 px-4 h-9 rounded-full text-sm font-medium transition-colors",
			active
				? "text-gray-12"
				: "text-gray-10 hover:text-gray-12 cursor-pointer",
		)}
	>
		{active && (
			<motion.span
				layoutId="loom-mode-indicator"
				className="absolute inset-0 rounded-full border shadow-sm bg-gray-1 border-gray-4"
				transition={{ type: "spring", stiffness: 500, damping: 35 }}
			/>
		)}
		<FontAwesomeIcon icon={icon} className="relative size-3.5" />
		<span className="relative">{label}</span>
	</button>
);
