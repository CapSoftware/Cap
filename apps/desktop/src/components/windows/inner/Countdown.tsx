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

  return countdown > 0 ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        backgroundColor: "rgba(0, 0, 0, 0.5)",
      }}
    >
      <span className="text-white text-6xl font-bold">{countdown}</span>
    </div>
  ) : null;
};
