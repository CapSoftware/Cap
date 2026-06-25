"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Select,
	Switch,
} from "@cap/ui";
import { faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { sendOrganizationInvites } from "@/actions/organization/send-invites";
import { useDashboardContext } from "../../../Contexts";

interface InviteDialogProps {
	isOpen: boolean;
	setIsOpen: (open: boolean) => void;
}

type InviteRole = "admin" | "member";
type InviteEmail = {
	email: string;
	role: InviteRole;
};

const roleOptions = [
	{ value: "member", label: "Member" },
	{ value: "admin", label: "Admin" },
];

export const InviteDialog = ({ isOpen, setIsOpen }: InviteDialogProps) => {
	const router = useRouter();
	const { activeOrganization } = useDashboardContext();
	const [inviteEmails, setInviteEmails] = useState<InviteEmail[]>([]);
	const [emailInput, setEmailInput] = useState("");
	const [sendEmailNotifications, setSendEmailNotifications] = useState(true);
	const emailInputId = useId();
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	useEffect(() => {
		if (!isOpen) {
			setInviteEmails([]);
			setEmailInput("");
			setSendEmailNotifications(true);
		}
	}, [isOpen]);

	const buildInviteEmailsWithPendingInput = () => {
		const newEmails = emailInput
			.split(",")
			.map((email) => email.trim().toLowerCase())
			.filter((email) => email !== "");

		const invalidEmails = newEmails.filter((email) => !emailRegex.test(email));
		if (invalidEmails.length > 0) {
			toast.error(
				`Invalid email${invalidEmails.length > 1 ? "s" : ""}: ${invalidEmails.join(", ")}`,
			);
			return null;
		}

		const validEmails = newEmails.filter((email) => emailRegex.test(email));
		const inviteMap = new Map(
			inviteEmails.map((invite) => [invite.email, invite]),
		);

		for (const email of validEmails) {
			if (!inviteMap.has(email)) {
				inviteMap.set(email, { email, role: "member" });
			}
		}

		return Array.from(inviteMap.values());
	};

	const handleAddEmails = () => {
		const nextInviteEmails = buildInviteEmailsWithPendingInput();
		if (!nextInviteEmails) return;

		setInviteEmails(nextInviteEmails);
		setEmailInput("");
	};

	const handleRemoveEmail = (email: string) => {
		setInviteEmails(inviteEmails.filter((invite) => invite.email !== email));
	};

	const handleUpdateEmailRole = (email: string, role: InviteRole) => {
		setInviteEmails(
			inviteEmails.map((invite) =>
				invite.email === email ? { ...invite, role } : invite,
			),
		);
	};

	const sendInvites = useMutation({
		mutationFn: async (emails: InviteEmail[]) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("No active organization");
			}
			return await sendOrganizationInvites(
				emails,
				activeOrganization.organization.id,
				"member",
				{ sendEmailNotifications },
			);
		},
		onSuccess: (result) => {
			if (result.failedEmails.length > 0) {
				toast.warning(
					sendEmailNotifications
						? `Invites sent, but delivery failed for: ${result.failedEmails.join(", ")}`
						: `Users added, but provisioning failed for: ${result.failedEmails.join(", ")}`,
				);
			} else {
				toast.success(
					sendEmailNotifications
						? "Invites sent successfully"
						: "Users added successfully",
				);
			}
			setIsOpen(false);
			router.refresh();
		},
		onError: (error) => {
			console.error("Error sending invites:", error);
			toast.error(
				error instanceof Error
					? error.message
					: "An error occurred while sending invites",
			);
		},
	});

	const handleSendInvites = () => {
		const nextInviteEmails = buildInviteEmailsWithPendingInput();
		if (!nextInviteEmails || nextInviteEmails.length === 0) return;

		setInviteEmails(nextInviteEmails);
		setEmailInput("");
		sendInvites.mutate(nextInviteEmails);
	};

	const hasPendingEmailInput = emailInput.trim() !== "";

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faUserGroup} className="size-3.5" />}
					description="Invite your teammates to join the organization"
				>
					<DialogTitle>
						Invite to{" "}
						<span className="font-medium text-gray-12">
							{activeOrganization?.organization.name}
						</span>
					</DialogTitle>
				</DialogHeader>
				<div className="p-5">
					<Input
						id={emailInputId}
						value={emailInput}
						onChange={(e) => setEmailInput(e.target.value)}
						placeholder="name@company.com"
						onBlur={(e) => {
							const relatedTarget = e.relatedTarget;
							if (
								relatedTarget instanceof HTMLElement &&
								relatedTarget.dataset.inviteSubmit === "true"
							) {
								return;
							}
							handleAddEmails();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === ",") {
								e.preventDefault();
								handleAddEmails();
							}
						}}
					/>
					<div className="flex overflow-y-auto flex-col gap-2.5 mt-4 max-h-60">
						{inviteEmails.map((invite) => (
							<div
								key={invite.email}
								className="flex gap-3 justify-between items-center p-3 rounded-xl border transition-colors duration-200 border-gray-4 hover:bg-gray-3"
							>
								<span className="min-w-0 text-sm truncate text-gray-12">
									{invite.email}
								</span>
								<Select
									value={invite.role}
									placeholder="Role"
									options={roleOptions}
									size="sm"
									variant="gray"
									onValueChange={(value) =>
										handleUpdateEmailRole(
											invite.email,
											value === "admin" ? "admin" : "member",
										)
									}
								/>
								<Button
									style={
										{
											"--gradient-border-radius": "8px",
										} as React.CSSProperties
									}
									type="button"
									variant="destructive"
									size="xs"
									onClick={() => handleRemoveEmail(invite.email)}
								>
									Remove
								</Button>
							</div>
						))}
					</div>
					<div className="flex gap-3 justify-between items-center p-3 mt-4 rounded-lg border border-gray-4 bg-gray-1">
						<div>
							<p className="text-sm font-medium text-gray-12">
								Send invite email
							</p>
							<p className="mt-1 text-xs text-gray-10">
								Turn off to add users without emailing them.
							</p>
						</div>
						<Switch
							checked={sendEmailNotifications}
							onCheckedChange={setSendEmailNotifications}
						/>
					</div>
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
						spinner={sendInvites.isPending}
						disabled={
							sendInvites.isPending ||
							(inviteEmails.length === 0 && !hasPendingEmailInput)
						}
						data-invite-submit="true"
						onClick={handleSendInvites}
					>
						{sendEmailNotifications ? "Send Invites" : "Add Users"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
