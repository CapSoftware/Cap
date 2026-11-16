"use client";

import { Button } from "@cap/ui";
import { ImageUpload } from "@cap/web-domain";
import { faImage } from "@fortawesome/free-solid-svg-icons/faImage";
import { faTrash } from "@fortawesome/free-solid-svg-icons/faTrash";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { Tooltip } from "@/components/Tooltip";

interface ProfileImageProps {
	initialPreviewUrl?: ImageUpload.ImageUrl | null;
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
	const [previewUrl, setPreviewUrl] = useState<ImageUpload.ImageUrl | null>(
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
		setPreviewUrl(ImageUpload.ImageUrl.make(objectUrl));
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
		<div className="flex gap-3 items-center">
			<div
				className={clsx(
					"flex overflow-hidden justify-center items-center rounded-full border size-10 shrink-0 bg-gray-3 border-gray-4",
					previewUrl ? "border-solid" : "border-dashed",
				)}
			>
				{previewUrl ? (
					<SignedImageUrl
						image={previewUrl}
						name={userName || "User"}
						letterClass="text-base"
						className="size-full"
					/>
				) : (
					<FontAwesomeIcon icon={faImage} className="size-4 text-gray-8" />
				)}
			</div>
			<input
				type="file"
				className="hidden h-0"
				accept="image/jpeg, image/jpg, image/png, image/svg+xml"
				ref={fileInputRef}
				onChange={handleFileChange}
				disabled={disabled || isLoading}
			/>
			<Button
				type="button"
				variant="secondary"
				className="px-3.5 h-8"
				disabled={disabled || isLoading || isRemoving}
				size="xs"
				onClick={handleUploadClick}
				spinner={isUploading}
				spinnerColor="#646464"
				spinnerBorderColor="rgba(0,0,0,0.1)"
			>
				{isUploading ? "Uploading..." : "Upload image"}
			</Button>
			{(previewUrl || isRemoving) && (
				<Tooltip content="Remove image">
					<Button
						type="button"
						variant="secondary"
						className="p-0 rounded-full size-8"
						disabled={disabled || isLoading || isRemoving}
						size="icon"
						onClick={handleRemove}
						aria-label="Remove image"
						spinnerClassName="mr-0"
						spinnerColor="#646464"
						spinnerBorderColor="rgba(0,0,0,0.1)"
						spinner={isRemoving}
					>
						{isRemoving ? null : (
							<FontAwesomeIcon
								icon={faTrash}
								className="mx-auto size-2.5 text-gray-11"
							/>
						)}
					</Button>
				</Tooltip>
			)}
		</div>
	);
}
