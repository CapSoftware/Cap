"use client";

import {
	faCloudUpload,
	faSpinner,
	faTrash,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Button, Input, LoadingSpinner } from "@inflight/ui";
import { ImageUpload } from "@inflight/web-domain";
import clsx from "clsx";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SignedImageUrl } from "./SignedImageUrl";
import { Tooltip } from "./Tooltip";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);
const DEFAULT_MAX_FILE_SIZE_BYTES = 3 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = Array.from(ALLOWED_IMAGE_TYPES).join(",");

export interface FileInputProps {
	onChange?: (file: File | null) => void;
	disabled?: boolean;
	id?: string;
	name?: string;
	containerStyle?: React.CSSProperties;
	className?: string;
	notDraggingClassName?: string;
	initialPreviewUrl?: ImageUpload.ImageUrl | null;
	onRemove?: () => void;
	isLoading?: boolean;
	height?: string | number;
	previewIconSize?: string | number;
	maxFileSizeBytes?: number;
}

export const FileInput: React.FC<FileInputProps> = ({
	onChange,
	containerStyle,
	disabled = false,
	id = "file",
	name = "file",
	className = "",
	notDraggingClassName = "",
	initialPreviewUrl = null,
	onRemove,
	isLoading = false,
	height = 44,
	previewIconSize = 20,
	maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES,
}) => {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [previewUrl, setPreviewUrl] = useState<ImageUpload.ImageUrl | null>(
		initialPreviewUrl,
	);
	const [isLocalPreview, setIsLocalPreview] = useState(false);

	const previousPreviewRef = useRef<{
		url: string | null;
		isLocal: boolean;
	}>({ url: null, isLocal: false });

	// Update preview URL when initialPreviewUrl changes
	useEffect(() => {
		// Clean up old blob URL if it exists
		if (previousPreviewRef.current.url && previousPreviewRef.current.isLocal) {
			URL.revokeObjectURL(previousPreviewRef.current.url);
		}

		setPreviewUrl(initialPreviewUrl);
		setIsLocalPreview(false);

		previousPreviewRef.current = {
			url: initialPreviewUrl,
			isLocal: false,
		};
	}, [initialPreviewUrl]);

	// Clean up the preview URL when component unmounts
	useEffect(() => {
		return () => {
			if (previewUrl && isLocalPreview) {
				URL.revokeObjectURL(previewUrl);
			}
		};
	}, [previewUrl, isLocalPreview]);

	const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		if (!disabled) {
			setIsDragging(true);
		}
	};

	const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragging(false);
	};

	const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		if (!disabled) {
			e.dataTransfer.dropEffect = "copy";
			setIsDragging(true);
		}
	};

	const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragging(false);

		if (disabled) return;

		const files = e.dataTransfer.files;
		if (files && files.length > 0) {
			// Set the file to the input element
			const file = files[0];

			if (fileInputRef.current && file) {
				try {
					// Create a new DataTransfer instance
					const dataTransfer = new DataTransfer();
					dataTransfer.items.add(file);
					fileInputRef.current.files = dataTransfer.files;

					// Trigger onChange event manually
					const event = new Event("change", { bubbles: true });
					fileInputRef.current.dispatchEvent(event);
				} catch (error) {
					console.error("Error handling file drop:", error);
				}
			}
		}
	};

	const handleFileChange = () => {
		const file = fileInputRef.current?.files?.[0];
		if (file) {
			// Validate file type - only allow jpg, jpeg, and png
			const normalizedType = file.type.toLowerCase();
			if (!ALLOWED_IMAGE_TYPES.has(normalizedType)) {
				toast.error("Please select a PNG or JPEG image");
				if (fileInputRef.current) {
					fileInputRef.current.value = "";
				}
				return;
			}

			// Validate file size
			if (file.size > maxFileSizeBytes) {
				const maxSizeMB = maxFileSizeBytes / (1024 * 1024);
				toast.error(`File size must be ${maxSizeMB}MB or less`);
				if (fileInputRef.current) {
					fileInputRef.current.value = "";
				}
				return;
			}

			// Clean up previous preview URL if it's a local blob URL
			if (previewUrl && isLocalPreview) {
				URL.revokeObjectURL(previewUrl);
			}

			// Create a new preview URL for immediate feedback
			const newPreviewUrl = URL.createObjectURL(file);
			setPreviewUrl(ImageUpload.ImageUrl.make(newPreviewUrl));
			setIsLocalPreview(true);

			previousPreviewRef.current = {
				url: newPreviewUrl,
				isLocal: true,
			};

			// Call the onChange callback
			if (onChange) {
				onChange(file);
			}
		}
	};

	const handleRemove = (e: React.MouseEvent) => {
		e.stopPropagation();

		// Clean up preview URL if it's a local blob URL
		if (previewUrl && isLocalPreview) {
			URL.revokeObjectURL(previewUrl);
		}

		setPreviewUrl(null);
		setIsLocalPreview(false);

		previousPreviewRef.current = {
			url: null,
			isLocal: false,
		};

		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}

		// Call the onRemove callback
		if (onRemove) {
			onRemove();
		}

		// Call the onChange callback with null
		if (onChange) {
			onChange(null);
		}
	};

	return (
		<div className={clsx("relative", className)}>
			<div
				style={{
					height,
					...containerStyle,
				}}
			>
				{/* Fixed height container to prevent resizing */}
				{isLoading ? (
					<div className="flex h-full items-center gap-2 rounded-xl border border-dashed border-gray-4 bg-gray-1 px-4 py-1.5">
						<LoadingSpinner themeColors size={16} />
						<p className="truncate text-[13px] text-gray-11">Uploading...</p>
					</div>
				) : previewUrl ? (
					<div className="flex h-full items-center gap-2 rounded-xl border border-dashed border-gray-4 bg-gray-1 px-4 py-1.5">
						<div className="flex flex-1 items-center gap-1.5">
							<div className="flex flex-1 gap-1 items-center">
								<div className="flex gap-2 items-center">
									<p className="text-xs font-medium text-gray-12">
										Current icon:{" "}
									</p>
									<div
										style={{
											width: previewIconSize,
											height: previewIconSize,
										}}
										className="flex overflow-hidden relative flex-shrink-0 justify-center items-center rounded-full"
									>
										<SignedImageUrl
											image={previewUrl}
											name="File preview"
											letterClass="text-lg"
											className="size-full"
										/>
									</div>
								</div>
							</div>
						</div>
						<Tooltip content="Remove icon">
							<Button
								variant="outline"
								size="xs"
								className="!p-0 size-7 group"
								disabled={isLoading || disabled}
								onClick={handleRemove}
							>
								<FontAwesomeIcon
									className="size-2.5 transition-colors text-gray-12 group-hover:text-gray-10"
									icon={faTrash}
								/>
							</Button>
						</Tooltip>
					</div>
				) : (
					<div
						onClick={() => !disabled && fileInputRef.current?.click()}
						onDragEnter={handleDragEnter}
						onDragOver={handleDragOver}
						onDragLeave={handleDragLeave}
						onDrop={handleDrop}
						className={clsx(
							"flex gap-3 justify-center items-center px-4 w-full h-full rounded-xl border border-dashed transition-all duration-300 cursor-pointer",
							isDragging
								? "border-blue-500 bg-gray-5"
								: `border-gray-5 hover:bg-gray-2 ${notDraggingClassName}`,
							isLoading || disabled ? "pointer-events-none opacity-50" : "",
						)}
					>
						{isLoading ? (
							<FontAwesomeIcon
								className="animate-spin size-4 text-gray-10"
								icon={faSpinner}
							/>
						) : (
							<FontAwesomeIcon
								className="size-4 text-gray-10"
								icon={faCloudUpload}
							/>
						)}
						<p className="truncate text-[13px] text-gray-11">
							{isLoading
								? "Uploading..."
								: "Choose a file or drag & drop it here"}
						</p>
					</div>
				)}
			</div>
			<Input
				className="hidden"
				type="file"
				ref={fileInputRef}
				id={id}
				disabled={disabled || isLoading}
				accept={ACCEPTED_IMAGE_TYPES}
				onChange={handleFileChange}
				name={name}
			/>
		</div>
	);
};
