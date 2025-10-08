"use client";

import { Button } from "@cap/ui";
import type { Folder } from "@cap/web-domain";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { addVideosToFolder } from "@/actions/folders/add-videos";
import { getFolderVideoIds } from "@/actions/folders/get-folder-videos";
import { removeVideosFromFolder } from "@/actions/folders/remove-videos";
import { getUserVideos } from "@/actions/spaces/get-user-videos";
import AddVideosDialogBase from "../../components/AddVideosDialogBase";

export default function AddVideosButton({
	folderId,
	folderName,
	spaceId,
}: {
	folderId: Folder.FolderId;
	folderName: string;
	spaceId: string;
}) {
	const [open, setOpen] = useState(false);
	const router = useRouter();

	return (
		<>
			<Button variant="dark" size="sm" onClick={() => setOpen(true)}>
				<FontAwesomeIcon className="size-3" icon={faPlus} />
				Add videos
			</Button>
			<AddVideosDialogBase
				open={open}
				onClose={() => setOpen(false)}
				entityId={folderId}
				entityName={folderName}
				onVideosAdded={() => {
					router.refresh();
				}}
				addVideos={(folderIdArg, videoIds) =>
					addVideosToFolder(folderIdArg, videoIds, spaceId)
				}
				removeVideos={removeVideosFromFolder}
				getVideos={() => getUserVideos(spaceId)}
				getEntityVideoIds={getFolderVideoIds}
			/>
		</>
	);
}
