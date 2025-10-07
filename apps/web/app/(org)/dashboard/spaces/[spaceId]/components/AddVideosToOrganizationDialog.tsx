"use client";

import type { Organisation } from "@cap/web-domain";
import type React from "react";
import { addVideosToOrganization } from "@/actions/organizations/add-videos";
import { getOrganizationVideoIds } from "@/actions/organizations/get-organization-videos";
import { removeVideosFromOrganization } from "@/actions/organizations/remove-videos";
import { getUserVideos } from "@/actions/videos/get-user-videos";
import AddVideosDialogBase from "./AddVideosDialogBase";

interface AddVideosToOrganizationDialogProps {
	open: boolean;
	onClose: () => void;
	organizationId: Organisation.OrganisationId;
	organizationName: string;
	onVideosAdded?: () => void;
}

export const AddVideosToOrganizationDialog: React.FC<
	AddVideosToOrganizationDialogProps
> = ({ open, onClose, organizationId, organizationName, onVideosAdded }) => {
	return (
		<AddVideosDialogBase
			open={open}
			onClose={onClose}
			entityId={organizationId}
			entityName={organizationName}
			onVideosAdded={onVideosAdded}
			removeVideos={removeVideosFromOrganization}
			addVideos={addVideosToOrganization}
			getVideos={getUserVideos}
			getEntityVideoIds={getOrganizationVideoIds}
		/>
	);
};

export default AddVideosToOrganizationDialog;
