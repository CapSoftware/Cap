"use client";

import { Button } from "@cap/ui";
import type { Folder, Space } from "@cap/web-domain";
import { faFolderPlus } from "@fortawesome/free-solid-svg-icons/faFolderPlus";
import { useState } from "react";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { SubfolderDialog } from "./SubfolderDialog";

interface NewSubfolderButtonProps {
	parentFolderId: Folder.FolderId;
	spaceId?: Space.SpaceIdOrOrganisationId;
}

export const NewSubfolderButton = ({
	parentFolderId,
	spaceId,
}: NewSubfolderButtonProps) => {
	const [openDialog, setOpenDialog] = useState(false);

	return (
		<>
			<Button
				onClick={() => setOpenDialog(true)}
				size="sm"
				variant="dark"
				className="flex gap-2 items-center"
			>
				<FontAwesomeIcon className="size-3.5" icon={faFolderPlus} />
				New Subfolder
			</Button>
			<SubfolderDialog
				open={openDialog}
				onOpenChange={setOpenDialog}
				parentFolderId={parentFolderId}
				spaceId={spaceId}
			/>
		</>
	);
};
