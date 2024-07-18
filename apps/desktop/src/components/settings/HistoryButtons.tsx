"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";

import { useRouter } from "next/navigation";

export default function HistoryButtons() {
  const router = useRouter();
  const historyButtons = [
    {
      name: "back",
      icon: <ArrowLeft className="w-5 h-5" />,
      onClick: () => router.back(),
    },
    {
      name: "forward",
      icon: <ArrowRight className="w-5 h-5" />,
      onClick: () => router.forward(),
    },
  ];

  return (
    <div className="flex items-center gap-2">
      {historyButtons.map((arrow) => (
        <button
          key={arrow.name}
          className="text-[#323232]"
          onClick={arrow.onClick}
        >
          {arrow.icon}
        </button>
      ))}
    </div>
  );
}