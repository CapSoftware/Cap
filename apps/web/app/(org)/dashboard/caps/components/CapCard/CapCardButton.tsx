import { Button } from "@cap/ui";
import { Tooltip } from "@/components/Tooltip";
import { type ReactNode } from "react";
import clsx from "clsx";

interface CapCardButtonProps {
  tooltipContent: string;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  className: string;
  icon: () => ReactNode;
}

export const CapCardButton = ({
  tooltipContent,
  onClick = () => {},
  disabled,
  className,
  icon,
}: CapCardButtonProps) => {
  return (
    <Tooltip key={tooltipContent} content={tooltipContent}>
      <Button
        onClick={(e) => onClick?.(e)}
        disabled={disabled}
        className={clsx(
          `!size-8 hover:bg-gray-5 hover:border-gray-7 rounded-full min-w-fit !p-0`,
          className
        )}
        variant="white"
        size="sm"
        aria-label={tooltipContent}
      >
        {icon()}
      </Button>
    </Tooltip>
  );
};
