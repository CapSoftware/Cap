"use client";

import { Button, Input } from "@cap/ui";
import {
	faCloudUpload,
	faSpinner,
	faTrash,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Image from "next/image";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Tooltip } from "./Tooltip";

export interface FileInputProps {
	onChange?: (file: File | null) => void;
	disabled?: boolean;
	id?: string;
	name?: string;
	className?: string;
	notDraggingClassName?: string;
	initialPreviewUrl?: string | null;
	onRemove?: () => void;
	isLoading?: boolean;
	height?: string | number;
	previewIconSize?: string | number;
}

export const FileInput: React.FC<FileInputProps> = ({
	onChange,
	disabled = false,
	id = "file",
	name = "file",
	className = "",
	notDraggingClassName = "",
	initialPreviewUrl = null,
	onRemove,
	isLoading = false,
	height = "44px",
	previewIconSize = 20,
}) => {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(
		initialPreviewUrl,
	);

	// Update preview URL when initialPreviewUrl changes
	useEffect(() => {
		setPreviewUrl(initialPreviewUrl);
	}, [initialPreviewUrl]);

	// Clean up the preview URL when component unmounts
	useEffect(() => {
		return () => {
			if (previewUrl && previewUrl !== initialPreviewUrl) {
				URL.revokeObjectURL(previewUrl);
			}
		};
	}, [previewUrl, initialPreviewUrl]);

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
			// Validate file type - only allow jpg, jpeg, svg, and png
			const allowedTypes = [
				"image/jpeg",
				"image/jpg",
				"image/png",
				"image/svg+xml",
			];
			if (!allowedTypes.includes(file.type)) {
				toast.error("Please select a JPG, JPEG, PNG, or SVG file");
				if (fileInputRef.current) {
					fileInputRef.current.value = "";
				}
				return;
			}

			// Validate file size (limit to 2MB)
			if (file.size > 2 * 1024 * 1024) {
				toast.error("File size must be less than 2MB");
				if (fileInputRef.current) {
					fileInputRef.current.value = "";
				}
				return;
			}

			// Clean up previous preview URL if it's not the initial preview URL
			if (previewUrl && previewUrl !== initialPreviewUrl) {
				URL.revokeObjectURL(previewUrl);
			}

			// Create a new preview URL for immediate feedback
			const newPreviewUrl = URL.createObjectURL(file);
			setPreviewUrl(newPreviewUrl);
			setSelectedFile(null);

			// Call the onChange callback
			if (onChange) {
				onChange(file);
			}
		}
	};

	const handleRemove = (e: React.MouseEvent) => {
		e.stopPropagation();

		// Clean up preview URL if it's not the initial preview URL
		if (previewUrl && previewUrl !== initialPreviewUrl) {
			URL.revokeObjectURL(previewUrl);
		}

		setPreviewUrl(null);
		setSelectedFile(null);

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
		<div className={`relative ${className}`}>
			<div
				style={{
					height: height,
				}}
			>
				{" "}
				{/* Fixed height container to prevent resizing */}
				{selectedFile || previewUrl ? (
					<div className="flex gap-2 items-center p-1.5 rounded-xl border border-dashed bg-gray-1 border-gray-4 h-full">
						<div className="flex flex-1 gap-1.5 items-center">
							<div className="flex flex-1 gap-1 items-center">
								{selectedFile ? (
									<>
										<p className="text-xs font-medium w-fit max-w-[150px] truncate text-gray-12">
											{selectedFile.name}
										</p>
										<p className="text-xs text-gray-10 min-w-fit">
											{(selectedFile.size / 1024).toFixed(1)} KB
										</p>
									</>
								) : (
									<div className="flex gap-2 items-center px-2">
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
											{previewUrl && (
												<Image
													src={previewUrl}
													width={32}
													height={32}
													alt="File preview"
													className="object-cover rounded-full"
												/>
											)}
										</div>
									</div>
								)}
							</div>
						</div>
						<Tooltip content="Remove icon">
							<Button
								variant="outline"
								size="xs"
								className="!p-0 size-7 group mr-2"
								disabled={isLoading || disabled}
								onClick={handleRemove}
							>
								<FontAwesomeIcon
									className="size-2.5 text-gray-12 group-hover:text-gray-1"
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
							"flex gap-3 justify-center items-center px-4 w-full rounded-xl border border-dashed transition-all duration-300 cursor-pointer h-full",
							isDragging
								? "border-blue-500 bg-gray-5"
								: "hover:bg-gray-2 border-gray-5 " + notDraggingClassName,
							isLoading || disabled ? "opacity-50 pointer-events-none" : "",
						)}
					>
						{isLoading ? (
							<FontAwesomeIcon
								className="animate-spin text-gray-10 size-4"
								icon={faSpinner}
							/>
						) : (
							<FontAwesomeIcon
								className="text-gray-10 size-4"
								icon={faCloudUpload}
							/>
						)}
						<p className="text-[13px] truncate text-gray-11">
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
				accept="image/jpeg, image/jpg, image/png, image/svg+xml"
				onChange={handleFileChange}
				name={name}
			/>
		</div>
	);
};
