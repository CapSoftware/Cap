"use client";
import { Button } from "@cap/ui";
import { Plus } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@cap/ui";
import { NewSpace } from "@/components/forms/NewSpace";
import { useRouter } from "next/navigation";

export const EmptySpaceState = () => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { refresh } = useRouter();

  return (
    <div className="flex flex-col justify-center items-center pt-20 space-y-6 text-center">
      <div className="flex justify-center items-center w-20 h-20 rounded-full bg-gray-3">
        <svg
          width="40"
          height="40"
          viewBox="0 0 40 40"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M6.25 33.75V8.75C6.25 7.36929 7.36929 6.25 8.75 6.25H31.25C32.6307 6.25 33.75 7.36929 33.75 8.75V26.25C33.75 27.6307 32.6307 28.75 31.25 28.75H11.25L6.25 33.75Z"
            stroke="#9CA3AF"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M15 16.25H25"
            stroke="#9CA3AF"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M15 21.25H21.25"
            stroke="#9CA3AF"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="space-y-2 max-w-xs">
        <h3 className="text-xl font-medium text-gray-12">No spaces yet</h3>
        <p className="text-gray-11">
          Create a space to collaborate and share caps with your team
        </p>
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <Button
          variant="dark"
          onClick={() => setDialogOpen(true)}
          className="flex gap-1.5 items-center"
        >
          <Plus className="size-4" />
          Create a Space
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new Space</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            <NewSpace
              onSpaceCreated={() => {
                setDialogOpen(false);
                refresh();
              }}
            />
          </DialogDescription>
        </DialogContent>
      </Dialog>
    </div>
  );
};
