"use client";

import { useEffect, useState } from "react";

interface CountdownOverlayProps {
  countdownFrom: number;
  onCountdownFinish: () => void;
}

export const Countdown: React.FC<CountdownOverlayProps> = ({
  countdownFrom,
  onCountdownFinish,
}) => {
  const [countdown, setCountdown] = useState(countdownFrom);

  useEffect(() => {
    if (countdown === 0) {
      console.log("Countdown finished");
      onCountdownFinish();
      return;
    }

    const timerId = setTimeout(() => setCountdown(countdown - 1), 1000);

    return () => clearTimeout(timerId);
  }, [countdown, onCountdownFinish]);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center rounded-[16px]"
      style={{
        backgroundColor: "rgba(0, 0, 0, 0.75)",
      }}
    >
      <span className="text-white text-6xl font-bold">{countdown}</span>
    </div>
  );
};
