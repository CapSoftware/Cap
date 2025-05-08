"use client";

import { Button, CardDescription, Input, Label } from "@cap/ui";
import { faCloudUpload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

interface OrganizationIconProps {
  isOwner: boolean;
  showOwnerToast: () => void;
}

export const OrganizationIcon = ({
  isOwner,
  showOwnerToast,
}: OrganizationIconProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  
  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (isOwner) {
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
    if (isOwner) {
      e.dataTransfer.dropEffect = "copy";
      setIsDragging(true);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    if (!isOwner) {
      showOwnerToast();
      return;
    }
    
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
  
  // Clean up the preview URL when component unmounts
  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const handleFileChange = () => {
    if (!isOwner) {
      showOwnerToast();
      return;
    }
    
    const file = fileInputRef.current?.files?.[0];
    if (file) {
      // Clean up previous preview URL
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      
      // Create a new preview URL
      const newPreviewUrl = URL.createObjectURL(file);
      setPreviewUrl(newPreviewUrl);
      setSelectedFile(file);
      
      // Here you would typically upload the file to your server
      console.log("File selected:", file);
    }
  };

  return (
    <div className="relative flex-1">
      <div className="space-y-1">
        <Label htmlFor="icon">Organization Icon</Label>
        <CardDescription className="w-full max-w-[400px]">
          Upload a custom logo or icon for your organization and make it
          unique.
        </CardDescription>
      </div>
      <div className="relative mt-4">
      <div className="flex absolute top-0 left-0 justify-center items-center w-full h-full rounded-xl backdrop-blur-md bg-gray/50">
        <p className="text-sm text-gray-11">Coming soon...</p>
      </div>
        {selectedFile ? (
          <div className="flex gap-2 items-center p-1.5 rounded-xl border border-gray-4">
            <div className="flex flex-1 gap-1.5 items-center">
              <div className="overflow-hidden relative flex-shrink-0 rounded-md size-6">
                {previewUrl && (
                  <Image 
                    src={previewUrl} 
                    alt="Selected file preview" 
                    fill 
                    className="object-contain"
                  />
                )}
              </div>
              <div className="flex flex-1 gap-1 items-center">
                <p className="text-xs font-medium w-fit max-w-[150px] truncate text-gray-12">{selectedFile.name}</p>
                <p className="text-xs text-gray-10 min-w-fit">{(selectedFile.size / 1024).toFixed(1)} KB</p>
              </div>
            </div>
            <Button
              variant="destructive"
              style={{
                "--gradient-border-radius": "8px",
              } as React.CSSProperties}
              size="xs"
              className="min-w-[80px]"
              onClick={(e) => {
                e.stopPropagation();
                setSelectedFile(null);
                setPreviewUrl(null);
                if (fileInputRef.current) {
                  fileInputRef.current.value = '';
                }
              }}
            >
              Remove
            </Button>
          </div>
        ) : (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={clsx(
              "flex gap-3 justify-center items-center px-4 w-full rounded-xl border border-dashed transition-all duration-300 cursor-pointer py-[12px]",
              isDragging ? "border-blue-500 bg-gray-5" : "hover:bg-gray-4 border-gray-8"
            )}
          >
            <FontAwesomeIcon
              className="text-gray-10 size-5"
              icon={faCloudUpload}
            />
            <p className="text-sm truncate text-gray-11">
              Choose a file or drag & drop it here
            </p>
          </div>
        )}
        <Input
          className="hidden"
          type="file"
          ref={fileInputRef}
          id="icon"
          disabled={!isOwner}
          accept="image/*"
          onChange={handleFileChange}
          name="icon"
        />
      </div>   
    </div>
  );
};
