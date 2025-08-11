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
import Image from "next/image";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faBuilding } from "@fortawesome/free-solid-svg-icons";
import { Avatar } from "@cap/ui";
import clsx from "clsx";
import { useDashboardContext } from "../../../Contexts";

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
  organizationName: string;
  canManageMembers: boolean;
  onAddVideos?: () => void;
};

export const OrganizationIndicator = ({
  memberCount,
  members,
  organizationName,
  canManageMembers,
  onAddVideos,
}: OrganizationIndicatorProps) => {
  const { user } = useDashboardContext();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex gap-3 items-center">
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
              <div className="space-y-3 max-h-[320px] custom-scroll overflow-y-auto">
                {members
                  .sort((a, b) => b.role.localeCompare(a.role))
                  .map((member) => (
                    <div
                      key={member.id}
                      className="flex gap-3 items-center px-3 py-2 rounded-lg border transition-colors bg-gray-3 border-gray-4"
                    >
                      {member.image ? (
                        <Image
                          src={member.image}
                          alt={member.name || member.email}
                          width={36}
                          height={36}
                          className="rounded-full"
                        />
                      ) : (
                        <Avatar
                          letterClass="text-md"
                          name={member.name || member.email}
                          className="size-9 text-gray-12"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate text-gray-12">
                          {member.name || member.email}
                        </p>
                        {member.name && (
                          <p className="text-xs truncate text-gray-10">
                            {member.email}
                          </p>
                        )}
                      </div>
                      <p
                        className={clsx(
                          "px-2.5 py-1.5 text-xs font-medium capitalize text-white rounded-full",
                          member.role == "owner" ? "bg-blue-500" : "bg-gray-10"
                        )}
                      >
                        {member.role}
                      </p>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <div className={clsx("flex w-full", canManageMembers ? "justify-between" : "justify-end")}>
              {canManageMembers && (
                <Button
                  variant="dark"
                  size="sm"
                  href="/dashboard/settings/organization"
                >
                  <FontAwesomeIcon className="size-3" icon={faPlus} />
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
          <FontAwesomeIcon className="size-3" icon={faPlus} />
          Add videos
        </Button>
      )}
    </div>
  );
};
