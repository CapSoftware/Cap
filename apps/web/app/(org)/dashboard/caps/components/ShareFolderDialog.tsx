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
import type { Folder } from "@cap/web-domain";
import {
	faCopy,
	faShareNodes,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	disableFolderSharing,
	enableFolderSharing,
	getFolderShareState,
} from "@/actions/folders/share-folder";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	folderId: Folder.FolderId;
}

export const ShareFolderDialog: React.FC<Props> = ({
	open,
	onOpenChange,
	folderId,
}) => {
	const [isShared, setIsShared] = useState(false);
	const [slug, setSlug] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [hydrated, setHydrated] = useState(false);

	useEffect(() => {
		if (!open) return;
		setHydrated(false);
		getFolderShareState(folderId)
			.then((state) => {
				setIsShared(state.isShared);
				setSlug(state.slug);
			})
			.catch(() => toast.error("Failed to load share state"))
			.finally(() => setHydrated(true));
	}, [open, folderId]);

	const baseUrl =
		typeof window !== "undefined" ? window.location.origin : "";
	const shareUrl = slug ? `${baseUrl}/share/f/${slug}` : "";

	const handleEnable = async () => {
		setLoading(true);
		try {
			const res = await enableFolderSharing(folderId);
			setSlug(res.slug);
			setIsShared(true);
			toast.success("Folder shared. Link copied to clipboard.");
			try {
				await navigator.clipboard.writeText(`${baseUrl}/share/f/${res.slug}`);
			} catch {}
		} catch {
			toast.error("Failed to enable sharing");
		} finally {
			setLoading(false);
		}
	};

	const handleDisable = async () => {
		setLoading(true);
		try {
			await disableFolderSharing(folderId);
			setIsShared(false);
			setSlug(null);
			toast.success("Sharing disabled");
		} catch {
			toast.error("Failed to disable sharing");
		} finally {
			setLoading(false);
		}
	};

	const handleCopy = async () => {
		if (!shareUrl) return;
		try {
			await navigator.clipboard.writeText(shareUrl);
			toast.success("Link copied");
		} catch {
			toast.error("Failed to copy");
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[calc(100%-20px)] max-w-[480px]">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faShareNodes} className="size-3.5" />}
				>
					<DialogTitle>Share folder</DialogTitle>
				</DialogHeader>
				<div className="p-5 space-y-4">
					<p className="text-sm text-gray-10">
						Anyone with the link can view every video in this folder in
						read-only mode. No account required. Enabling will also flip
						every video in the folder to public; disabling reverts them.
					</p>
					{hydrated && isShared && shareUrl ? (
						<div className="space-y-2">
							<label className="text-xs font-medium text-gray-11">
								Public link
							</label>
							<div className="flex gap-2">
								<Input value={shareUrl} readOnly className="flex-1 text-xs" />
								<Button
									size="sm"
									variant="gray"
									onClick={handleCopy}
									className="flex gap-1.5 items-center"
								>
									<FontAwesomeIcon icon={faCopy} className="size-3" />
									Copy
								</Button>
							</div>
						</div>
					) : null}
				</div>
				<DialogFooter>
					<Button
						size="sm"
						variant="gray"
						onClick={() => onOpenChange(false)}
						disabled={loading}
					>
						Close
					</Button>
					{hydrated && isShared ? (
						<Button
							size="sm"
							variant="destructive"
							onClick={handleDisable}
							spinner={loading}
							disabled={loading}
						>
							Disable sharing
						</Button>
					) : (
						<Button
							size="sm"
							variant="dark"
							onClick={handleEnable}
							spinner={loading}
							disabled={loading || !hydrated}
						>
							Enable sharing
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
