"use client";

import { useState, useCallback } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  Form,
  FormField,
  FormControl,
} from "@cap/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faUserGroup, faPlus } from "@fortawesome/free-solid-svg-icons";
import { MemberSelect } from "./MemberSelect";
import { setSpaceMembers } from "@/app/dashboard/spaces/[spaceId]/actions";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { SpaceMemberData } from "../page";

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
  const { user } = useSharedContext();
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
    <div className="flex items-center gap-3 mb-4">
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
            description="View and manage members of this space"
          >
            <DialogTitle className="text-lg text-gray-12">
              Space Members: {memberCount}
            </DialogTitle>
          </DialogHeader>

          <div className="p-5">
            <div className="flex flex-col">
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
                            disabled={!canManageMembers}
                            showEmptyIfNoMembers
                            selected={OrgMembers(field)}
                            onSelect={(selected) => {
                              field.onChange(selected.map((opt) => opt.value));
                            }}
                          />
                        </FormControl>
                      );
                    }}
                  />
                </div>
              </Form>
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
          <FontAwesomeIcon className="mr-1 size-4" icon={faPlus} />
          Add videos
        </Button>
      )}
    </div>
  );
};
