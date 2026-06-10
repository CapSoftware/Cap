"use client";

import { MAX_CTA_LABEL_LENGTH, type VideoCta } from "@cap/database/types";
import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
	Switch,
} from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { faUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { editCta } from "@/actions/videos/edit-cta";

export const CtaDialog = ({
	isOpen,
	onClose,
	videoId,
	cta,
}: {
	isOpen: boolean;
	onClose: () => void;
	videoId: Video.VideoId;
	cta?: VideoCta | null;
}) => {
	const { refresh } = useRouter();
	const enabledId = useId();
	const labelId = useId();
	const urlId = useId();
	const [enabled, setEnabled] = useState(cta?.enabled ?? false);
	const [label, setLabel] = useState(cta?.label ?? "");
	const [url, setUrl] = useState(cta?.url ?? "");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (isOpen) {
			setEnabled(cta?.enabled ?? false);
			setLabel(cta?.label ?? "");
			setUrl(cta?.url ?? "");
		}
	}, [isOpen, cta]);

	const handleSave = async () => {
		setIsSaving(true);
		try {
			const next: VideoCta | null = enabled
				? { enabled: true, label: label.trim(), url: url.trim() }
				: null;
			await editCta(videoId, next);
			toast.success(
				enabled ? "Call to action saved" : "Call to action removed",
			);
			refresh();
			onClose();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to save call to action",
			);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faUpRightFromSquare} />}
					description="Show a button in the top-right of your video that links anywhere you like."
				>
					<DialogTitle>Call to action</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-4 p-5">
					<div className="flex justify-between items-center">
						<Label htmlFor={enabledId}>Show call to action</Label>
						<Switch
							id={enabledId}
							checked={enabled}
							onCheckedChange={setEnabled}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor={labelId}>Button label</Label>
						<Input
							id={labelId}
							placeholder="Book a meeting"
							value={label}
							maxLength={MAX_CTA_LABEL_LENGTH}
							disabled={!enabled}
							onChange={(e) => setLabel(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor={urlId}>Link (https)</Label>
						<Input
							id={urlId}
							type="url"
							placeholder="https://cal.com/your-handle"
							value={url}
							disabled={!enabled}
							onChange={(e) => setUrl(e.target.value)}
						/>
					</div>
				</div>
				<DialogFooter className="p-5 border-t border-gray-4">
					<Button
						size="sm"
						variant="gray"
						onClick={onClose}
						disabled={isSaving}
					>
						Cancel
					</Button>
					<Button
						size="sm"
						variant="dark"
						onClick={handleSave}
						disabled={
							isSaving ||
							(enabled && (!label.trim() || !url.trim().startsWith("https://")))
						}
					>
						{isSaving ? "Saving..." : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
