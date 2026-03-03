"use client";

import { buildEnv } from "@cap/env";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Switch,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@cap/ui";
import { faUser } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { removeOrganizationInvite } from "@/actions/organization/remove-invite";
import { removeOrganizationMember } from "@/actions/organization/remove-member";
import { toggleProSeat } from "@/actions/organization/toggle-pro-seat";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { calculateSeats } from "@/utils/organization";

interface MembersCardProps {
	isOwner: boolean;
	showOwnerToast: () => void;
	setIsInviteDialogOpen: (isOpen: boolean) => void;
}

export const MembersCard = ({
	isOwner,
	showOwnerToast,
	setIsInviteDialogOpen,
}: MembersCardProps) => {
	const router = useRouter();
	const { activeOrganization } = useDashboardContext();
	const { proSeatsRemaining } = calculateSeats(activeOrganization || {});

	const [confirmOpen, setConfirmOpen] = useState(false);
	const [pendingMember, setPendingMember] = useState<{
		id: string;
		name: string;
		email: string;
	} | null>(null);
	const [deletingInviteId, setDeletingInviteId] = useState<string | null>(null);

	const deleteInviteMutation = useMutation({
		mutationFn: (inviteId: string) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("Organization not found");
			}
			setDeletingInviteId(inviteId);
			return removeOrganizationInvite(
				inviteId,
				activeOrganization.organization.id,
			);
		},
		onSuccess: () => {
			toast.success("Invite deleted successfully");
			setDeletingInviteId(null);
			router.refresh();
		},
		onError: () => {
			toast.error("An error occurred while deleting invite");
			setDeletingInviteId(null);
		},
	});

	const removeMemberMutation = useMutation({
		mutationFn: (memberId: string) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("Organization not found");
			}
			return removeOrganizationMember(
				memberId,
				activeOrganization.organization.id,
			);
		},
		onSuccess: () => {
			toast.success("Member removed successfully");
			setConfirmOpen(false);
			setPendingMember(null);
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "An error occurred while removing member",
			);
		},
	});

	const toggleProSeatMutation = useMutation({
		mutationFn: ({
			memberId,
			enable,
		}: {
			memberId: string;
			enable: boolean;
		}) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("Organization not found");
			}
			return toggleProSeat(
				memberId,
				activeOrganization.organization.id,
				enable,
			);
		},
		onSuccess: (_data, { enable }) => {
			toast.success(enable ? "Pro seat assigned" : "Pro seat removed");
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to update Pro seat",
			);
		},
	});

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

	const isMemberOwner = (role: string) => {
		return role === "owner";
	};

	return (
		<>
			<ConfirmationDialog
				open={confirmOpen}
				icon={<FontAwesomeIcon icon={faUser} />}
				title="Remove member"
				description={
					pendingMember
						? `Are you sure you want to remove ${pendingMember.name} from your organization? This action cannot be undone.`
						: ""
				}
				confirmLabel={removeMemberMutation.isPending ? "Removing..." : "Remove"}
				cancelLabel="Cancel"
				loading={removeMemberMutation.isPending}
				onConfirm={() => {
					if (pendingMember) {
						removeMemberMutation.mutate(pendingMember.id);
					}
				}}
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
					<Button
						type="button"
						size="sm"
						variant="dark"
						className="px-6 min-w-auto"
						onClick={() => {
							if (!isOwner) {
								showOwnerToast();
								return;
							}
							setIsInviteDialogOpen(true);
						}}
						disabled={!isOwner}
					>
						+ Invite users
					</Button>
				</div>
				<Table className="mt-5">
					<TableHeader>
						<TableRow>
							<TableHead>Member</TableHead>
							<TableHead>Email</TableHead>
							<TableHead>Role</TableHead>
							{buildEnv.NEXT_PUBLIC_IS_CAP && <TableHead>Pro</TableHead>}
							<TableHead>Joined</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Actions</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{activeOrganization?.members?.map((member) => {
							const memberIsOwner = isMemberOwner(member.role);
							return (
								<TableRow key={member.id}>
									<TableCell>{member.user.name}</TableCell>
									<TableCell>{member.user.email}</TableCell>
									<TableCell>{memberIsOwner ? "Owner" : "Member"}</TableCell>
									{buildEnv.NEXT_PUBLIC_IS_CAP && (
										<TableCell>
											{memberIsOwner ? (
												<span className="text-xs text-gray-10">-</span>
											) : (
												<Switch
													checked={member.hasProSeat}
													onCheckedChange={(checked) =>
														toggleProSeatMutation.mutate({
															memberId: member.id,
															enable: checked,
														})
													}
													disabled={
														!isOwner ||
														(toggleProSeatMutation.isPending &&
															toggleProSeatMutation.variables?.memberId ===
																member.id) ||
														(!member.hasProSeat && proSeatsRemaining <= 0)
													}
												/>
											)}
										</TableCell>
									)}
									<TableCell>
										{format(member.createdAt, "MMM d, yyyy")}
									</TableCell>
									<TableCell>Active</TableCell>
									<TableCell>
										{!memberIsOwner ? (
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
							);
						})}
						{activeOrganization?.invites?.map((invite) => (
							<TableRow key={invite.id}>
								<TableCell className="text-gray-10">Pending</TableCell>
								<TableCell>{invite.invitedEmail}</TableCell>
								<TableCell>Member</TableCell>
								{buildEnv.NEXT_PUBLIC_IS_CAP && <TableCell>-</TableCell>}
								<TableCell>-</TableCell>
								<TableCell>Invited</TableCell>
								<TableCell>
									<Button
										type="button"
										size="xs"
										variant="destructive"
										onClick={() => {
											if (isOwner) {
												deleteInviteMutation.mutate(invite.id);
											} else {
												showOwnerToast();
											}
										}}
										disabled={!isOwner || deletingInviteId === invite.id}
									>
										{deletingInviteId === invite.id
											? "Deleting..."
											: "Delete Invite"}
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
