"use client";

import clsx from "clsx";

// Default palette of 26 visually distinct Tailwind background color classes for Avatar
const avatarDefaultPalette = [
  "bg-blue-200",
  "bg-blue-300",
  "bg-sky-200",
  "bg-sky-300",
  "bg-cyan-200",
  "bg-cyan-300",
  "bg-teal-200",
  "bg-teal-300",
  "bg-emerald-200",
  "bg-emerald-300",
  "bg-green-200",
  "bg-green-300",
  "bg-lime-200",
  "bg-lime-300",
  "bg-yellow-200",
  "bg-yellow-300",
  "bg-indigo-200",
  "bg-indigo-300",
  "bg-purple-200",
  "bg-purple-300",
  "bg-pink-200",
  "bg-pink-300",
  "bg-fuchsia-200",
  "bg-fuchsia-300",
  "bg-rose-200",
  "bg-rose-300",
];

// Palette of slightly darker text colors to match each background
const avatarTextPalette = [
  "text-blue-600",
  "text-blue-700",
  "text-sky-600",
  "text-sky-700",
  "text-cyan-600",
  "text-cyan-700",
  "text-teal-600",
  "text-teal-700",
  "text-emerald-600",
  "text-emerald-700",
  "text-green-600",
  "text-green-700",
  "text-lime-600",
  "text-lime-700",
  "text-yellow-600",
  "text-yellow-700",
  "text-indigo-600",
  "text-indigo-700",
  "text-purple-600",
  "text-purple-700",
  "text-pink-600",
  "text-pink-700",
  "text-fuchsia-600",
  "text-fuchsia-700",
  "text-rose-600",
  "text-rose-700",
];

export interface AvatarProps {
  name: string | null | undefined;
  className?: string;
  letterClass?: string;
}

export const Avatar: React.FC<AvatarProps> = ({
  name,
  className = "",
  letterClass = "text-xs",
}) => {
  const initial = name?.[0]?.toUpperCase() || "A";
  const charCode = initial.charCodeAt(0);
  const isAlpha = charCode >= 65 && charCode <= 90;
  const colorIndex = isAlpha ? charCode - 65 : 25; // fallback to last color for non-alpha
  const bgColor = avatarDefaultPalette[colorIndex];
  const textColor = avatarTextPalette[colorIndex];

  return (
    <div
      className={clsx(
        "flex justify-center items-center rounded-full size-4",
        bgColor,
        className
      )}
    >
      <span className={clsx(letterClass, textColor)}>{initial}</span>
    </div>
  );
};
