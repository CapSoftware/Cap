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

export const InviteDialog = ({ isOpen, setIsOpen }: InviteDialogProps) => {
	const router = useRouter();
	const { activeOrganization } = useDashboardContext();
	const [inviteEmails, setInviteEmails] = useState<string[]>([]);
	const [emailInput, setEmailInput] = useState("");
	const emailInputId = useId();
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	useEffect(() => {
		if (!isOpen) {
			setInviteEmails([]);
			setEmailInput("");
		}
	}, [isOpen]);

	const handleAddEmails = () => {
		const newEmails = emailInput
			.split(",")
			.map((email) => email.trim().toLowerCase())
			.filter((email) => email !== "");

		const invalidEmails = newEmails.filter((email) => !emailRegex.test(email));
		if (invalidEmails.length > 0) {
			toast.error(
				`Invalid email${invalidEmails.length > 1 ? "s" : ""}: ${invalidEmails.join(", ")}`,
			);
		}

		const validEmails = newEmails.filter((email) => emailRegex.test(email));
		setInviteEmails([...new Set([...inviteEmails, ...validEmails])]);
		setEmailInput("");
	};

	const handleRemoveEmail = (email: string) => {
		setInviteEmails(inviteEmails.filter((e) => e !== email));
	};

	const sendInvites = useMutation({
		mutationFn: async () => {
			if (!activeOrganization?.organization.id) {
				throw new Error("No active organization");
			}
			return await sendOrganizationInvites(
				inviteEmails,
				activeOrganization.organization.id,
			);
		},
		onSuccess: (result) => {
			if (result.failedEmails.length > 0) {
				toast.warning(
					`Invites sent, but delivery failed for: ${result.failedEmails.join(", ")}`,
				);
			} else {
				toast.success("Invites sent successfully");
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
