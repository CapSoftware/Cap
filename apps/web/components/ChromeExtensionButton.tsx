import { Button, type ButtonProps } from "@cap/ui";
import Image from "next/image";
import { CAP_CHROME_EXTENSION_URL } from "@/lib/chrome-extension";

type ChromeExtensionButtonProps = {
	className?: string;
	href?: string | null;
	label?: string;
	onClick?: ButtonProps["onClick"];
	size?: ButtonProps["size"];
	target?: ButtonProps["target"];
	variant?: ButtonProps["variant"];
};

export function ChromeExtensionButton({
	className,
	href = CAP_CHROME_EXTENSION_URL,
	label = "Add to Chrome",
	onClick,
	size = "lg",
	target,
	variant = "dark",
}: ChromeExtensionButtonProps) {
	return (
		<Button
			href={href ?? undefined}
			onClick={onClick}
			size={size}
			target={target}
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
