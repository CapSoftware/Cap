"use client";

import { useDashboardContext } from "../../../Contexts";
import { Button, Input, Label } from "@cap/ui";
import { useState } from "react";
import { toast } from "sonner";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
import { useRouter } from "next/navigation";

const OrgName = () => {
  const { activeOrganization } = useDashboardContext();
  const [orgName, setOrgName] = useState(activeOrganization?.organization.name);
  const [saveLoading, setSaveLoading] = useState(false);
  const router = useRouter();

  const handleOrgNameChange = async () => {
    try {
      if (!orgName) return;
      setSaveLoading(true);
      await updateOrganizationDetails({
        organizationName: orgName,
        organizationId: activeOrganization?.organization.id as string,
      });
      toast.success("Settings updated successfully");
      router.refresh();
    } catch (error) {
      console.error("Error updating settings:", error);
      toast.error("An error occurred while updating settings");
    } finally {
      setSaveLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="organizationName">Name</Label>
        <p className="text-sm text-gray-10">
          Changing the name will update how your organization appears to
          others members.
        </p>
      </div>
      <div className="flex gap-3 items-center">
        <Input
          type="text"
          value={orgName}
          id="organizationName"
          name="organizationName"
          onChange={(e) => {
            setOrgName(e.target.value);
          }}
        />
        <Button
          type="submit"
          size="sm"
          className="min-w-fit"
          variant="dark"
          spinner={saveLoading}
          onClick={handleOrgNameChange}
          disabled={saveLoading || orgName === activeOrganization?.organization.name || !orgName}
        >
          {saveLoading ? null : "Save"}
        </Button>
      </div>
    </div>
  );
};

export default OrgName;
