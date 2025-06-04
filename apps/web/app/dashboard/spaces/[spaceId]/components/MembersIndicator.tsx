"use client";

import { useState } from "react";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import { Button } from "@cap/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@cap/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cap/ui";
import { Label } from "@cap/ui";
import { Trash2, UserPlus } from "lucide-react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTrash, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import {
  addSpaceMember,
  removeSpaceMember,
} from "@/app/dashboard/spaces/[spaceId]/actions";
import clsx from "clsx";
import { toast } from "sonner";

type SpaceMemberData = {
  id: string;
  userId: string;
  role: string;
  name: string | null;
  email: string;
};

type MembersIndicatorProps = {
  memberCount: number;
  members: SpaceMemberData[];
  organizationMembers: SpaceMemberData[];
  spaceId: string;
  canManageMembers: boolean;
};

export const MembersIndicator = ({
  memberCount,
  members,
  organizationMembers,
  spaceId,
  canManageMembers,
}: MembersIndicatorProps) => {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const availableOrgMembers = organizationMembers.filter(
    (orgMember) => !members.some((member) => member.userId === orgMember.userId)
  );

  const handleAddMember = async (userId: string) => {
    if (!canManageMembers) return;
    setIsLoading(true);
    try {
      await addSpaceMember({
        spaceId,
        userId,
        role: "member",
      });
      toast.success("Member added successfully");
    } catch (error) {
      console.error("Failed to add member:", error);
      toast.error("Failed to add member");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!canManageMembers) return;

    setIsLoading(true);
    try {
      await removeSpaceMember({
        memberId,
      });
      toast.success("Member removed successfully");
    } catch (error) {
      console.error("Failed to remove member:", error);
      toast.error("Failed to remove member");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <div className="relative mb-4">
          <Button variant="gray" size="md" className="z-10">
            <Avatar className="mr-1 w-5 h-5" name="Members" />
            {memberCount} members
          </Button>
        </div>
      </DialogTrigger>
      <DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader
          icon={<FontAwesomeIcon icon={faUserGroup} />}
          description="View and manage members of this space"
        >
          <DialogTitle className="text-lg text-gray-12">
            Space Members: {memberCount}
          </DialogTitle>
        </DialogHeader>

        <div className="p-5">
          <div
            className={clsx(
              "flex flex-col",
              members.length === 0 ? "space-y-0 py-2" : "space-y-4 py-0"
            )}
          >
            {members.length === 0 && (
              <p className="text-sm font-medium text-center">
                No members have been added
              </p>
            )}

            <div className="space-§-2 max-h-[320px] overflow-y-auto">
              {members.map((member) => (
                <div
                  key={member.id}
                  className="flex justify-between items-center p-3 rounded-xl border transition-colors bg-gray-1 border-gray-4 hover:bg-gray-3"
                >
                  <div className="flex gap-2 items-center">
                    <Avatar
                      letterClass="text-sm"
                      className="size-7"
                      name={member.name}
                    />
                    <div className="flex flex-col">
                      <span className="text-sm text-gray-12">
                        {member.name || member.email}
                      </span>
                      <span className="text-xs text-gray-10">
                        {member.email}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center">
                    {canManageMembers && (
                      <Button
                        variant="destructive"
                        className="p-0 size-9"
                        spinner={isLoading}
                        spinnerClass="mr-0"
                        onClick={() => handleRemoveMember(member.id)}
                        disabled={isLoading}
                      >
                        {!isLoading && (
                          <FontAwesomeIcon className="size-3" icon={faTrash} />
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="gray" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
          {canManageMembers && availableOrgMembers.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="dark" size="sm" disabled={isLoading}>
                  <UserPlus className="mr-1 w-4 h-4" />
                  Add Member
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="space-y-1 max-h-[250px] custom-scroll"
                align="end"
              >
                {availableOrgMembers.map((orgMember) => (
                  <div
                    key={orgMember.userId}
                    className="px-2 py-1.5 rounded-xl transition-colors hover:bg-gray-3 cursor-pointer"
                    onClick={() => handleAddMember(orgMember.userId)}
                  >
                    <div className="flex items-center">
                      <Avatar
                        letterClass="text-[11px]"
                        className="mr-2 size-4.5"
                        name={orgMember.name}
                      />
                      <p className="text-[13px]">
                        {orgMember.name || orgMember.email}
                      </p>
                    </div>
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
