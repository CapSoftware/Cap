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
			className="absolute right-3 top-3 z-30 !h-9 !w-9 !rounded-full !border-gray-200 !bg-white/80 !p-0 hover:!bg-gray-100"
			onClick={onClick}
		>
			<Settings className="size-5 text-gray-600" aria-hidden />
		</Button>
	);
};
