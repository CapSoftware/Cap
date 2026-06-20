"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@cap/ui";
import type { Folder, Space } from "@cap/web-domain";
import { faFolder, faFolderPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { Option } from "effect";
import { useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { PublicCollectionField } from "../../_components/PublicCollectionField";
import { useDashboardContext } from "../../Contexts";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	spaceId?: Space.SpaceIdOrOrganisationId;
}

const FolderOptions = [
	{ value: "normal", label: "Normal", color: "#9ca3af" },
	{ value: "blue", label: "Blue", color: "#3b82f6" },
	{ value: "red", label: "Red", color: "#ef4444" },
	{ value: "yellow", label: "Yellow", color: "#eab308" },
] as const;

export const NewFolderDialog: React.FC<Props> = ({
	open,
	onOpenChange,
	spaceId,
}) => {
	const [selectedColor, setSelectedColor] = useState<
		(typeof FolderOptions)[number]["value"] | null
	>(null);
	const [folderName, setFolderName] = useState<string>("");
	const [publicEnabled, setPublicEnabled] = useState(false);
	const { activeOrganization, setUpgradeModalOpen } = useDashboardContext();
	const router = useRouter();

	useEffect(() => {
		if (!open) {
			setSelectedColor(null);
			setPublicEnabled(false);
		}
	}, [open]);

	const rpc = useRpcClient();

	const createFolder = useEffectMutation({
		mutationFn: (data: {
			name: string;
			color: Folder.FolderColor;
			public: boolean;
		}) =>
			rpc.FolderCreate({
				name: data.name,
				color: data.color,
				public: data.public,
				spaceId: Option.fromNullable(spaceId),
				parentId: Option.none(),
			}),
		onSuccess: () => {
			setFolderName("");
			setSelectedColor(null);
			onOpenChange(false);
			router.refresh();
			toast.success("Folder created successfully");
		},
		onError: () => {
			toast.error("Failed to create folder");
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[calc(100%-20px)]">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faFolderPlus} className="size-3.5" />}
				>
					<DialogTitle>New Folder</DialogTitle>
				</DialogHeader>
				<div className="p-5">
					<Input
						value={folderName}
						onChange={(e) => setFolderName(e.target.value)}
						required
						placeholder="Folder name"
					/>
					<div className="flex flex-wrap gap-2 mt-3">
						{FolderOptions.map((option) => {
							return (
								<button
									type="button"
									className={clsx(
										"flex flex-col flex-1 gap-2 items-center p-3 rounded-xl border transition-colors duration-200 cursor-pointer",
										selectedColor === option.value
											? "border-gray-12 bg-gray-3 hover:bg-gray-3 hover:border-gray-12"
											: "border-gray-4 hover:bg-gray-3 hover:border-gray-5 bg-transparent",
									)}
									key={`folder-${option.value}`}
									onClick={() => {
										if (selectedColor === option.value) {
											setSelectedColor(null);
											return;
										}
										setSelectedColor(option.value);
									}}
								>
									<FontAwesomeIcon
										icon={faFolder}
										style={{
											color: option.color,
											width: "40px",
											height: "40px",
										}}
									/>
									<span className="text-xs text-gray-10">{option.label}</span>
								</button>
							);
						})}
					</div>
					<div className="mt-4">
						<PublicCollectionField
							kind="folder"
							enabled={publicEnabled}
							onChange={setPublicEnabled}
							isPro={Boolean(activeOrganization?.ownerIsPro)}
							onUpgrade={() => setUpgradeModalOpen(true)}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button size="sm" variant="gray" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={() => {
							if (selectedColor === null) return;
							createFolder.mutate({
								name: folderName,
								color: selectedColor,
								public: publicEnabled,
							});
						}}
						size="sm"
						spinner={createFolder.isPending}
						variant="dark"
						disabled={
							!selectedColor ||
							!folderName.trim().length ||
							createFolder.isPending
						}
					>
						{createFolder.isPending ? "Creating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
