"use client";

import { removeOrganizationIcon } from "@/actions/organization/remove-icon";
import { uploadOrganizationIcon } from "@/actions/organization/upload-organization-icon";
import { FileInput } from "@/components/FileInput";
import { CardDescription, Label } from "@cap/ui";
import { useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "../../../Contexts";

interface OrganizationIconProps {
  isOwner: boolean;
  showOwnerToast: () => void;
}

export const OrganizationIcon = ({
  isOwner,
  showOwnerToast,
}: OrganizationIconProps) => {
  const { activeOrganization } = useDashboardContext();
  const organizationId = activeOrganization?.organization.id;
  const existingIconUrl = activeOrganization?.organization.iconUrl;

  const [isUploading, setIsUploading] = useState(false);

  const handleFileChange = async (file: File | null) => {
    if (!isOwner) {
      showOwnerToast();
      return;
    }

    // If file is null, it means the user removed the file
    if (!file || !organizationId) return;

    // Upload the file to the server immediately
    try {
      setIsUploading(true);
      const formData = new FormData();
      formData.append("file", file);

      const result = await uploadOrganizationIcon(formData, organizationId);

      if (result.success) {
        toast.success("Organization icon updated successfully");
      }
    } catch (error) {
      console.error("Error uploading organization icon:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to upload icon"
      );
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveIcon = async () => {
    if (!isOwner || !organizationId) return;

    try {
      const result = await removeOrganizationIcon(organizationId);

      if (result.success) {
        toast.success("Organization icon removed successfully");
      }
    } catch (error) {
      console.error("Error removing organization icon:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to remove icon"
      );
    }
  };

  return (
    <div className="flex-1">
      <div className="space-y-1">
        <Label htmlFor="icon">Organization Icon</Label>
        <CardDescription className="w-full max-w-[400px]">
          Upload a custom logo or icon for your organization and make it unique.
        </CardDescription>
      </div>
      <div className="relative mt-4">
        <FileInput
          id="icon"
          name="icon"
          onChange={handleFileChange}
          disabled={!isOwner || isUploading}
          isLoading={isUploading}
          initialPreviewUrl={existingIconUrl || null}
          onRemove={handleRemoveIcon}
        />
      </div>
    </div>
  );
};
