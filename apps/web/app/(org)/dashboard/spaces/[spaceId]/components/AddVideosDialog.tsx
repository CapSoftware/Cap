"use client";

import type { Space } from "@cap/web-domain";
import type React from "react";
import { addVideosToSpace } from "@/actions/spaces/add-videos";
import { getSpaceVideoIds } from "@/actions/spaces/get-space-videos";
import { getUserVideos } from "@/actions/spaces/get-user-videos";
import { removeVideosFromSpace } from "@/actions/spaces/remove-videos";
import AddVideosDialogBase from "./AddVideosDialogBase";

interface AddVideosDialogProps {
	open: boolean;
	onClose: () => void;
	spaceId: Space.SpaceIdOrOrganisationId;
	spaceName: string;
	onVideosAdded?: () => void;
}

export const AddVideosDialog: React.FC<AddVideosDialogProps> = ({
	open,
	onClose,
	spaceId,
	spaceName,
	onVideosAdded,
}) => {
	return (
		<AddVideosDialogBase
			open={open}
			onClose={onClose}
			entityId={spaceId}
			entityName={spaceName}
			onVideosAdded={onVideosAdded}
			addVideos={addVideosToSpace}
			removeVideos={removeVideosFromSpace}
			getVideos={getUserVideos}
			getEntityVideoIds={getSpaceVideoIds}
		/>
	);
};

export default AddVideosDialog;
