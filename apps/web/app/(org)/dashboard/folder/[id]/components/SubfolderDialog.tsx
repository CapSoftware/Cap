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
import { faFolderPlus } from "@fortawesome/free-solid-svg-icons/faFolderPlus";
import { Option } from "effect";
import { useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { PublicCollectionField } from "../../../_components/PublicCollectionField";
import { useDashboardContext } from "../../../Contexts";
import {
	DEFAULT_FOLDER_COLOR,
	FolderColorPicker,
} from "../../../caps/components/FolderColorPicker";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	parentFolderId: Folder.FolderId;
	spaceId?: Space.SpaceIdOrOrganisationId;
}

export const SubfolderDialog: React.FC<Props> = ({
	open,
	onOpenChange,
	parentFolderId,
	spaceId,
}) => {
	const [selectedColor, setSelectedColor] =
		useState<Folder.FolderColor>(DEFAULT_FOLDER_COLOR);
	const [folderName, setFolderName] = useState<string>("");
	const [publicEnabled, setPublicEnabled] = useState(false);
	const { activeSpace, activeOrganization, setUpgradeModalOpen } =
		useDashboardContext();
	const router = useRouter();

	useEffect(() => {
		if (!open) {
			setSelectedColor(DEFAULT_FOLDER_COLOR);
			setFolderName("");
			setPublicEnabled(false);
		}
	}, [open]);

	const rpc = useRpcClient();

	const createSubfolder = useEffectMutation({
		mutationFn: (data: {
			name: string;
			color: Folder.FolderColor;
			public: boolean;
		}) =>
			rpc.FolderCreate({
				name: data.name,
				color: data.color,
				public: data.public,
				spaceId: Option.fromNullable(spaceId ?? activeSpace?.id),
				parentId: Option.some(parentFolderId),
			}),
		onSuccess: () => {
			setFolderName("");
			setSelectedColor(DEFAULT_FOLDER_COLOR);
			onOpenChange(false);
			router.refresh();
			toast.success("Subfolder created");
		},
		onError: () => {
			toast.error("Failed to create subfolder");
		},
	});

	const canCreate = folderName.trim().length > 0 && !createSubfolder.isPending;
	const submit = () => {
		if (!canCreate) return;
		createSubfolder.mutate({
			name: folderName,
			color: selectedColor,
			public: publicEnabled,
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[calc(100%-20px)]">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faFolderPlus} className="size-3.5" />}
				>
					<DialogTitle>New subfolder</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3 p-5">
					<Input
						autoFocus
						value={folderName}
						onChange={(e) => setFolderName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
							e.preventDefault();
							submit();
						}}
						required
						placeholder="Subfolder name"
						aria-label="Subfolder name"
					/>
					<FolderColorPicker
						value={selectedColor}
						onChange={setSelectedColor}
						disabled={createSubfolder.isPending}
					/>
					<PublicCollectionField
						kind="folder"
						enabled={publicEnabled}
						onChange={setPublicEnabled}
						isPro={Boolean(activeOrganization?.ownerIsPro)}
						onUpgrade={() => setUpgradeModalOpen(true)}
					/>
				</div>
				<DialogFooter>
					<Button size="sm" variant="gray" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={submit}
						size="sm"
						spinner={createSubfolder.isPending}
						variant="dark"
						disabled={!canCreate}
					>
						{createSubfolder.isPending ? "Creating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
