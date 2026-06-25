"use client";

import { buildEnv } from "@cap/env";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Select,
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
import { updateOrganizationMemberRole } from "@/actions/organization/update-member-role";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import {
	type AssignableOrganizationRole,
	canChangeOrganizationMemberRole,
	canManageOrganizationMembers,
	canManageOrganizationProSeats,
	canRemoveOrganizationMember,
	getEffectiveOrganizationRole,
	normalizeAssignableOrganizationRole,
	organizationRoleLabel,
} from "@/lib/permissions/roles";
import { calculateSeats } from "@/utils/organization";

interface MembersCardProps {
	setIsInviteDialogOpen: (isOpen: boolean) => void;
}

export const MembersCard = ({ setIsInviteDialogOpen }: MembersCardProps) => {
	const router = useRouter();
	const { activeOrganization, user } = useDashboardContext();
	const { proSeatsRemaining } = calculateSeats({
		...(activeOrganization || {}),
		ownerId: activeOrganization?.organization.ownerId,
		ownerIsPro: Boolean(activeOrganization?.ownerIsPro),
	});
	const currentMember = activeOrganization?.members.find(
		(member) => member.userId === user.id,
	);
	const currentRole = getEffectiveOrganizationRole({
		userId: user.id,
		ownerId: activeOrganization?.organization.ownerId,
		memberRole: currentMember?.role,
	});
	const pendingInviteEmails = new Set(
		activeOrganization?.invites?.map((invite) =>
			invite.invitedEmail.toLowerCase(),
		) ?? [],
	);
	const memberEmails = new Set(
		activeOrganization?.members?.map((member) =>
			member.user.email.toLowerCase(),
		) ?? [],
	);
	const canManageMembers = canManageOrganizationMembers(currentRole);
	const canManageProSeats = canManageOrganizationProSeats(currentRole);

	const [confirmOpen, setConfirmOpen] = useState(false);
	const [pendingMember, setPendingMember] = useState<{
		id: string;
		name: string;
		email: string;
	} | null>(null);
	const [deletingInviteId, setDeletingInviteId] = useState<string | null>(null);
	const roleOptions = [
		{ value: "admin", label: "Admin" },
		{ value: "member", label: "Member" },
	];
	const showMemberManagerToast = () => {
		toast.error("Only admins and owners can manage organization members");
	};

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

	const updateRoleMutation = useMutation({
		mutationFn: ({
			memberId,
			role,
		}: {
			memberId: string;
			role: AssignableOrganizationRole;
		}) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("Organization not found");
			}
			return updateOrganizationMemberRole(
				memberId,
				activeOrganization.organization.id,
				role,
			);
		},
		onSuccess: () => {
			toast.success("Role updated");
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to update role",
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

	const isMemberOwner = (id: string) => {
		return id === activeOrganization?.organization.ownerId;
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
							if (!canManageMembers) {
								showMemberManagerToast();
								return;
							}
							setIsInviteDialogOpen(true);
						}}
						disabled={!canManageMembers}
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
							const memberIsOwner = isMemberOwner(member.user.id);
							const memberRole = getEffectiveOrganizationRole({
								userId: member.user.id,
								ownerId: activeOrganization.organization.ownerId,
								memberRole: member.role,
							});
							const assignableRole =
								normalizeAssignableOrganizationRole(memberRole);
							const canUpdateRole = canChangeOrganizationMemberRole({
								actorRole: currentRole,
								actorUserId: user.id,
								targetUserId: member.user.id,
								ownerId: activeOrganization.organization.ownerId,
								targetRole: memberRole,
								nextRole: assignableRole,
							});
							const canRemoveMember = canRemoveOrganizationMember({
								actorRole: currentRole,
								actorUserId: user.id,
								targetUserId: member.user.id,
								ownerId: activeOrganization.organization.ownerId,
								targetRole: memberRole,
							});
							const roleUpdating =
								updateRoleMutation.isPending &&
								updateRoleMutation.variables?.memberId === member.id;
							return (
								<TableRow key={member.id}>
									<TableCell>{member.user.name}</TableCell>
									<TableCell>{member.user.email}</TableCell>
									<TableCell>
										{memberIsOwner || memberRole === "owner" ? (
											"Owner"
										) : (
											<Select
												value={assignableRole ?? "member"}
												placeholder="Role"
												options={roleOptions}
												size="sm"
												variant="gray"
												onValueChange={(value) => {
													const nextRole =
														normalizeAssignableOrganizationRole(value);
													if (!nextRole) return;
													updateRoleMutation.mutate({
														memberId: member.id,
														role: nextRole,
													});
												}}
												disabled={!canUpdateRole || roleUpdating}
											/>
										)}
									</TableCell>
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
														!canManageProSeats ||
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
									<TableCell>
										{pendingInviteEmails.has(member.user.email.toLowerCase())
											? "Pending"
											: "Active"}
									</TableCell>
									<TableCell>
										{!memberIsOwner ? (
											<Button
												type="button"
												size="xs"
												variant="destructive"
												className="min-w-[unset] h-[28px]"
												onClick={() => {
													if (canRemoveMember) {
														handleRemoveMember({
															id: member.id,
															user: {
																name: member.user.name ?? "(No Name)",
																email: member.user.email ?? "(No Email)",
															},
														});
													} else {
														showMemberManagerToast();
													}
												}}
												disabled={!canRemoveMember}
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
						{activeOrganization?.invites
							?.filter(
								(invite) =>
									!memberEmails.has(invite.invitedEmail.toLowerCase()),
							)
							.map((invite) => (
								<TableRow key={invite.id}>
									<TableCell className="text-gray-10">Pending</TableCell>
									<TableCell>{invite.invitedEmail}</TableCell>
									<TableCell>
										{organizationRoleLabel(
											normalizeAssignableOrganizationRole(invite.role) ??
												"member",
										)}
									</TableCell>
									{buildEnv.NEXT_PUBLIC_IS_CAP && <TableCell>-</TableCell>}
									<TableCell>-</TableCell>
									<TableCell>Invited</TableCell>
									<TableCell>
										<Button
											type="button"
											size="xs"
											variant="destructive"
											onClick={() => {
												if (canManageMembers) {
													deleteInviteMutation.mutate(invite.id);
												} else {
													showMemberManagerToast();
												}
											}}
											disabled={
												!canManageMembers || deletingInviteId === invite.id
											}
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
