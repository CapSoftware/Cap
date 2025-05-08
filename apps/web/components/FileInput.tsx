"use client";

import { Button, Input } from "@cap/ui";
import { faCloudUpload, faSpinner } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export interface FileInputProps {
  onChange?: (file: File | null) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  initialPreviewUrl?: string | null;
  onRemove?: () => void;
  isLoading?: boolean;
}

export const FileInput: React.FC<FileInputProps> = ({
  onChange,
  disabled = false,
  id = "file",
  name = "file",
  className = "",
  initialPreviewUrl = null,
  onRemove,
  isLoading = false,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialPreviewUrl);

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
          const event = new Event('change', { bubbles: true });
          fileInputRef.current.dispatchEvent(event);
        } catch (error) {
          console.error('Error handling file drop:', error);
        }
      }
    }
  };

  const handleFileChange = () => {
    const file = fileInputRef.current?.files?.[0];
    if (file) {
      // Validate file type
      if (!file.type.startsWith('image/')) {
        toast.error("Please select an image file");
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        return;
      }
      
      // Validate file size (limit to 2MB)
      if (file.size > 2 * 1024 * 1024) {
        toast.error("File size must be less than 2MB");
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
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
      setSelectedFile(file);
      
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
      fileInputRef.current.value = '';
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
      <div className="h-[46.5px]"> {/* Fixed height container to prevent resizing */}
        {(selectedFile || previewUrl) ? (
          <div className="flex gap-2 items-center p-1.5 rounded-xl border border-gray-4 h-full">
            <div className="flex flex-1 gap-1.5 items-center">
              <div className="overflow-hidden relative flex-shrink-0 rounded-md size-5">
                {previewUrl && (
                  <Image 
                    src={previewUrl} 
                    alt="File preview" 
                    fill 
                    className="object-contain"
                  />
                )}
              </div>
              <div className="flex flex-1 gap-1 items-center">
                {selectedFile ? (
                  <>
                    <p className="text-xs font-medium w-fit max-w-[150px] truncate text-gray-12">{selectedFile.name}</p>
                    <p className="text-xs text-gray-10 min-w-fit">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                  </>
                ) : (
                  <p className="text-xs font-medium text-gray-12">Current file</p>
                )}
              </div>
            </div>
            <Button
              variant="destructive"
              style={{
                "--gradient-border-radius": "8px",
              } as React.CSSProperties}
              size="xs"
              className="min-w-[80px]"
              disabled={isLoading || disabled}
              onClick={handleRemove}
            >
              {isLoading ? (
                <FontAwesomeIcon icon={faSpinner} className="animate-spin" />
              ) : (
                <>
                  Remove
                </>
              )}
            </Button>
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
              isDragging ? "border-blue-500 bg-gray-5" : "hover:bg-gray-4 border-gray-8",
              isLoading || disabled ? "opacity-50 pointer-events-none" : ""
            )}
          >
            {isLoading ? (
              <FontAwesomeIcon
                className="animate-spin text-gray-10 size-5"
                icon={faSpinner}
              />
            ) : (
              <FontAwesomeIcon
                className="text-gray-10 size-5"
                icon={faCloudUpload}
              />
            )}
            <p className="text-sm truncate text-gray-11">
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
        accept="image/*"
        onChange={handleFileChange}
        name={name}
      />
    </div>
  );
};
