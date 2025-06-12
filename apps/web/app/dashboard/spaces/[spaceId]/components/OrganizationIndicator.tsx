"use client";

import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@cap/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faUserGroup,
  faPlus,
  faBuilding,
} from "@fortawesome/free-solid-svg-icons";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Avatar } from "@cap/ui";

export type OrganizationMemberData = {
  id: string;
  userId: string;
  role: string;
  image?: string | null;
  name: string | null;
  email: string;
};

type OrganizationIndicatorProps = {
  memberCount: number;
  members: OrganizationMemberData[];
  organizationId: string;
  organizationName: string;
  canManageMembers: boolean;
  onAddVideos?: () => void;
};

export const OrganizationIndicator = ({
  memberCount,
  members,
  organizationId,
  organizationName,
  canManageMembers,
  onAddVideos,
}: OrganizationIndicatorProps) => {
  const { user } = useSharedContext();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-3 mb-4">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="gray" size="sm" className="z-10">
            <FontAwesomeIcon className="mr-1 size-4" icon={faBuilding} />
            {memberCount} members
          </Button>
        </DialogTrigger>
        <DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
          <DialogHeader
            icon={<FontAwesomeIcon icon={faBuilding} />}
            description="View members of this organization"
          >
            <DialogTitle className="text-lg text-gray-12">
              {organizationName} Members: {memberCount}
            </DialogTitle>
          </DialogHeader>

          <div className="p-5">
            <div className="flex flex-col">
              <div className="space-y-3 max-h-[320px] overflow-y-auto">
                {members.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-3 transition-colors"
                  >
                    <Avatar
                      src={member.image || undefined}
                      alt={member.name || member.email}
                      size="sm"
                      fallback={(member.name || member.email)
                        .split(" ")
                        .map((n) => n[0])
                        .join("")
                        .toUpperCase()
                        .slice(0, 2)}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-12 truncate">
                        {member.name || member.email}
                      </p>
                      {member.name && (
                        <p className="text-xs text-gray-10 truncate">
                          {member.email}
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-gray-10 capitalize">
                      {member.role}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <div className="flex justify-between w-full">
              {canManageMembers && (
                <Button
                  variant="primary"
                  size="sm"
                  href="/dashboard/settings/organization"
                >
                  <FontAwesomeIcon className="mr-1 size-4" icon={faPlus} />
                  Invite members
                </Button>
              )}
              <Button variant="gray" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {onAddVideos && (
        <Button variant="dark" size="sm" onClick={onAddVideos}>
          <FontAwesomeIcon className="mr-1 size-4" icon={faPlus} />
          Add videos
        </Button>
      )}
    </div>
  );
};
