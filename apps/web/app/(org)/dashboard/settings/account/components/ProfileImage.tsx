"use client";

import { Avatar, Button } from "@cap/ui";
import { faImage, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Tooltip } from "@/components/Tooltip";
import { getImageUrl } from "@/lib/get-image-url";

interface ProfileImageProps {
	initialPreviewUrl?: string | null;
	onChange?: (file: File | null) => void;
	onRemove?: () => void;
	disabled?: boolean;
	isUploading?: boolean;
	isRemoving?: boolean;
	userName?: string | null;
}

export function ProfileImage({
	initialPreviewUrl,
	onChange,
	onRemove,
	disabled = false,
	isUploading = false,
	isRemoving = false,
	userName,
}: ProfileImageProps) {
	const [previewUrl, setPreviewUrl] = useState<string | null>(
		initialPreviewUrl || null,
	);
	const [isLocalPreview, setIsLocalPreview] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Reset isRemoving when the parent confirms the operation completed
	useEffect(() => {
		if (initialPreviewUrl !== undefined) {
			setPreviewUrl(initialPreviewUrl);
			setIsLocalPreview(false);
		}
	}, [initialPreviewUrl]);

	const handleFileChange = () => {
		const file = fileInputRef.current?.files?.[0];
		if (!file) return;
		const sizeLimit = 1024 * 1024 * 1;
		if (file.size > sizeLimit) {
			toast.error("File size must be 1MB or less");
			return;
		}
		if (previewUrl && isLocalPreview) {
			URL.revokeObjectURL(previewUrl);
		}
		const objectUrl = URL.createObjectURL(file);
		setPreviewUrl(objectUrl);
		setIsLocalPreview(true);
		onChange?.(file);
	};

	const handleRemove = () => {
		if (previewUrl && isLocalPreview) {
			URL.revokeObjectURL(previewUrl);
		}
		setPreviewUrl(null);
		setIsLocalPreview(false);
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
		onRemove?.();
	};

	const handleUploadClick = () => {
		if (!disabled && !isUploading && !isRemoving) {
			fileInputRef.current?.click();
		}
	};

	const isLoading = isUploading || isRemoving;

	return (
		<div className="rounded-xl border border-dashed bg-gray-2 h-fit border-gray-4">
			<div className="flex gap-5 p-5">
				<div
					className={clsx(
						"flex justify-center items-center rounded-full border size-14 bg-gray-3 border-gray-6",
						previewUrl ? "border-solid" : "border-dashed",
					)}
				>
					<Avatar
						name={userName || "User"}
						imageUrl={getImageUrl(previewUrl) ?? undefined}
						className="size-14"
					/>
				</div>
				<input
					type="file"
					className="hidden h-0"
					accept="image/jpeg, image/jpg, image/png, image/svg+xml"
					ref={fileInputRef}
					onChange={handleFileChange}
					disabled={disabled || isLoading}
				/>
				<div className="space-y-3">
					<div className="flex gap-2">
						<Button
							type="button"
							variant="gray"
							disabled={disabled || isLoading || isRemoving}
							size="xs"
							onClick={handleUploadClick}
							spinner={isUploading}
						>
							{isUploading ? "Uploading..." : "Upload Image"}
						</Button>
						{(previewUrl || isRemoving) && (
							<Tooltip content="Remove image">
								<Button
									type="button"
									variant="outline"
									className="p-0 size-8"
									disabled={disabled || isLoading || isRemoving}
									size="icon"
									onClick={handleRemove}
									spinnerClassName="mr-0"
									spinner={isRemoving}
								>
									{isRemoving ? null : (
										<FontAwesomeIcon
											icon={faTrash}
											className="size-2.5 text-gray-12 mx-auto"
										/>
									)}
								</Button>
							</Tooltip>
						)}
					</div>
					<p className="text-xs text-gray-10">Recommended size: 120x120</p>
				</div>
			</div>
		</div>
	);
}
