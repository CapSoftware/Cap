"use client";

import React from "react";
import { getUserVideos } from "@/actions/videos/get-user-videos";
import { addVideosToSpace } from "@/actions/spaces/add-videos";
import { getSpaceVideoIds } from "@/actions/spaces/get-space-videos";
import AddVideosDialogBase from "./AddVideosDialogBase";

interface AddVideosDialogProps {
  open: boolean;
  onClose: () => void;
  spaceId: string;
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
      getVideos={getUserVideos}
      getEntityVideoIds={getSpaceVideoIds}
    />
  );
};

export default AddVideosDialog;
