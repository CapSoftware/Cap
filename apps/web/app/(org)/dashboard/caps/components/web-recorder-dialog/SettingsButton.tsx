"use client";

import { Button } from "@cap/ui";
import CogIcon from "@/app/(org)/dashboard/_components/AnimatedIcons/Cog";

interface SettingsButtonProps {
	visible: boolean;
	onClick: () => void;
}

export const SettingsButton = ({ visible, onClick }: SettingsButtonProps) => {
	if (!visible) return null;

	return (
		<Button
			type="button"
			variant="outline"
			size="icon"
			aria-label="Open recorder settings"
			className="absolute right-3 top-3 z-10 !p-0"
			onClick={onClick}
		>
			<CogIcon size={20} aria-hidden className="text-gray-12" />
		</Button>
	);
};
