"use client";

import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import {
  Button,
  Card,
  Input,
  Label
} from "@cap/ui";

interface OrganizationDetailsCardProps {
  isOwner: boolean;
  saveLoading: boolean;
  showOwnerToast: () => void;
  organizationName: string | undefined;
}

export const OrganizationDetailsCard = ({
  isOwner,
  saveLoading,
  showOwnerToast,
  organizationName
}: OrganizationDetailsCardProps) => {
  const { activeOrganization } = useSharedContext();

  return (
    <Card className="flex flex-col flex-1 justify-between w-full">
      <div className="flex flex-col gap-6 justify-center lg:flex-row">
        <div className="flex-1 w-full">
          <div className="space-y-1">
            <Label htmlFor="organizationName">Name</Label>
            <p className="text-sm text-gray-10">
              Changing the name will update how your organization appears to
              others members.
            </p>
          </div>
          <Input
            className="mt-4"
            type="text"
            defaultValue={organizationName as string}
            id="organizationName"
            name="organizationName"
            disabled={!isOwner}
            onChange={() => {
              if (!isOwner) showOwnerToast();
            }}
          />
        </div>
        <div className="flex-1 w-full">
          <div className="space-y-1">
            <Label htmlFor="allowedEmailDomain">Access email domain</Label>
            <p className="mt-1 text-sm text-gray-10">
              Only emails from this domain can access shared videos.{" "}
              <b>Leave blank to allow everyone.</b>
            </p>
          </div>
          <Input
            type="text"
            placeholder="e.g. company.com"
            defaultValue={
              activeOrganization?.organization.allowedEmailDomain || ""
            }
            id="allowedEmailDomain"
            name="allowedEmailDomain"
            disabled={!isOwner}
            className="mt-4"
            onChange={() => {
              if (!isOwner) showOwnerToast();
            }}
          />
        </div>
      </div>
      <Button
        className="mt-8 w-fit"
        type="submit"
        spinner={saveLoading}
        size="sm"
        variant="dark"
        disabled={!isOwner || saveLoading}
        onClick={() => {
          if (!isOwner) showOwnerToast();
        }}
      >
        {saveLoading ? "Saving..." : "Save"}
      </Button>
    </Card>
  );
};
