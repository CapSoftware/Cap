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
import { faUserGroup } from "@fortawesome/free-solid-svg-icons";
import {
  addSpaceMember,
  removeSpaceMember,
} from "@/app/dashboard/spaces/[spaceId]/actions";

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
      window.location.reload();
    } catch (error) {
      console.error("Failed to add member:", error);
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
      window.location.reload();
    } catch (error) {
      console.error("Failed to remove member:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <div className="relative mb-4">
          <Button variant="gray" size="sm" className=" z-10 hover:bg-accent">
            <Avatar className="h-5 w-5 mr-1" name="Members" />
            <span className="text-sm">{memberCount} members</span>
          </Button>
        </div>
      </DialogTrigger>
      <DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader
          icon={<FontAwesomeIcon icon={faUserGroup} />}
          description="View and manage members of this space"
        >
          <DialogTitle className="text-lg text-gray-12">
            Space Members
          </DialogTitle>
        </DialogHeader>

        <div className="p-5">
          <div className="flex flex-col space-y-4">
            <div className="flex justify-between items-center">
              <Label className="text-sm font-medium">
                Current Members ({members.length})
              </Label>
              {canManageMembers && availableOrgMembers.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="gray" size="sm" disabled={isLoading}>
                      <UserPlus className="h-4 w-4 mr-2" />
                      Add Member
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {availableOrgMembers.map((orgMember) => (
                      <DropdownMenuItem
                        key={orgMember.userId}
                        onClick={() => handleAddMember(orgMember.userId)}
                      >
                        <span className="flex items-center">
                          <Avatar
                            className="h-5 w-5 mr-2"
                            name={orgMember.name}
                          />
                          {orgMember.name || orgMember.email}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>

            <div className="space-y-2 max-h-[320px] overflow-y-auto">
              {members.map((member) => (
                <div
                  key={member.id}
                  className="flex justify-between items-center p-2 rounded-md hover:bg-gray-3"
                >
                  <div className="flex items-center gap-2">
                    <Avatar className="h-8 w-8" name={member.name} />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">
                        {member.name || member.email}
                      </span>
                      <span className="text-xs text-gray-10">
                        {member.email}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {canManageMembers && (
                      <Button
                        variant="gray"
                        size="icon"
                        className="text-gray-9 hover:text-destructive hover:bg-gray-4"
                        onClick={() => handleRemoveMember(member.id)}
                        disabled={isLoading}
                      >
                        <Trash2 className="h-4 w-4" />
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
                  <UserPlus className="h-4 w-4 mr-2" />
                  Add Member
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {availableOrgMembers.map((orgMember) => (
                  <DropdownMenuItem
                    key={orgMember.userId}
                    onClick={() => handleAddMember(orgMember.userId)}
                  >
                    <span className="flex items-center">
                      <Avatar className="h-5 w-5 mr-2" name={orgMember.name} />
                      {orgMember.name || orgMember.email}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
