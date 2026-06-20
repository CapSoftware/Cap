import { Button } from "../ui/button";
import CogIcon from "./cog-icon";

interface SettingsButtonProps {
	onClick: () => void;
}

export const SettingsButton = ({ onClick }: SettingsButtonProps) => (
	<Button
		type="button"
		variant="outline"
		size="icon"
		aria-label="Open recorder settings"
		className="group !p-0"
		onClick={onClick}
	>
		<CogIcon size={20} aria-hidden className="text-gray-12" />
	</Button>
);
