"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@cap/ui";
import { CreateAppForm } from "./create-app-form";

export function CreateAppDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="p-0 w-[calc(100%-20px)] max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader>
					<DialogTitle className="text-lg text-gray-12">New app</DialogTitle>
				</DialogHeader>
				<div className="p-5">
					{open && (
						<CreateAppForm
							onCancel={() => onOpenChange(false)}
							onDone={() => onOpenChange(false)}
						/>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
