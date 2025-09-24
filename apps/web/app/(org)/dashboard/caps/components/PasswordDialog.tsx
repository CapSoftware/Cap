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
import type { Video } from "@cap/web-domain";
import { faLock } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
	removeVideoPassword,
	setVideoPassword,
} from "@/actions/videos/password";

interface PasswordDialogProps {
	isOpen: boolean;
	onClose: () => void;
	videoId: Video.VideoId;
	hasPassword: boolean;
	onPasswordUpdated: (protectedStatus: boolean) => void;
}

export const PasswordDialog: React.FC<PasswordDialogProps> = ({
	isOpen,
	onClose,
	videoId,
	hasPassword,
	onPasswordUpdated,
}) => {
	const [password, setPassword] = useState("");

	const updatePassword = useMutation({
		mutationFn: () =>
			setVideoPassword(videoId, password).then((v) => {
				if (v.success) return v.value;
				throw new Error(v.error);
			}),
		onSuccess: (result) => {
			toast.success(result);
			onPasswordUpdated(true);
			onClose();
		},
		onError: (e) => {
			toast.error(e.message);
		},
	});

	const removePassword = useMutation({
		mutationFn: () =>
			removeVideoPassword(videoId).then((v) => {
				if (v.success) return v.value;
				throw new Error(v.error);
			}),
		onSuccess: (result) => {
			toast.success(result);
			onPasswordUpdated(false);
			onClose();
		},
		onError: (e) => {
			toast.error(e.message);
		},
	});

	const pending = removePassword.isPending || updatePassword.isPending;

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="p-0 w-full max-w-sm rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faLock} className="size-3.5" />}
					description={
						hasPassword
							? "Update or remove the password for this video"
							: "Restrict access to this video with a password"
					}
				>
					<DialogTitle>Password Protection</DialogTitle>
				</DialogHeader>
				<div className="p-5 space-y-4">
					<Input
						type="password"
						placeholder={hasPassword ? "Enter new password" : "Password"}
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</div>
				<DialogFooter className="p-5 border-t border-gray-4">
					{hasPassword && (
						<Button
							size="sm"
							variant="destructive"
							onClick={() => removePassword.mutate()}
							disabled={pending}
						>
							Remove
						</Button>
					)}
					<Button
						size="sm"
						variant="dark"
						onClick={() => updatePassword.mutate()}
						spinner={pending}
						disabled={pending}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
