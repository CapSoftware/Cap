"use client";

import { Button } from "@cap/ui";
import { Settings } from "lucide-react";

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
			<Settings className="size-5 text-gray-12" aria-hidden />
		</Button>
	);
};
