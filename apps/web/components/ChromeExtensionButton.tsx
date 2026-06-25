import { Button, type ButtonProps } from "@cap/ui";
import Image from "next/image";
import type React from "react";
import { CAP_CHROME_EXTENSION_URL } from "@/lib/chrome-extension";

type ChromeExtensionButtonProps = {
	className?: string;
	label?: string;
	onClick?: React.MouseEventHandler<HTMLButtonElement>;
	size?: ButtonProps["size"];
	variant?: ButtonProps["variant"];
};

export function ChromeExtensionButton({
	className,
	label = "Add to Chrome",
	onClick,
	size = "lg",
	variant = "dark",
}: ChromeExtensionButtonProps) {
	return (
		<Button
			href={CAP_CHROME_EXTENSION_URL}
			onClick={onClick}
			size={size}
			variant={variant}
			className={`group ${className ?? ""}`}
			icon={
				<Image
					src="/logos/browsers/google-chrome.svg"
					width={20}
					height={20}
					alt=""
					className="mr-2 size-5 shrink-0 transition-transform duration-500 group-hover:rotate-[360deg]"
				/>
			}
		>
			{label}
		</Button>
	);
}
