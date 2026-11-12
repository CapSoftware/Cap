"use client";

import { buildEnv } from "@cap/env";
import { Avatar, Button, Select, Switch } from "@cap/ui";
import { faUser } from "@fortawesome/free-solid-svg-icons/faUser";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { Mail, Search, UserMinus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { removeOrganizationInvite } from "@/actions/organization/remove-invite";
import { removeOrganizationMember } from "@/actions/organization/remove-member";
import { toggleProSeat } from "@/actions/organization/toggle-pro-seat";
import { updateOrganizationMemberRole } from "@/actions/organization/update-member-role";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import {
	type AssignableOrganizationRole,
	canChangeOrganizationMemberRole,
	canManageOrganizationBilling,
	canManageOrganizationMembers,
	canManageOrganizationProSeats,
	canRemoveOrganizationMember,
	getEffectiveOrganizationRole,
	normalizeAssignableOrganizationRole,
	organizationRoleLabel,
} from "@/lib/permissions/roles";
import { calculateSeats } from "@/utils/organization";
import {
	doodleHost,
	PaperPlaneDoodle,
	SeatMeter,
} from "../_components/doodles";
import {
	SettingsCard,
	SettingsSection,
	StatusChip,
} from "../_components/settings-ui";
import { SeatManagementCard } from "./SeatManagementCard";

interface MembersCardProps {
	setIsInviteDialogOpen: (isOpen: boolean) => void;
}

const SEARCH_THRESHOLD = 8;

const roleOptions = [
	{ value: "admin", label: "Admin" },
	{ value: "member", label: "Member" },
];

const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

export const MembersCard = ({ setIsInviteDialogOpen }: MembersCardProps) => {
	const router = useRouter();
	const { activeOrganization, user } = useDashboardContext();
	const { proSeatsRemaining, proSeatsUsed, proSeatsTotal } = calculateSeats({
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
	const canManageBilling = canManageOrganizationBilling(currentRole);

	const [confirmOpen, setConfirmOpen] = useState(false);
	const [pendingMember, setPendingMember] = useState<{
		id: string;
		name: string;
		email: string;
	} | null>(null);
	const [deletingInviteId, setDeletingInviteId] = useState<string | null>(null);
	const [search, setSearch] = useState("");
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

	const openInvite = () => {
		if (!canManageMembers) {
			showMemberManagerToast();
			return;
		}
		setIsInviteDialogOpen(true);
	};

	const members = activeOrganization?.members ?? [];
	const invites = (activeOrganization?.invites ?? []).filter(
		(invite) => !memberEmails.has(invite.invitedEmail.toLowerCase()),
	);
	const query = search.trim().toLowerCase();
	const showSearch =
		query.length > 0 || members.length + invites.length >= SEARCH_THRESHOLD;
	const visibleMembers = query
		? members.filter((member) =>
				`${member.user.name ?? ""} ${member.user.lastName ?? ""} ${member.user.email}`
					.toLowerCase()
					.includes(query),
			)
		: members;
	const visibleInvites = query
		? invites.filter((invite) =>
				invite.invitedEmail.toLowerCase().includes(query),
			)
		: invites;
	const isAlone = members.length <= 1 && invites.length === 0;

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
			<SettingsSection
				title="Members"
				action={
					<div className="flex gap-4 items-center">
						<span className="text-[13px] text-gray-10">
							{plural(members.length, "member")}
							{invites.length > 0 && ` · ${invites.length} invited`}
						</span>
						<Button
							type="button"
							size="xs"
							variant="dark"
							className="px-4"
							onClick={openInvite}
							disabled={!canManageMembers}
						>
							Invite people
						</Button>
					</div>
				}
			>
				<SettingsCard>
					{!buildEnv.NEXT_PUBLIC_IS_CAP ? null : canManageBilling &&
						activeOrganization?.hasActiveProSeatProvider ? (
						<SeatManagementCard />
					) : (
						<div className="flex flex-wrap gap-x-6 gap-y-3 justify-between items-center px-4 py-3.5 sm:px-5">
							<div className="flex flex-wrap gap-x-4 gap-y-2 items-center">
								<SeatMeter used={proSeatsUsed} total={proSeatsTotal} />
								<p className="text-[13px] text-gray-11">
									<span className="font-medium tabular-nums text-gray-12">
										{proSeatsUsed} of {proSeatsTotal}
									</span>{" "}
									Pro seats in use
								</p>
							</div>
							{canManageBilling ? (
								<Link
									href="/dashboard/settings/organization/billing"
									className="text-[13px] font-medium underline-offset-4 text-gray-12 hover:underline"
								>
									Upgrade to Pro
								</Link>
							) : (
								<p className="text-[13px] text-gray-10">
									The organization owner manages seats.
								</p>
							)}
						</div>
					)}

					{showSearch && (
						<label className="flex gap-2.5 items-center px-4 h-11 sm:px-5">
							<Search className="size-4 shrink-0 text-gray-9" />
							<span className="sr-only">Search members</span>
							<input
								type="search"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
								placeholder="Search by name or email"
								className="flex-1 min-w-0 text-[16px] bg-transparent outline-none md:text-[13px] text-gray-12 placeholder:text-gray-9"
							/>
						</label>
					)}

					{visibleMembers.map((member) => {
						const memberIsOwner =
							member.user.id === activeOrganization?.organization.ownerId;
						const memberRole = getEffectiveOrganizationRole({
							userId: member.user.id,
							ownerId: activeOrganization?.organization.ownerId,
							memberRole: member.role,
						});
						const assignableRole =
							normalizeAssignableOrganizationRole(memberRole);
						const canUpdateRole = canChangeOrganizationMemberRole({
							actorRole: currentRole,
							actorUserId: user.id,
							targetUserId: member.user.id,
							ownerId: activeOrganization?.organization.ownerId,
							targetRole: memberRole,
							nextRole: assignableRole,
						});
						const canRemoveMember = canRemoveOrganizationMember({
							actorRole: currentRole,
							actorUserId: user.id,
							targetUserId: member.user.id,
							ownerId: activeOrganization?.organization.ownerId,
							targetRole: memberRole,
						});
						const roleUpdating =
							updateRoleMutation.isPending &&
							updateRoleMutation.variables?.memberId === member.id;
						const seatUpdating =
							toggleProSeatMutation.isPending &&
							toggleProSeatMutation.variables?.memberId === member.id;
						const noSeatsLeft = !member.hasProSeat && proSeatsRemaining <= 0;
						const displayName =
							[member.user.name, member.user.lastName]
								.filter(Boolean)
								.join(" ") || member.user.email;
						const isOwnerRole = memberIsOwner || memberRole === "owner";

						return (
							<div
								key={member.id}
								className="flex flex-wrap gap-x-4 gap-y-2.5 items-center px-4 py-3 sm:px-5"
							>
								<div className="flex flex-1 gap-3 items-center min-w-0 basis-56">
									<Avatar
										name={member.user.name ?? member.user.email}
										imageUrl={member.user.image}
										className="size-9 shrink-0"
										letterClass="text-sm"
									/>
									<div className="flex flex-col min-w-0">
										<div className="flex gap-2 items-center min-w-0">
											<span className="text-sm font-medium truncate text-gray-12">
												{displayName}
											</span>
											{member.user.id === user.id && (
												<span className="text-xs text-gray-9">You</span>
											)}
											{pendingInviteEmails.has(
												member.user.email.toLowerCase(),
											) && <StatusChip>Pending</StatusChip>}
										</div>
										<span className="text-[13px] truncate text-gray-10">
											{member.user.email}
										</span>
									</div>
								</div>
								<span className="hidden w-32 text-[13px] text-gray-10 xl:block">
									Joined {format(member.createdAt, "MMM d, yyyy")}
								</span>
								<div className="flex gap-3 items-center sm:gap-4">
									<div className="sm:w-[112px]">
										{isOwnerRole ? (
											<span className="px-3 text-[13px] font-medium text-gray-12">
												Owner
											</span>
										) : (
											<Select
												value={assignableRole ?? "member"}
												placeholder="Role"
												options={roleOptions}
												size="sm"
												variant="light"
												className="rounded-full shadow-xs border-gray-4"
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
									</div>
									{buildEnv.NEXT_PUBLIC_IS_CAP && (
										<div className="flex gap-2 items-center sm:w-[124px]">
											{memberIsOwner ? (
												<span className="text-[13px] text-gray-10">
													{activeOrganization?.ownerIsPro
														? "Pro included"
														: "Free"}
												</span>
											) : (
												<>
													<Switch
														aria-label={`Pro seat for ${displayName}`}
														title={
															noSeatsLeft
																? canManageBilling
																	? "No Pro seats left. Add seats above."
																	: "No Pro seats left. Ask the organization owner to add seats."
																: undefined
														}
														checked={member.hasProSeat}
														onCheckedChange={(checked) =>
															toggleProSeatMutation.mutate({
																memberId: member.id,
																enable: checked,
															})
														}
														disabled={
															!canManageProSeats || seatUpdating || noSeatsLeft
														}
													/>
													<span
														className={
															member.hasProSeat &&
															!activeOrganization?.hasActiveProSeatProvider
																? "text-[13px] text-amber-600"
																: "text-[13px] text-gray-10"
														}
													>
														{member.hasProSeat
															? activeOrganization?.hasActiveProSeatProvider
																? "Pro"
																: "Inactive"
															: "Free"}
													</span>
												</>
											)}
										</div>
									)}
									<div className="flex justify-end w-8">
										{!memberIsOwner && (
											<button
												type="button"
												aria-label={`Remove ${displayName}`}
												title="Remove from organization"
												className="flex justify-center items-center rounded-full transition-colors size-8 text-gray-9 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-9"
												onClick={() => {
													if (!canRemoveMember) {
														showMemberManagerToast();
														return;
													}
													setPendingMember({
														id: member.id,
														name: member.user.name ?? "(No Name)",
														email: member.user.email ?? "(No Email)",
													});
													setConfirmOpen(true);
												}}
												disabled={!canRemoveMember}
											>
												<UserMinus className="size-4" />
											</button>
										)}
									</div>
								</div>
							</div>
						);
					})}

					{visibleInvites.map((invite) => (
						<div
							key={invite.id}
							className="flex flex-wrap gap-x-4 gap-y-2.5 items-center px-4 py-3 sm:px-5"
						>
							<div className="flex flex-1 gap-3 items-center min-w-0 basis-56">
								<div className="flex justify-center items-center rounded-full border border-dashed size-9 shrink-0 border-gray-6 text-gray-9">
									<Mail className="size-4" />
								</div>
								<div className="flex flex-col min-w-0">
									<span className="text-sm font-medium truncate text-gray-12">
										{invite.invitedEmail}
									</span>
									<span className="text-[13px] text-gray-10">
										Invited as{" "}
										{organizationRoleLabel(
											normalizeAssignableOrganizationRole(invite.role) ??
												"member",
										).toLowerCase()}
									</span>
								</div>
							</div>
							<Button
								type="button"
								size="xs"
								variant="outline"
								className="px-4"
								onClick={() => {
									if (canManageMembers) {
										deleteInviteMutation.mutate(invite.id);
									} else {
										showMemberManagerToast();
									}
								}}
								disabled={!canManageMembers || deletingInviteId === invite.id}
							>
								{deletingInviteId === invite.id
									? "Revoking..."
									: "Revoke invite"}
							</Button>
						</div>
					))}

					{query && !visibleMembers.length && !visibleInvites.length && (
						<p className="px-4 py-8 text-[13px] text-center text-gray-10 sm:px-5">
							No one matches "{search.trim()}".
						</p>
					)}

					{isAlone && (
						<div
							className={`flex flex-col gap-4 items-center px-4 py-10 text-center sm:px-5 ${doodleHost}`}
						>
							<PaperPlaneDoodle />
							<div className="flex flex-col gap-1">
								<p className="text-sm font-medium text-gray-12">
									It's just you in here
								</p>
								<p className="max-w-sm text-[13px] leading-5 text-gray-10">
									Invite your team to share caps, comment and work in the same
									spaces.
								</p>
							</div>
							<Button
								type="button"
								size="xs"
								variant="outline"
								className="px-4"
								onClick={openInvite}
								disabled={!canManageMembers}
							>
								Invite people
							</Button>
						</div>
					)}
				</SettingsCard>
			</SettingsSection>
		</>
	);
};
