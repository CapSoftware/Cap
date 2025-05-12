"use client";

import { removeOrganizationInvite } from "@/actions/organization/remove-invite";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Tooltip } from "@/components/Tooltip";
import { calculateSeats } from "@/utils/organization";
import {
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@cap/ui";
import { format } from "date-fns";
import { useRouter } from "next/navigation";

import { toast } from "sonner";

interface MembersCardProps {
  isOwner: boolean;
  loading: boolean;
  handleManageBilling: () => Promise<void>;
  showOwnerToast: () => void;
  setIsInviteDialogOpen: (isOpen: boolean) => void;
}

export const MembersCard = ({
  isOwner,
  loading,
  handleManageBilling,
  showOwnerToast,
  setIsInviteDialogOpen,
}: MembersCardProps) => {
  const router = useRouter();
  const { activeOrganization } = useSharedContext();
  const { remainingSeats } = calculateSeats(activeOrganization || {});

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

  return (
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
              spinner={loading}
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
              } else if (remainingSeats <= 0) {
                toast.error("Invite limit reached, please purchase more seats");
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
                <TableCell>{format(member.createdAt, "MMM d, yyyy")}</TableCell>
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
  );
};
