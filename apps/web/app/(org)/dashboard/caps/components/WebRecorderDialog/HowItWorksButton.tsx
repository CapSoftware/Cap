"use client";

import { CircleHelpIcon } from "lucide-react";

interface HowItWorksButtonProps {
  onClick: () => void;
}

export const HowItWorksButton = ({ onClick }: HowItWorksButtonProps) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-center gap-1 text-xs font-medium transition-colors hover:text-blue-12"
    >
      <CircleHelpIcon className="size-3.5" aria-hidden />
      How it works (tips)
    </button>
  );
};
