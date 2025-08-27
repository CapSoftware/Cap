"use client";

import { Button } from "@cap/ui";
import { userIsPro } from "@cap/utils";
import { faCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { UpgradeModal } from "@/components/UpgradeModal";
import { RecorderDialog } from "./RecorderDialog";

type RecordingState = "idle" | "countdown" | "recording" | "uploading" | "stopping" | "stopped";

export function StartRecordingButton({
  size = "md",
}: {
  size?: "sm" | "lg" | "md";
}) {
  const { user } = useDashboardContext();
  const router = useRouter();
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");

  const handleClick = () => {
    if (recordingState === "recording") {
      // Stop recording - handled by the dialog
      return;
    }
    setRecorderOpen(true);
  };

  const handleRecordingComplete = (videoId: string) => {
    router.push(`/dashboard/caps/${videoId}`);
    router.refresh();
  };

  const getButtonText = () => {
    switch (recordingState) {
      case "countdown":
        return "Starting...";
      case "recording":
        return "Stop Recording";
      case "stopping":
      case "uploading":
        return "Processing...";
      default:
        return "Start Recording";
    }
  };

  const getButtonVariant = () => {
    return recordingState === "recording" ? "destructive" : "primary";
  };

  return (
    <>
      <Button
        onClick={handleClick}
        variant={getButtonVariant()}
        className="flex gap-2 items-center"
        size={size}
        disabled={["countdown", "stopping", "uploading"].includes(recordingState)}
      >
        <FontAwesomeIcon 
          className={`size-3.5 ${
            recordingState === "recording" ? "text-white" : "text-red-500"
          }`} 
          icon={faCircle} 
        />
        {getButtonText()}
      </Button>

      <RecorderDialog
        open={recorderOpen}
        onOpenChange={setRecorderOpen}
        onComplete={handleRecordingComplete}
        onStateChange={setRecordingState}
      />

      <UpgradeModal
        open={upgradeModalOpen}
        onOpenChange={setUpgradeModalOpen}
      />
    </>
  );
}
