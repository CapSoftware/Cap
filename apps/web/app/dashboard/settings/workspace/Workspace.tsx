"use client";

import { manageBilling } from "@/actions/workspace/manage-billing";
import { removeWorkspaceInvite } from "@/actions/workspace/remove-invite";
import { sendWorkspaceInvites } from "@/actions/workspace/send-invites";
import { updateWorkspaceDetails } from "@/actions/workspace/update-details";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Tooltip } from "@/components/Tooltip";
import {
  Button,
  Card,
  CardDescription,
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
import { faChair, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { CustomDomain } from "./components/CustomDomain";

export const Workspace = () => {
  const { activeSpace, user } = useSharedContext();
  const workspaceName = activeSpace?.space.name;
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const isOwner = user?.id === activeSpace?.space.ownerId;
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
  const [inviteEmails, setInviteEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const ownerToastShown = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
      {isOwner === false && (
        <Card>
          <CardTitle>*Only the owner can make changes</CardTitle>
          <CardDescription>
            Only the owner can make changes to this workspace.
          </CardDescription>
        </Card>
      )}

      <div className="flex flex-col flex-1 gap-6 justify-center lg:flex-row">
        <Card className="flex flex-col flex-1 gap-3 justify-center items-center">
          <FontAwesomeIcon className="text-gray-10 size-5" icon={faChair} />
          <p className="text-gray-10">
            Seats Remaining
            <span className="ml-2 font-bold text-gray-1">
              {(activeSpace?.inviteQuota ?? 1) -
                (activeSpace?.totalInvites ?? 0)}
            </span>
          </p>
        </Card>
        <Card className="flex flex-col flex-1 gap-3 justify-center items-center">
          <FontAwesomeIcon className="text-gray-10 size-5" icon={faUserGroup} />
          <p className="text-gray-10">
            Seats Capacity
            <span className="ml-2 font-bold text-gray-1">
              {activeSpace?.inviteQuota}
            </span>
          </p>
        </Card>
      </div>

      <div className="flex flex-col flex-1 gap-6 justify-center items-stretch xl:flex-row">
        <Card className="flex flex-col flex-1 justify-between w-full">
          <div className="flex flex-col gap-6 justify-center lg:flex-row">
            <div className="flex-1 w-full">
              <div className="space-y-1">
                <Label htmlFor="workspaceName">Name</Label>
                <p className="text-sm text-gray-10">
                  Changing the name will update how your workspace appears to
                  others members.
                </p>
              </div>
              <Input
                className="mt-4"
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
                defaultValue={activeSpace?.space.allowedEmailDomain || ""}
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
            size="sm"
            variant="dark"
            disabled={!isOwner}
            onClick={() => {
              if (!isOwner) showOwnerToast();
            }}
          >
            Save
          </Button>
        </Card>
        <Card className="flex flex-col flex-1 gap-6 w-full lg:flex-row">
          <div className="flex-1">
            <div className="space-y-1">
              <Label htmlFor="customDomain">Custom Domain</Label>
              <CardDescription className="w-full max-w-[400px]">
                Set up a custom domain for your workspace's shared caps and make
                it unique.
              </CardDescription>
            </div>
            <div className="mt-4">
              <CustomDomain />
            </div>
          </div>
          {/* <div className="flex-1"> */}
          {/* <div className="space-y-1">
              <Label htmlFor="icon">Icon</Label>
              <CardDescription className="w-full max-w-[400px]">
                Upload a custom logo or icon for your workspace and make it
                unique.
              </CardDescription>
            </div> */}
          {/* <div
              onClick={() => fileInputRef.current?.click()}
              className="w-full hover:bg-gray-1 transition-all duration-300 gap-3 border-gray-300 mt-4 border px-4 flex items-center justify-center py-[14px] border-dashed rounded-2xl"
            >
              <FontAwesomeIcon
                className="text-gray-10 size-5"
                icon={faCloudUpload}
              />
              <p className="text-xs truncate text-gray-10">
                Choose a file or drag & drop it here
              </p>
            </div> */}
          {/* <Input
              className="hidden"
              type="file"
              ref={fileInputRef}
              id="icon"
              disabled={!isOwner}
              onChange={() => {
                if (!isOwner) showOwnerToast();
              }}
              name="icon"
            />
          </div> */}
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap gap-6 justify-between items-center w-full">
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>Manage your workspace members.</CardDescription>
          </CardHeader>
          <div className="flex flex-wrap gap-3">
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
              variant="white"
              onClick={() => {
                if (!isOwner) {
                  showOwnerToast();
                } else if (
                  activeSpace &&
                  activeSpace.inviteQuota <= activeSpace.totalInvites
                ) {
                  toast.error(
                    "Invite limit reached, please purchase more seats"
                  );
                } else {
                  setIsInviteDialogOpen(true);
                }
              }}
              disabled={!isOwner}
            >
              + Invite users
            </Button>
          </div>
        </div>
        <Table className="mt-5">
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
                      size="xs"
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
      </Card>
      <Card className="flex flex-wrap gap-6 justify-between items-center w-full">
        <CardHeader>
          <CardTitle>View and manage your billing details</CardTitle>
          <CardDescription>
            View and edit your billing details, as well as manage your
            subscription.
          </CardDescription>
        </CardHeader>
        <Button
          type="button"
          size="sm"
          variant="gray"
          onClick={handleManageBilling}
          disabled={!isOwner}
        >
          {loading ? "Loading..." : "Manage Billing"}
        </Button>
      </Card>

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
                  className="flex justify-between items-center p-2 rounded bg-gray-1"
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
