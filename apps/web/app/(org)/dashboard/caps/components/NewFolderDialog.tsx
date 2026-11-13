"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
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
import { PublicCollectionField } from "../../_components/PublicCollectionField";
import { useDashboardContext } from "../../Contexts";
import { DEFAULT_FOLDER_COLOR, FolderDetailsFields } from "./FolderColorPicker";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	spaceId?: Space.SpaceIdOrOrganisationId;
}

export const NewFolderDialog: React.FC<Props> = ({
	open,
	onOpenChange,
	spaceId,
}) => {
	const [selectedColor, setSelectedColor] =
		useState<Folder.FolderColor>(DEFAULT_FOLDER_COLOR);
	const [folderName, setFolderName] = useState<string>("");
	const [publicEnabled, setPublicEnabled] = useState(false);
	const { activeOrganization, setUpgradeModalOpen } = useDashboardContext();
	const router = useRouter();

	useEffect(() => {
		if (!open) {
			setSelectedColor(DEFAULT_FOLDER_COLOR);
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
			setSelectedColor(DEFAULT_FOLDER_COLOR);
			onOpenChange(false);
			router.refresh();
			toast.success("Folder created");
		},
		onError: () => {
			toast.error("Failed to create folder");
		},
	});

	const name = folderName.trim();
	const canCreate = name.length > 0 && !createFolder.isPending;
	const submit = () => {
		if (!canCreate) return;
		createFolder.mutate({
			name: folderName,
			color: selectedColor,
			public: publicEnabled,
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[calc(100%-20px)] max-w-md">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faFolderPlus} className="size-3.5" />}
				>
					<DialogTitle>New folder</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3 p-5">
					<FolderDetailsFields
						name={folderName}
						onNameChange={setFolderName}
						color={selectedColor}
						onColorChange={setSelectedColor}
						onSubmit={submit}
						placeholder="Folder name"
						disabled={createFolder.isPending}
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
						spinner={createFolder.isPending}
						variant="dark"
						disabled={!canCreate}
					>
						{createFolder.isPending ? "Creating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
