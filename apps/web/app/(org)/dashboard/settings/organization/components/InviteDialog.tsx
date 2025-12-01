"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { sendOrganizationInvites } from "@/actions/organization/send-invites";
import { calculateSeats } from "@/utils/organization";
import { useDashboardContext } from "../../../Contexts";

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
	const { activeOrganization } = useDashboardContext();
	const [inviteEmails, setInviteEmails] = useState<string[]>([]);
	const [emailInput, setEmailInput] = useState("");

	const { paidSeats, remainingPaidSeats } = calculateSeats(
		activeOrganization || {},
	);

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

	const sendInvites = useMutation({
		mutationFn: async () => {
			if (!isOwner) {
				showOwnerToast();
				throw new Error("Not authorized");
			}

			return await sendOrganizationInvites(
				inviteEmails,
				activeOrganization?.organization.id as Organisation.OrganisationId,
			);
		},
		onSuccess: () => {
			toast.success("Invites sent successfully");
			setInviteEmails([]);
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

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faUserGroup} className="size-3.5" />}
					description="Invite teammates to join your organization. Invited members will be on the free plan by default."
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
								className="flex justify-between items-center p-3 rounded-xl border transition-colors duration-200 cursor-pointer border-gray-4 hover:bg-gray-3"
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
					{paidSeats > 0 && (
						<p className="mt-3 text-xs text-gray-11">
							You have {remainingPaidSeats} paid seat
							{remainingPaidSeats !== 1 ? "s" : ""} available. New members will
							join on the free plan and can be upgraded to paid seats later.
						</p>
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
						spinner={sendInvites.isPending}
						disabled={sendInvites.isPending || inviteEmails.length === 0}
						onClick={() => sendInvites.mutate()}
					>
						Send Invites
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
