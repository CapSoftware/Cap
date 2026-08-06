"use client";

import {
	Button,
	Card,
	CardHeader,
	CardTitle,
	Input,
	LoadingSpinner,
	Select,
} from "@cap/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
	AlertTriangle,
	ArrowRight,
	Building2,
	CheckCircle2,
	Folder,
	FolderTree,
	RefreshCw,
	Search,
	ShieldCheck,
	UserRound,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type getContentManagementSetup,
	getContentTransferFolders,
	getContentTransferOperations,
	getContentTransferPreview,
	startContentTransfer,
} from "@/actions/organization/content-transfer";
import {
	type ContentTransferSource,
	isContentTransferProgress,
} from "@/lib/content-transfer";

type ContentManagementSetup = Awaited<
	ReturnType<typeof getContentManagementSetup>
>;

type ContentTransferPreview = Awaited<
	ReturnType<typeof getContentTransferPreview>
>;

function sourceFromKey(key: string): ContentTransferSource {
	if (key === "organization") return { type: "organization" };
	return { type: "space", spaceId: key.replace(/^space:/, "") };
}

function operationLabel(state: "queued" | "running" | "succeeded" | "failed") {
	if (state === "queued") return "Queued";
	if (state === "running") return "In progress";
	if (state === "succeeded") return "Completed";
	return "Needs attention";
}

function operationStatusClass(
	state: "queued" | "running" | "succeeded" | "failed",
) {
	if (state === "succeeded") return "bg-green-3 text-green-11";
	if (state === "failed") return "bg-red-3 text-red-11";
	return "bg-blue-3 text-blue-11";
}

function PreviewSummary({ preview }: { preview: ContentTransferPreview }) {
	const stats = [
		{ label: "Caps", value: preview.videoCount },
		{ label: "Folders", value: preview.folderCount },
		{ label: "Current owners", value: preview.ownerCount },
		{ label: "Folders to create", value: preview.foldersToCreate },
	];

	return (
		<div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-gray-4 border-gray-4 sm:grid-cols-4">
			{stats.map((stat) => (
				<div key={stat.label} className="p-3 bg-gray-1">
					<p className="text-xl font-medium tabular-nums text-gray-12">
						{stat.value.toLocaleString()}
					</p>
					<p className="mt-1 text-xs text-gray-10">{stat.label}</p>
				</div>
			))}
		</div>
	);
}

export function ContentManagement({
	initialSetup,
}: {
	initialSetup: ContentManagementSetup;
}) {
	const queryClient = useQueryClient();
	const confirmationId = useId();
	const [sourceKey, setSourceKey] = useState("organization");
	const [sourceFolderId, setSourceFolderId] = useState<string | null>(null);
	const [targetUserId, setTargetUserId] = useState<string | null>(null);
	const [folderSearch, setFolderSearch] = useState("");
	const [memberSearch, setMemberSearch] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const source = useMemo(() => sourceFromKey(sourceKey), [sourceKey]);
	const sourceOptions = [
		{
			value: "organization",
			label: "All organization",
			icon: <Building2 />,
		},
		...initialSetup.spaces.map((space) => ({
			value: `space:${space.id}`,
			label: space.name,
			icon: <FolderTree />,
		})),
	];

	const foldersQuery = useQuery({
		queryKey: ["content-transfer-folders", sourceKey],
		queryFn: () => getContentTransferFolders(source),
		staleTime: 10_000,
	});
	const normalizedFolderSearch = folderSearch.trim().toLocaleLowerCase();
	const filteredFolders = useMemo(
		() =>
			(foldersQuery.data ?? []).filter((folder) =>
				normalizedFolderSearch
					? folder.path.toLocaleLowerCase().includes(normalizedFolderSearch)
					: true,
			),
		[foldersQuery.data, normalizedFolderSearch],
	);
	const normalizedMemberSearch = memberSearch.trim().toLocaleLowerCase();
	const filteredMembers = useMemo(
		() =>
			initialSetup.members.filter((member) => {
				if (!normalizedMemberSearch) return true;
				return `${member.name} ${member.email}`
					.toLocaleLowerCase()
					.includes(normalizedMemberSearch);
			}),
		[initialSetup.members, normalizedMemberSearch],
	);
	const target = initialSetup.members.find(
		(member) => member.id === targetUserId,
	);

	const previewQuery = useQuery({
		queryKey: [
			"content-transfer-preview",
			sourceKey,
			sourceFolderId,
			targetUserId,
		],
		queryFn: () => {
			if (!sourceFolderId || !targetUserId) {
				throw new Error("Choose a source folder and destination member");
			}
			return getContentTransferPreview({
				source,
				sourceRootFolderId: sourceFolderId,
				targetUserId,
			});
		},
		enabled: Boolean(sourceFolderId && targetUserId),
		retry: false,
		staleTime: 0,
	});

	const operationsQuery = useQuery({
		queryKey: ["content-transfer-operations"],
		queryFn: getContentTransferOperations,
		initialData: initialSetup.operations,
		refetchInterval: (query) =>
			query.state.data?.some(
				(operation) =>
					operation.state === "queued" || operation.state === "running",
			)
				? 3_000
				: false,
	});
	const activeOperation = operationsQuery.data.find(
		(operation) =>
			operation.state === "queued" || operation.state === "running",
	);

	const transferMutation = useMutation({
		mutationFn: async () => {
			const preview = previewQuery.data;
			if (!sourceFolderId || !targetUserId || !preview) {
				throw new Error("Review the transfer first");
			}
			return startContentTransfer({
				source,
				sourceRootFolderId: sourceFolderId,
				targetUserId,
				previewToken: preview.previewToken,
			});
		},
		onSuccess: async () => {
			toast.success("Content transfer started");
			setConfirmation("");
			await queryClient.invalidateQueries({
				queryKey: ["content-transfer-operations"],
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Unable to start transfer",
			);
			previewQuery.refetch();
		},
	});

	const preview = previewQuery.data;
	const confirmationMatches =
		Boolean(target) &&
		confirmation.trim().toLocaleLowerCase() ===
			target?.email.toLocaleLowerCase();
	const canStart =
		Boolean(preview) &&
		preview?.blockedReasons.length === 0 &&
		confirmationMatches &&
		!activeOperation &&
		!transferMutation.isPending;

	return (
		<div className="flex flex-col gap-6">
			<Card>
				<CardHeader>
					<CardTitle>Content management</CardTitle>
				</CardHeader>

				<div className="grid gap-5 mt-5 lg:grid-cols-[minmax(0,1fr)_40px_minmax(0,1fr)]">
					<div className="min-w-0">
						<div className="flex gap-2 items-center mb-3">
							<FolderTree className="size-4 text-gray-10" />
							<h2 className="text-sm font-medium text-gray-12">
								Source folder
							</h2>
						</div>
						<Select
							value={sourceKey}
							onValueChange={(value) => {
								setSourceKey(value);
								setSourceFolderId(null);
								setFolderSearch("");
								setConfirmation("");
							}}
							options={sourceOptions}
							placeholder="Choose a source"
							variant="light"
							className="w-full"
						/>
						<div className="relative mt-3">
							<Search className="absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-gray-9" />
							<Input
								value={folderSearch}
								onChange={(event) => setFolderSearch(event.target.value)}
								placeholder="Search folders"
								className="pl-9"
							/>
						</div>
						<div className="overflow-y-auto mt-2 h-72 rounded-lg border bg-gray-2 border-gray-4 custom-scroll">
							{foldersQuery.isLoading ? (
								<div className="flex justify-center items-center h-full">
									<LoadingSpinner size={24} />
								</div>
							) : foldersQuery.isError ? (
								<div className="flex flex-col gap-3 justify-center items-center h-full">
									<p className="text-sm text-gray-10">Unable to load folders</p>
									<Button
										variant="gray"
										size="sm"
										onClick={() => foldersQuery.refetch()}
									>
										<RefreshCw className="size-4" />
										Retry
									</Button>
								</div>
							) : filteredFolders.length === 0 ? (
								<div className="flex justify-center items-center px-5 h-full text-sm text-gray-10">
									No folders found
								</div>
							) : (
								<div className="py-1">
									{filteredFolders.map((folder) => (
										<button
											type="button"
											key={folder.id}
											onClick={() => {
												setSourceFolderId(folder.id);
												setConfirmation("");
											}}
											className={clsx(
												"flex gap-3 items-center px-3 w-full h-11 text-left transition-colors",
												sourceFolderId === folder.id
													? "bg-blue-3"
													: "hover:bg-gray-3",
											)}
										>
											<Folder className="shrink-0 size-4 text-gray-10" />
											<span className="flex-1 min-w-0 text-sm truncate text-gray-12">
												{folder.path}
											</span>
											<span className="shrink-0 text-xs tabular-nums text-gray-9">
												{folder.videoCount.toLocaleString()}
											</span>
										</button>
									))}
								</div>
							)}
						</div>
					</div>

					<div className="hidden justify-center items-center lg:flex">
						<ArrowRight className="size-5 text-gray-8" />
					</div>

					<div className="min-w-0">
						<div className="flex gap-2 items-center mb-3">
							<UserRound className="size-4 text-gray-10" />
							<h2 className="text-sm font-medium text-gray-12">
								Destination member
							</h2>
						</div>
						<div className="flex items-center px-3 h-11 rounded-lg border bg-gray-2 border-gray-4">
							<UserRound className="mr-2 size-4 text-gray-9" />
							<span className="text-sm text-gray-11">Personal library</span>
						</div>
						<div className="relative mt-3">
							<Search className="absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-gray-9" />
							<Input
								value={memberSearch}
								onChange={(event) => setMemberSearch(event.target.value)}
								placeholder="Search members"
								className="pl-9"
							/>
						</div>
						<div className="overflow-y-auto mt-2 h-72 rounded-lg border bg-gray-2 border-gray-4 custom-scroll">
							{filteredMembers.length === 0 ? (
								<div className="flex justify-center items-center px-5 h-full text-sm text-gray-10">
									No members found
								</div>
							) : (
								<div className="py-1">
									{filteredMembers.map((member) => (
										<button
											type="button"
											key={member.id}
											onClick={() => {
												setTargetUserId(member.id);
												setConfirmation("");
											}}
											className={clsx(
												"flex gap-3 items-center px-3 w-full h-12 text-left transition-colors",
												targetUserId === member.id
													? "bg-blue-3"
													: "hover:bg-gray-3",
											)}
										>
											<div className="flex shrink-0 justify-center items-center size-7 text-xs font-medium rounded-full bg-gray-4 text-gray-11">
												{member.name.slice(0, 1).toUpperCase()}
											</div>
											<span className="min-w-0">
												<span className="block text-sm truncate text-gray-12">
													{member.name}
												</span>
												<span className="block text-xs truncate text-gray-9">
													{member.email}
												</span>
											</span>
										</button>
									))}
								</div>
							)}
						</div>
					</div>
				</div>

				{sourceFolderId && targetUserId && (
					<div className="pt-5 mt-5 border-t border-gray-4">
						{previewQuery.isLoading || previewQuery.isFetching ? (
							<div className="flex gap-3 justify-center items-center h-32 text-sm text-gray-10">
								<LoadingSpinner size={22} />
								Reviewing transfer
							</div>
						) : previewQuery.isError ? (
							<div className="flex gap-3 justify-between items-center p-4 rounded-lg border bg-red-2 border-red-4">
								<p className="text-sm text-red-11">
									{previewQuery.error instanceof Error
										? previewQuery.error.message
										: "Unable to review transfer"}
								</p>
								<Button
									variant="gray"
									size="sm"
									onClick={() => previewQuery.refetch()}
								>
									<RefreshCw className="size-4" />
									Retry
								</Button>
							</div>
						) : preview ? (
							<div className="flex flex-col gap-4">
								<div className="flex gap-3 items-start">
									<ShieldCheck className="mt-0.5 shrink-0 size-5 text-blue-10" />
									<div className="min-w-0">
										<p className="text-sm font-medium text-gray-12">
											{preview.sourceFolderPath} to {preview.target.email}
										</p>
										<p className="mt-1 text-xs leading-5 text-gray-10">
											Ownership and media paths will change. Existing links,
											metadata, comments, and analytics remain attached to each
											Cap.
										</p>
									</div>
								</div>
								<PreviewSummary preview={preview} />

								{preview.publicFolderCount > 0 && (
									<div className="flex gap-3 items-start p-3 rounded-lg border bg-amber-2 border-amber-4">
										<AlertTriangle className="mt-0.5 shrink-0 size-4 text-amber-10" />
										<p className="text-xs leading-5 text-amber-11">
											{preview.publicFolderCount} public folder
											{preview.publicFolderCount === 1 ? "" : "s"} will become
											private in the destination library.
										</p>
									</div>
								)}

								{preview.blockedReasons.length > 0 && (
									<div className="p-3 rounded-lg border bg-red-2 border-red-4">
										{preview.blockedReasons.map((reason) => (
											<div key={reason} className="flex gap-2 items-start">
												<AlertTriangle className="mt-0.5 shrink-0 size-4 text-red-10" />
												<p className="text-xs leading-5 text-red-11">
													{reason}
												</p>
											</div>
										))}
										{preview.blockedVideos.slice(0, 5).map((video) => (
											<p
												key={video.videoId}
												className="mt-1 ml-6 text-xs text-red-10"
											>
												{video.name}: {video.reason}
											</p>
										))}
									</div>
								)}

								<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
									<div className="flex-1 min-w-0">
										<label
											htmlFor={confirmationId}
											className="block mb-2 text-xs font-medium text-gray-11"
										>
											Type {preview.target.email} to confirm
										</label>
										<Input
											id={confirmationId}
											value={confirmation}
											onChange={(event) => setConfirmation(event.target.value)}
											autoComplete="off"
											placeholder={preview.target.email}
										/>
									</div>
									<Button
										variant="dark"
										disabled={!canStart}
										spinner={transferMutation.isPending}
										onClick={() => transferMutation.mutate()}
										className="shrink-0 sm:min-w-44"
									>
										<ArrowRight className="size-4" />
										{activeOperation
											? "Transfer in progress"
											: "Start transfer"}
									</Button>
								</div>
							</div>
						) : null}
					</div>
				)}
			</Card>

			<Card>
				<div className="flex gap-3 justify-between items-start">
					<CardHeader>
						<CardTitle>Transfer history</CardTitle>
					</CardHeader>
					<Button
						variant="gray"
						size="sm"
						onClick={() => operationsQuery.refetch()}
						disabled={operationsQuery.isFetching}
						className="shrink-0"
					>
						<RefreshCw
							className={clsx(
								"size-4",
								operationsQuery.isFetching && "animate-spin",
							)}
						/>
						Refresh
					</Button>
				</div>

				<div className="mt-5 overflow-hidden rounded-lg border border-gray-4">
					{operationsQuery.data.length === 0 ? (
						<div className="flex justify-center items-center h-28 text-sm text-gray-10">
							No transfers yet
						</div>
					) : (
						operationsQuery.data.map((operation, index) => {
							const progress = isContentTransferProgress(operation.result)
								? operation.result
								: null;
							const percent = progress?.totalVideos
								? Math.round(
										(progress.processedVideos / progress.totalVideos) * 100,
									)
								: operation.state === "succeeded"
									? 100
									: 0;

							return (
								<div
									key={operation.id}
									className={clsx(
										"p-4 bg-gray-1",
										index > 0 && "border-t border-gray-4",
									)}
								>
									<div className="flex flex-wrap gap-3 justify-between items-center">
										<div className="flex gap-3 items-center min-w-0">
											{operation.state === "succeeded" ? (
												<CheckCircle2 className="shrink-0 size-4 text-green-10" />
											) : operation.state === "failed" ? (
												<AlertTriangle className="shrink-0 size-4 text-red-10" />
											) : (
												<LoadingSpinner size={16} />
											)}
											<div className="min-w-0">
												<p className="text-sm font-medium text-gray-12">
													{progress
														? `${progress.processedVideos.toLocaleString()} of ${progress.totalVideos.toLocaleString()} Caps`
														: "Content transfer"}
												</p>
												<p className="mt-0.5 text-xs text-gray-9">
													{new Date(operation.createdAt).toLocaleString()}
												</p>
											</div>
										</div>
										<span
											className={clsx(
												"px-2 py-1 text-xs font-medium rounded-md",
												operationStatusClass(operation.state),
											)}
										>
											{operationLabel(operation.state)}
										</span>
									</div>

									{progress && (
										<>
											<div className="overflow-hidden mt-3 h-1.5 rounded-full bg-gray-4">
												<div
													className={clsx(
														"h-full transition-[width] duration-300",
														operation.state === "failed"
															? "bg-red-9"
															: operation.state === "succeeded"
																? "bg-green-9"
																: "bg-blue-9",
													)}
													style={{ width: `${Math.min(100, percent)}%` }}
												/>
											</div>
											<div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-9">
												<span>
													{progress.copiedObjects.toLocaleString()} objects
													copied
												</span>
												<span>
													{progress.transferredVideos.toLocaleString()}{" "}
													ownership changes
												</span>
												{progress.cleanupWarnings.length > 0 && (
													<span className="text-amber-10">
														{progress.cleanupWarnings.length} cleanup warning
														{progress.cleanupWarnings.length === 1 ? "" : "s"}
													</span>
												)}
											</div>
										</>
									)}

									{operation.errorMessage && (
										<p className="mt-2 text-xs leading-5 text-red-10">
											{operation.errorMessage}
										</p>
									)}
								</div>
							);
						})
					)}
				</div>
			</Card>
		</div>
	);
}
