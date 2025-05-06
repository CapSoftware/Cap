"use client";

import { manageBilling } from "@/actions/organization/manage-billing";
import { removeOrganizationInvite } from "@/actions/organization/remove-invite";
import { sendOrganizationInvites } from "@/actions/organization/send-invites";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
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
  TableRow
} from "@cap/ui";
import { faChair, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { CustomDomain } from "./components/CustomDomain";

export const Organization = () => {
  const { activeOrganization, user } = useSharedContext();
  const organizationName = activeOrganization?.organization.name;
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const isOwner = user?.id === activeOrganization?.organization.ownerId;
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
    const organizationName = formData.get("organizationName") as string;
    const allowedEmailDomain = formData.get("allowedEmailDomain") as string;

    try {
      await updateOrganizationDetails(
        organizationName,
        allowedEmailDomain,
        activeOrganization?.organization.id as string
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
      await sendOrganizationInvites(
        inviteEmails,
        activeOrganization?.organization.id as string
      );
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
      await removeOrganizationInvite(
        inviteId,
        activeOrganization?.organization.id as string
      );
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
            Only the owner can make changes to this organization.
          </CardDescription>
        </Card>
      )}

      <div className="flex flex-col flex-1 gap-6 justify-center lg:flex-row">
        <Card className="flex flex-col flex-1 gap-3 justify-center items-center">
          <FontAwesomeIcon className="text-gray-10 size-5" icon={faChair} />
          <p className="text-gray-12">
            Seats Remaining
            <span className="ml-2 font-bold text-gray-12">
              {(activeOrganization?.inviteQuota ?? 1) -
                (activeOrganization?.totalInvites ?? 0)}
            </span>
          </p>
        </Card>
        <Card className="flex flex-col flex-1 gap-3 justify-center items-center">
          <FontAwesomeIcon className="text-gray-10 size-5" icon={faUserGroup} />
          <p className="text-gray-12">
            Seats Capacity
            <span className="ml-2 font-bold text-gray-12">
              {activeOrganization?.inviteQuota}
            </span>
          </p>
        </Card>
      </div>

      <div className="flex flex-col flex-1 gap-6 justify-center items-stretch xl:flex-row">
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
                Set up a custom domain for your organization's shared caps and
                make it unique.
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
            <CardDescription>Manage your organization members.</CardDescription>
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
              variant="dark"
              onClick={() => {
                if (!isOwner) {
                  showOwnerToast();
                } else if (
                  activeOrganization &&
                  activeOrganization.inviteQuota <=
                    activeOrganization.totalInvites
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
            {activeOrganization?.members &&
              activeOrganization.members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>{member.user.name}</TableCell>
                  <TableCell>{member.user.email}</TableCell>
                  <TableCell>
                    {member.user.id === activeOrganization?.organization.ownerId
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
            {activeOrganization?.invites &&
              activeOrganization.invites.map((invite) => (
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
          variant="dark"
          onClick={handleManageBilling}
          disabled={!isOwner}
        >
          {loading ? "Loading..." : "Manage Billing"}
        </Button>
      </Card>

      <Dialog open={isInviteDialogOpen} onOpenChange={setIsInviteDialogOpen}>
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
                    style={{
                      "--gradient-border-radius": "8px",
                    } as React.CSSProperties}
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
          </div>
          <DialogFooter className="p-5 border-t border-gray-4">
            <Button
              type="button"
              size="sm"
              variant="gray"
              onClick={() => setIsInviteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="dark"
              onClick={handleSendInvites}
              disabled={inviteEmails.length === 0}
            >
              Send Invites
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
};
