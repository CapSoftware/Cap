"use client";

import { Button } from "@cap/ui";
import { faImage } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Image from "next/image";
import { useRef, useState } from "react";

interface ProfileImageProps {
	initialPreviewUrl?: string | null;
	onChange?: (file: File | null) => void;
	onRemove?: () => void;
	disabled?: boolean;
	isLoading?: boolean;
}

export function ProfileImage({
	initialPreviewUrl,
	onChange,
	onRemove,
	disabled = false,
	isLoading = false,
}: ProfileImageProps) {
	const [previewUrl, setPreviewUrl] = useState<string | null>(
		initialPreviewUrl || null,
	);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [removingImage, setRemovingImage] = useState(false);

	const handleFileChange = () => {
		const file = fileInputRef.current?.files?.[0];
		if (file) {
			const objectUrl = URL.createObjectURL(file);
			setPreviewUrl(objectUrl);
			onChange?.(file);
		}
	};

	const handleRemove = () => {
		setRemovingImage(true);
		try {
			setPreviewUrl(null);
			if (fileInputRef.current) {
				fileInputRef.current.value = "";
			}
			onRemove?.();
		} finally {
			setRemovingImage(false);
		}
	};

	const handleUploadClick = () => {
		if (!disabled && !isLoading && !removingImage) {
			fileInputRef.current?.click();
		}
	};

	return (
		<div className="rounded-xl border border-dashed bg-gray-2 h-fit border-gray-4">
			<div className="flex gap-5 p-5">
				<div
					className={clsx(
						"flex justify-center items-center rounded-full border size-14 bg-gray-3 border-gray-6",
						previewUrl ? "border-solid" : "border-dashed",
					)}
				>
					{previewUrl ? (
						<Image
							src={previewUrl}
							alt="Profile Image"
							width={56}
							className="object-cover rounded-full size-14"
							height={56}
						/>
					) : (
						<FontAwesomeIcon icon={faImage} className="size-4 text-gray-9" />
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
				<div className="space-y-3">
					<div className="flex gap-2">
						{!removingImage && (
							<Button
								type="button"
								variant="gray"
								disabled={disabled || isLoading}
								size="xs"
								onClick={handleUploadClick}
								spinner={isLoading}
							>
								{isLoading ? "Uploading..." : "Upload Image"}
							</Button>
						)}
						{previewUrl && !removingImage && (
							<Button
								type="button"
								variant="gray"
								disabled={disabled || isLoading || removingImage}
								size="xs"
								onClick={handleRemove}
							>
								{removingImage ? "Removing..." : "Remove"}
							</Button>
						)}
					</div>
					<p className="text-xs text-gray-10">Recommended size: 120x120</p>
				</div>
			</div>
		</div>
	);
}
