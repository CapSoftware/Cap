"use client";

import { manageBilling } from "@/actions/workspace/manage-billing";
import { removeWorkspaceInvite } from "@/actions/workspace/remove-invite";
import { sendWorkspaceInvites } from "@/actions/workspace/send-invites";
import { updateWorkspaceDetails } from "@/actions/workspace/update-details";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Tooltip } from "@/components/Tooltip";
import {
  Button,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@cap/ui";
import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { CustomDomain } from "./components/CustomDomain";

export const Workspace = () => {
  const { spaceData, activeSpace, user } = useSharedContext();
  const workspaceName = activeSpace?.space.name;
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const isOwner = user?.id === activeSpace?.space.ownerId;
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
  const [inviteEmails, setInviteEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const ownerToastShown = useRef(false);

  const showOwnerToast = () => {
    if (!ownerToastShown.current) {
      toast.error("Only the owner can make changes");
      ownerToastShown.current = true;
      setTimeout(() => {
        ownerToastShown.current = false;
      }, 3000);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!isOwner) {
      showOwnerToast();
      return;
    }

    const formData = new FormData(e.currentTarget);
    const workspaceName = formData.get("workspaceName") as string;
    const allowedEmailDomain = formData.get("allowedEmailDomain") as string;

    try {
      await updateWorkspaceDetails(
        workspaceName,
        allowedEmailDomain,
        activeSpace?.space.id as string
      );
      toast.success("Settings updated successfully");
      router.refresh();
    } catch (error) {
      console.error("Error updating settings:", error);
      toast.error("An error occurred while updating settings");
    }
  };

  const handleAddEmails = () => {
    const newEmails = emailInput
      .split(",")
      .map((email) => email.trim())
      .filter((email) => email !== "");
    setInviteEmails([...new Set([...inviteEmails, ...newEmails])]);
    setEmailInput("");
  };

  const handleRemoveEmail = (email: string) => {
    setInviteEmails(inviteEmails.filter((e) => e !== email));
  };

  const handleSendInvites = async () => {
    if (!isOwner) {
      showOwnerToast();
      return;
    }

    try {
      await sendWorkspaceInvites(inviteEmails, activeSpace?.space.id as string);
      toast.success("Invites sent successfully");
      setInviteEmails([]);
      setIsInviteDialogOpen(false);
      router.refresh();
    } catch (error) {
      console.error("Error sending invites:", error);
      toast.error("An error occurred while sending invites");
    }
  };

  const handleDeleteInvite = async (inviteId: string) => {
    if (!isOwner) {
      showOwnerToast();
      return;
    }

    try {
      await removeWorkspaceInvite(inviteId, activeSpace?.space.id as string);
      toast.success("Invite deleted successfully");
      router.refresh();
    } catch (error) {
      console.error("Error deleting invite:", error);
      toast.error("An error occurred while deleting invite");
    }
  };

  const handleManageBilling = async () => {
    if (!isOwner) {
      showOwnerToast();
      return;
    }

    setLoading(true);
    try {
      const url = await manageBilling();
      router.push(url);
    } catch (error) {
      console.error("Error managing billing:", error);
      toast.error("An error occurred while managing billing");
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {isOwner === false && (
        <CardContent>
          <CardTitle>*Only the owner can make changes</CardTitle>
          <CardDescription>
            Only the owner can make changes to this workspace.
          </CardDescription>
        </CardContent>
      )}
      <CardContent>
        <CardTitle>Workspace Details</CardTitle>
        <CardDescription>
          Changing the name and image will update how your workspace appears to
          others members.
        </CardDescription>
      </CardContent>
      <CardContent>
        <div className="space-y-3">
          <div>
            <Label htmlFor="workspaceName">Workspace name</Label>
            <Input
              type="text"
              defaultValue={workspaceName as string}
              id="workspaceName"
              name="workspaceName"
              disabled={!isOwner}
              onChange={() => {
                if (!isOwner) showOwnerToast();
              }}
            />
          </div>
          <div>
            <Label htmlFor="allowedEmailDomain">
              Workspace Access Requirements
            </Label>
            <Input
              type="text"
              placeholder="e.g. company.com"
              defaultValue={activeSpace?.space.allowedEmailDomain || ""}
              id="allowedEmailDomain"
              name="allowedEmailDomain"
              disabled={!isOwner}
              onChange={() => {
                if (!isOwner) showOwnerToast();
              }}
            />
            <p className="mt-1 text-sm text-gray-400">
              Only users with email addresses from this domain will be able to
              access videos shared in this workspace. Leave empty to allow all
              users.
            </p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="px-6 pt-0 pb-6 border-b">
        <Button
          type="submit"
          size="sm"
          variant="dark"
          disabled={!isOwner}
          onClick={() => {
            if (!isOwner) showOwnerToast();
          }}
        >
          Save
        </Button>
      </CardFooter>
      <>
        <CardContent className="pt-6">
          <CardTitle>Custom Domain</CardTitle>
          <CardDescription>
            Configure a custom domain for your workspace's shared caps.
          </CardDescription>
          <div className="mt-4">
            <CustomDomain />
          </div>
        </CardContent>
        <CardFooter className="px-6 pt-0 pb-2 border-b"></CardFooter>
      </>
      <CardHeader>
        <div className="flex justify-between items-center">
          <div>
            <CardTitle>Workspace Members</CardTitle>
            <CardDescription>Manage your workspace members.</CardDescription>
            <CardDescription>
              Current seats capacity:{" "}
              {`${activeSpace?.inviteQuota} paid ${
                activeSpace && activeSpace?.inviteQuota > 1
                  ? "subscriptions"
                  : "subscription"
              } across all of your workspaces`}
            </CardDescription>
            <CardDescription>
              Seats remaining:{" "}
              {activeSpace?.inviteQuota ?? 1 - (activeSpace?.totalInvites ?? 1)}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center space-x-2">
          <Tooltip
            position="top"
            content="Once inside the Stripe dashboard, click 'Manage Plan', then increase quantity of subscriptions to purchase more seats"
          >
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={!isOwner || loading}
              onClick={handleManageBilling}
            >
              {loading ? "Loading..." : "+ Purchase more seats"}
            </Button>
          </Tooltip>
          <Button
            type="button"
            size="sm"
            variant="gray"
            onClick={() => {
              if (!isOwner) {
                showOwnerToast();
              } else if (
                activeSpace &&
                activeSpace.inviteQuota <= activeSpace.totalInvites
              ) {
                toast.error("Invite limit reached, please purchase more seats");
              } else {
                setIsInviteDialogOpen(true);
              }
            }}
            disabled={!isOwner}
          >
            Invite users
          </Button>
        </div>
      </CardContent>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{"Member"}</TableHead>
              <TableHead>{"Email"}</TableHead>
              <TableHead>{"Role"}</TableHead>
              <TableHead>{"Joined"}</TableHead>
              <TableHead>{"Status"}</TableHead>
              <TableHead>{"Actions"}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activeSpace?.members &&
              activeSpace.members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>{member.user.name}</TableCell>
                  <TableCell>{member.user.email}</TableCell>
                  <TableCell>
                    {member.user.id === activeSpace?.space.ownerId
                      ? "Owner"
                      : "Member"}
                  </TableCell>
                  <TableCell>
                    {format(member.createdAt, "MMM d, yyyy")}
                  </TableCell>
                  <TableCell>Active</TableCell>
                  <TableCell>-</TableCell>
                </TableRow>
              ))}
            {activeSpace?.invites &&
              activeSpace.invites.map((invite) => (
                <TableRow key={invite.id}>
                  <TableCell>{invite.id}</TableCell>
                  <TableCell>{invite.invitedEmail}</TableCell>
                  <TableCell>Member</TableCell>
                  <TableCell>-</TableCell>
                  <TableCell>Invited</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        if (isOwner) {
                          handleDeleteInvite(invite.id);
                        } else {
                          showOwnerToast();
                        }
                      }}
                      disabled={!isOwner}
                    >
                      Delete Invite
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </CardContent>
      <CardHeader>
        <CardTitle>View and manage your billing details</CardTitle>
        <CardDescription>
          View and edit your billing details, as well as manage your
          subscription.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <CardDescription className="mt-1">
          <Button
            type="button"
            size="sm"
            variant="gray"
            onClick={handleManageBilling}
            disabled={!isOwner}
          >
            {loading ? "Loading..." : "Manage Billing"}
          </Button>
        </CardDescription>
      </CardContent>

      <Dialog open={isInviteDialogOpen} onOpenChange={setIsInviteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite Teammates</DialogTitle>
            <DialogDescription>
              Invite your teammates to join {activeSpace?.space.name} workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="emails">Email</Label>
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
            </div>
            <div className="space-y-2">
              {inviteEmails.map((email) => (
                <div
                  key={email}
                  className="flex justify-between items-center p-2 bg-gray-100 rounded"
                >
                  <span>{email}</span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => handleRemoveEmail(email)}
                    disabled={!isOwner}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter className="flex justify-between items-center">
            <Button
              type="button"
              variant="white"
              onClick={() => setIsInviteDialogOpen(false)}
            >
              Cancel
            </Button>
            <div className="flex space-x-2">
              <Button
                type="button"
                onClick={handleSendInvites}
                disabled={inviteEmails.length === 0}
              >
                Send Invites
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
};
