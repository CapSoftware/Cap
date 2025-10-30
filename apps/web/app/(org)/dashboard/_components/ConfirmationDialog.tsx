"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@cap/ui";

interface ConfirmationDialogProps {
	open: boolean;
	title?: string;
	description?: string;
	icon?: React.JSX.Element;
	confirmLabel?: string;
	cancelLabel?: string;
	confirmVariant?: "destructive" | "primary" | "dark" | "gray" | "outline";
	loading?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function ConfirmationDialog({
	open,
	title = "Are you sure?",
	description,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	confirmVariant = "dark",
	loading = false,
	icon,
	onConfirm,
	onCancel,
}: ConfirmationDialogProps) {
	return (
		<Dialog open={open} onOpenChange={(open) => !open && onCancel()}>
			<DialogContent className="p-0 w-[calc(100%-20px)] max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader icon={icon}>
					<DialogTitle className="text-lg text-gray-12">{title}</DialogTitle>
				</DialogHeader>
				<p className="p-5 text-[14px] leading-5 text-gray-11">{description}</p>
				<DialogFooter>
					<Button
						onClick={(e) => {
							e.stopPropagation();
							onCancel();
						}}
						variant="gray"
						size="sm"
						disabled={loading}
					>
						{cancelLabel}
					</Button>
					<Button
						onClick={(e) => {
							e.stopPropagation();
							onConfirm();
						}}
						variant={confirmVariant}
						size="sm"
						spinner={loading}
						disabled={loading}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
