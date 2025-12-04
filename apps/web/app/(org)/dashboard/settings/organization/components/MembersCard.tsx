"use client";

import { buildEnv } from "@cap/env";
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
import { faUser } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { removeOrganizationInvite } from "@/actions/organization/remove-invite";
import { removeOrganizationMember } from "@/actions/organization/remove-member";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { Tooltip } from "@/components/Tooltip";
import { calculateSeats } from "@/utils/organization";

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
	const { activeOrganization } = useDashboardContext();
	const { remainingSeats } = calculateSeats(activeOrganization || {});

	const handleDeleteInvite = async (inviteId: string) => {
		if (!isOwner) {
			showOwnerToast();
			return;
		}

		try {
			await removeOrganizationInvite(
				inviteId,
				activeOrganization?.organization.id,
			);
			toast.success("Invite deleted successfully");
			router.refresh();
		} catch (error) {
			console.error("Error deleting invite:", error);
			toast.error("An error occurred while deleting invite");
		}
	};

	const [confirmOpen, setConfirmOpen] = useState(false);
	const [pendingMember, setPendingMember] = useState<{
		id: string;
		name: string;
		email: string;
	} | null>(null);
	const [removing, setRemoving] = useState(false);

	const handleRemoveMember = (member: {
		id: string;
		user: { name: string; email: string };
	}) => {
		setPendingMember({
			id: member.id,
			name: member.user.name,
			email: member.user.email,
		});
		setConfirmOpen(true);
	};

	const confirmRemoveMember = async () => {
		if (!pendingMember) return;
		setRemoving(true);
		try {
			await removeOrganizationMember(
				pendingMember.id,
				activeOrganization?.organization.id,
			);
			toast.success("Member removed successfully");
			setConfirmOpen(false);
			setPendingMember(null);
			router.refresh();
		} catch (error) {
			console.error("Error removing member:", error);
			toast.error(
				error instanceof Error
					? error.message
					: "An error occurred while removing member",
			);
		} finally {
			setRemoving(false);
		}
	};

	const isMemberOwner = (id: string) => {
		return id === activeOrganization?.organization.ownerId;
	};

	const pendingMemberTest = {
		id: "1",
		name: "John Doe",
		email: "john.doe@example.com",
	};

	return (
		<>
			<ConfirmationDialog
				open={confirmOpen}
				icon={<FontAwesomeIcon icon={faUser} />}
				title="Remove member"
				description={
					pendingMemberTest
						? `Are you sure you want to remove ${pendingMemberTest.name}
         from your organization? this action cannot be undone.`
						: ""
				}
				confirmLabel={removing ? "Removing..." : "Remove"}
				cancelLabel="Cancel"
				loading={removing}
				onConfirm={confirmRemoveMember}
				onCancel={() => {
					setConfirmOpen(false);
					setPendingMember(null);
				}}
			/>
			<Card>
				<div className="flex flex-wrap gap-6 justify-between items-center w-full">
					<CardHeader>
						<CardTitle>Members</CardTitle>
						<CardDescription>Manage your organization members.</CardDescription>
					</CardHeader>
					<div className="flex flex-wrap gap-3">
						{buildEnv.NEXT_PUBLIC_IS_CAP && (
							<Tooltip
								position="top"
								content="Once inside the Stripe dashboard, click 'Manage Plan', then increase quantity of subscriptions to purchase more seats"
							>
								<Button
									type="button"
									size="sm"
									variant="primary"
									className="px-6 min-w-auto"
									spinner={loading}
									disabled={!isOwner || loading}
									onClick={handleManageBilling}
								>
									{loading ? "Loading..." : "+ Purchase more seats"}
								</Button>
							</Tooltip>
						)}
						<Button
							type="button"
							size="sm"
							variant="dark"
							className="px-6 min-w-auto"
							onClick={() => {
								if (!isOwner) {
									showOwnerToast();
								} else if (remainingSeats <= 0) {
									toast.error(
										"Invite limit reached, please purchase more seats",
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
						{activeOrganization?.members?.map((member) => (
							<TableRow key={member.id}>
								<TableCell>{member.user.name}</TableCell>
								<TableCell>{member.user.email}</TableCell>
								<TableCell>
									{isMemberOwner(member.user.id) ? "Owner" : "Member"}
								</TableCell>
								<TableCell>{format(member.createdAt, "MMM d, yyyy")}</TableCell>
								<TableCell>Active</TableCell>
								<TableCell>
									{!isMemberOwner(member.user.id) ? (
										<Button
											type="button"
											size="xs"
											variant="destructive"
											className="min-w-[unset] h-[28px]"
											onClick={() => {
												if (isOwner) {
													handleRemoveMember({
														id: member.id,
														user: {
															name: member.user.name ?? "(No Name)",
															email: member.user.email ?? "(No Email)",
														},
													});
												} else {
													showOwnerToast();
												}
											}}
											disabled={!isOwner}
										>
											Remove
										</Button>
									) : (
										"-"
									)}
								</TableCell>
							</TableRow>
						))}
						{activeOrganization?.invites?.map((invite) => (
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
		</>
	);
};
