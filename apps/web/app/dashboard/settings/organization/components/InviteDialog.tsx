"use client";

import { sendOrganizationInvites } from "@/actions/organization/send-invites";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@cap/ui";
import { faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

interface InviteDialogProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  isOwner: boolean;
  showOwnerToast: () => void;
  handleManageBilling: () => Promise<void>;
}

export const InviteDialog = ({
  isOpen,
  setIsOpen,
  isOwner,
  showOwnerToast,
  handleManageBilling,
}: InviteDialogProps) => {
  const router = useRouter();
  const { activeOrganization } = useSharedContext();
  const [inviteEmails, setInviteEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [upgradeLoading, setUpgradeLoading] = useState(false);

  const inviteQuota = activeOrganization?.inviteQuota ?? 1;
  const totalInvites = activeOrganization?.totalInvites ?? 0;
  const adjustedTotalInvites = Math.min(totalInvites, inviteQuota + 1);
  const remainingSeats = Math.max(0, inviteQuota - adjustedTotalInvites);

  const handleAddEmails = () => {
    const newEmails = emailInput
      .split(",")
      .map((email) => email.trim())
      .filter((email) => email !== "");

    if (inviteEmails.length + newEmails.length > remainingSeats) {
      toast.error(
        `Not enough seats available. You have ${remainingSeats} seats remaining.`
      );
      return;
    }

    setInviteEmails([...new Set([...inviteEmails, ...newEmails])]);
    setEmailInput("");
  };

  const handleRemoveEmail = (email: string) => {
    setInviteEmails(inviteEmails.filter((e) => e !== email));
  };

  const handleUpgradePlan = async () => {
    if (!isOwner) {
      showOwnerToast();
      return;
    }

    setUpgradeLoading(true);
    setIsOpen(false);
    try {
      await handleManageBilling();
    } catch (error) {
      setUpgradeLoading(false);
    }
  };

  const handleSendInvites = async () => {
    if (!isOwner) {
      showOwnerToast();
      return;
    }

    if (inviteEmails.length > remainingSeats) {
      toast.error(
        `Not enough seats available. You have ${remainingSeats} seats remaining.`
      );
      return;
    }

    try {
      setInviteLoading(true);
      await sendOrganizationInvites(
        inviteEmails,
        activeOrganization?.organization.id as string
      );
      toast.success("Invites sent successfully");
      setInviteEmails([]);
      setIsOpen(false);
      router.refresh();
    } catch (error) {
      console.error("Error sending invites:", error);
      toast.error("An error occurred while sending invites");
    } finally {
      setInviteLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader
          icon={<FontAwesomeIcon icon={faUserGroup} className="size-3.5" />}
          description="Invite your teammates to join the organization"
        >
          <DialogTitle>
            Invite to{" "}
            <span className="font-bold text-gray-12">
              {activeOrganization?.organization.name}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="p-5">
          {remainingSeats > 0 ? (
            <>
              <Input
                id="emails"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="name@company.com"
                onBlur={handleAddEmails}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    handleAddEmails();
                  }
                }}
              />
              <div className="flex overflow-y-auto flex-col gap-2.5 mt-4 max-h-60">
                {inviteEmails.map((email) => (
                  <div
                    key={email}
                    className="flex justify-between items-center p-3 rounded-xl border transition-colors duration-200 cursor-pointer border-gray-3"
                  >
                    <span className="text-sm text-gray-12">{email}</span>
                    <Button
                      style={
                        {
                          "--gradient-border-radius": "8px",
                        } as React.CSSProperties
                      }
                      type="button"
                      variant="destructive"
                      size="xs"
                      onClick={() => handleRemoveEmail(email)}
                      disabled={!isOwner}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2 p-4 rounded-xl border bg-amber-50 border-amber-200">
              <p className="text-amber-800 font-medium">No Seats Available</p>
              <p className="text-sm text-amber-700">
                You've reached your seat limit. Please upgrade your plan or
                remove existing members to invite new ones.
              </p>
              <Button
                type="button"
                size="sm"
                variant="dark"
                className="mt-2 self-start"
                spinner={upgradeLoading}
                disabled={upgradeLoading || !isOwner}
                onClick={handleUpgradePlan}
              >
                Upgrade Plan
              </Button>
            </div>
          )}
        </div>
        <DialogFooter className="p-5 border-t border-gray-4">
          <Button
            type="button"
            size="sm"
            variant="gray"
            onClick={() => setIsOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="dark"
            spinner={inviteLoading}
            disabled={
              inviteLoading || inviteEmails.length === 0 || remainingSeats === 0
            }
            onClick={handleSendInvites}
          >
            Send Invites
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
