"use client";

import React from "react";
import { getUserVideos } from "@/actions/videos/get-user-videos";
import { addVideosToOrganization } from "@/actions/organizations/add-videos";
import { removeVideosFromOrganization } from "@/actions/organizations/remove-videos";
import { getOrganizationVideoIds } from "@/actions/organizations/get-organization-videos";
import AddVideosDialogBase from "./AddVideosDialogBase";

interface AddVideosToOrganizationDialogProps {
  open: boolean;
  onClose: () => void;
  organizationId: string;
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
