"use client";

import { useState, useCallback } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  Avatar,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  Form,
  FormField,
  FormControl,
} from "@cap/ui";
import Image from "next/image";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faUserGroup, faPlus } from "@fortawesome/free-solid-svg-icons";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";

import { MemberSelect } from "./MemberSelect";
import { setSpaceMembers } from "../actions";
import { SpaceMemberData } from "../page";
import { useDashboardContext } from "../../../Contexts";

type MembersIndicatorProps = {
  memberCount: number;
  members: SpaceMemberData[];
  organizationMembers: SpaceMemberData[];
  spaceId: string;
  canManageMembers: boolean;
  onAddVideos?: () => void;
};

export const MembersIndicator = ({
  memberCount,
  members,
  organizationMembers,
  spaceId,
  canManageMembers,
  onAddVideos,
}: MembersIndicatorProps) => {
  const { user } = useDashboardContext();
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const formSchema = z.object({
    members: z.array(z.string().email("Invalid email address")).optional(),
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      members: members.map((m) => m.userId),
    },
  });

  const handleSaveMembers = async (selectedUserIds: string[]) => {
    if (!canManageMembers) return;

    // Compare selectedUserIds to current members' userIds (order-insensitive)
    const currentIds = members.map((m) => m.userId).sort();
    const selectedIds = (selectedUserIds ?? []).slice().sort();
    const noChange =
      currentIds.length === selectedIds.length &&
      currentIds.every((id, i) => id === selectedIds[i]);

    if (noChange) {
      toast.info("No changes were applied");
      return;
    }

    setIsLoading(true);
    try {
      await setSpaceMembers({
        spaceId,
        userIds: selectedUserIds ?? [],
        role: "member",
      });
      toast.success("Members updated!");
    } catch (error) {
      console.error("Failed to update members:", error);
      toast.error("Failed to update members");
    } finally {
      setIsLoading(false);
      setOpen(false);
    }
  };

  const OrgMembers = useCallback(
    (field: { value?: string[] }) => {
      return organizationMembers
        .filter(
          (m) => (field.value ?? []).includes(m.userId) && m.userId !== user.id
        )
        .map((m) => ({
          value: m.userId,
          label: m.name || m.email,
          image: m.image || undefined,
        }));
    },
    [organizationMembers, user]
  );

  return (
    <div className="flex gap-3 items-center mb-4">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="gray" size="sm" className="z-10">
            <FontAwesomeIcon className="mr-1 size-4" icon={faUserGroup} />
            {memberCount} members
          </Button>
        </DialogTrigger>
        <DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
          <DialogHeader
            icon={<FontAwesomeIcon icon={faUserGroup} />}
            description={
              canManageMembers
                ? "View and manage members of this space"
                : "View members of this space"
            }
          >
            <DialogTitle className="text-lg text-gray-12">
              Space Members: {memberCount}
            </DialogTitle>
          </DialogHeader>

          <div className="p-5">
            <div className="flex flex-col">
              {canManageMembers ? (
                <Form {...form}>
                  <div className="space-y-2 max-h-[320px] overflow-y-auto">
                    <FormField
                      control={form.control}
                      name="members"
                      render={({ field }) => {
                        return (
                          <FormControl>
                            <MemberSelect
                              placeholder="Add member..."
                              disabled={false}
                              canManageMembers={true}
                              showEmptyIfNoMembers={false}
                              selected={OrgMembers(field)}
                              onSelect={(selected) => {
                                field.onChange(
                                  selected.map((opt) => opt.value)
                                );
                              }}
                            />
                          </FormControl>
                        );
                      }}
                    />
                  </div>
                </Form>
              ) : (
                <div className="space-y-2 max-h-[320px] custom-scroll overflow-y-auto">
                  {/* Just display the list of members for non-managers */}
                  {members.map((member) => (
                    <div
                      key={member.userId}
                      className="flex gap-2 items-center p-3 rounded-lg border bg-gray-3 border-gray-4"
                    >
                      {member.image ? (
                        <Image
                          src={member.image}
                          alt={member.name || member.email}
                          width={24}
                          height={24}
                          className="rounded-full size-8"
                        />
                      ) : (
                        <Avatar
                          name={member.name || member.email}
                          className="size-8"
                        />
                      )}
                      <span className="text-sm text-gray-12">
                        {member.name || member.email}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="gray" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
            {canManageMembers && (
              <Button
                onClick={() =>
                  handleSaveMembers(form.getValues("members") ?? [])
                }
                disabled={isLoading}
                spinner={isLoading}
                variant="dark"
                size="sm"
              >
                Save
              </Button>
            )}
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
