"use client";

import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { HttpClient } from "@effect/platform";
import {
	faChartSimple,
	faCopy,
	faDownload,
	faGear,
	faLock,
	faTrash,
	faUnlock,
	faVideo,
	faEllipsis
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Effect, Option } from "effect";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { PasswordDialog } from "@/app/(org)/dashboard/caps/components/PasswordDialog";
import { SettingsDialog } from "@/app/(org)/dashboard/caps/components/SettingsDialog";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";
import { Tooltip } from "@/components/Tooltip";
import { UpgradeModal } from "@/components/UpgradeModal";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";

interface ICapOptionsDropdownProps {
	videoId: Video.VideoId;
	videoName: string;
	hasPassword: boolean;
	isOwnerPro: boolean;
	settingsData?: OrganizationSettings;
	onDeleted?: () => void;
}

export const CapOptionsDropdown: React.FC<ICapOptionsDropdownProps> = ({
	videoId,
	videoName,
	hasPassword,
	isOwnerPro,
	settingsData,
	onDeleted,
}) => {
	const router = useRouter();
	const rpc = useRpcClient();

	const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
	const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
	const [passwordProtected, setPasswordProtected] = useState(hasPassword);
	const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);

	const downloadMutation = useEffectMutation({
		mutationFn: () =>
			Effect.gen(function* () {
				const result = yield* rpc.VideoGetDownloadInfo(videoId);
				const httpClient = yield* HttpClient.HttpClient;
				if (Option.isSome(result)) {
					const fetchResponse = yield* httpClient.get(result.value.downloadUrl);
					const blob = yield* fetchResponse.arrayBuffer;

					const blobUrl = window.URL.createObjectURL(new Blob([blob]));
					const link = document.createElement("a");
					link.href = blobUrl;
					link.download = result.value.fileName;
					link.style.display = "none";
					document.body.appendChild(link);
					link.click();
					document.body.removeChild(link);

					window.URL.revokeObjectURL(blobUrl);
				} else {
					throw new Error("Failed to get download URL");
				}
			}),
	});

	const deleteMutation = useEffectMutation({
		mutationFn: () => rpc.VideoDelete(videoId),
		onSuccess: () => {
			toast.success("Cap deleted successfully");
			setConfirmDeleteOpen(false);
			onDeleted?.();
			router.push("/dashboard/caps");
		},
		onError: () => {
			toast.error("Failed to delete cap");
		},
	});

	const duplicateMutation = useEffectMutation({
		mutationFn: () => rpc.VideoDuplicate(videoId),
		onSuccess: () => {
			toast.success("Cap duplicated successfully");
			router.refresh();
		},
	});

	const handleDownload = () => {
		if (downloadMutation.isPending) return;

		toast.promise(downloadMutation.mutateAsync(), {
			loading: "Preparing download...",
			success: "Download started successfully",
			error: (error) => {
				if (error instanceof Error) {
					return error.message;
				}
				return "Failed to download video - please try again.";
			},
		});
	};

	const handlePasswordUpdated = (protectedStatus: boolean) => {
		setPasswordProtected(protectedStatus);
		router.refresh();
	};

	return (
		<>
			<SettingsDialog
				isOpen={isSettingsDialogOpen}
				settingsData={settingsData}
				capId={videoId}
				onClose={() => setIsSettingsDialogOpen(false)}
				isPro={isOwnerPro}
			/>
			<PasswordDialog
				isOpen={isPasswordDialogOpen}
				onClose={() => setIsPasswordDialogOpen(false)}
				videoId={videoId}
				hasPassword={passwordProtected}
				onPasswordUpdated={handlePasswordUpdated}
			/>
			<ConfirmationDialog
				open={confirmDeleteOpen}
				icon={<FontAwesomeIcon icon={faVideo} />}
				title="Delete Cap"
				description={`Are you sure you want to delete the cap "${videoName}"? This action cannot be undone.`}
				confirmLabel={deleteMutation.isPending ? "Deleting..." : "Delete"}
				cancelLabel="Cancel"
				confirmVariant="destructive"
				loading={deleteMutation.isPending}
				onConfirm={() => deleteMutation.mutate()}
				onCancel={() => setConfirmDeleteOpen(false)}
			/>
			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
			<DropdownMenu modal={false}>
				<Tooltip
					content="Options"
					className="bg-gray-12 text-gray-1 border-gray-11 shadow-lg"
					delayDuration={100}
				>
					<DropdownMenuTrigger asChild>
						<Button
							variant="gray"
							className="rounded-full flex items-center justify-center"
						>
							<FontAwesomeIcon icon={faEllipsis} />
						</Button>
					</DropdownMenuTrigger>
				</Tooltip>
				<DropdownMenuContent align="end" sideOffset={5}>
					<DropdownMenuItem
						onClick={() => setIsSettingsDialogOpen(true)}
						className="flex gap-2 items-center rounded-lg"
					>
						<FontAwesomeIcon className="size-3" icon={faGear} />
						<span className="text-sm text-gray-12">Settings</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							router.push(`/dashboard/analytics?capId=${videoId}`);
						}}
						className="flex gap-2 items-center rounded-lg"
					>
						<FontAwesomeIcon className="size-3" icon={faChartSimple} />
						<span className="text-sm text-gray-12">View analytics</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={handleDownload}
						className="flex gap-2 items-center rounded-lg"
					>
						<FontAwesomeIcon className="size-3" icon={faDownload} />
						<span className="text-sm text-gray-12">Download</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							toast.promise(duplicateMutation.mutateAsync(), {
								loading: "Duplicating cap...",
								success: "Cap duplicated successfully",
								error: "Failed to duplicate cap",
							});
						}}
						disabled={duplicateMutation.isPending}
						className="flex gap-2 items-center rounded-lg"
					>
						<FontAwesomeIcon className="size-3" icon={faCopy} />
						<span className="text-sm text-gray-12">Duplicate</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							if (!isOwnerPro) setUpgradeModalOpen(true);
							else setIsPasswordDialogOpen(true);
						}}
						className="flex gap-2 items-center rounded-lg"
					>
						<FontAwesomeIcon
							className="size-3"
							icon={passwordProtected ? faLock : faUnlock}
						/>
						<span className="text-sm text-gray-12">
							{passwordProtected ? "Edit password" : "Add password"}
						</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => setConfirmDeleteOpen(true)}
						className="flex gap-2 items-center rounded-lg"
					>
						<FontAwesomeIcon className="size-3" icon={faTrash} />
						<span className="text-sm text-gray-12">Delete Cap</span>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
};
