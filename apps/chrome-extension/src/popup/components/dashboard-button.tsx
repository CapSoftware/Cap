import { LayoutDashboardIcon } from "lucide-react";
import { Button } from "../ui/button";

interface DashboardButtonProps {
	onClick: () => void;
}

export const DashboardButton = ({ onClick }: DashboardButtonProps) => (
	<Button
		type="button"
		variant="outline"
		size="icon"
		aria-label="Open Cap dashboard"
		className="!p-0"
		onClick={onClick}
	>
		<LayoutDashboardIcon size={18} aria-hidden className="text-gray-12" />
	</Button>
);
