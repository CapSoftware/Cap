import { ImportIcon } from "lucide-react";

export const ImportButton = ({ onClick }: { onClick: () => void }) => (
	<button
		type="button"
		onClick={onClick}
		className="flex items-center justify-center gap-1 text-xs font-medium transition-colors hover:text-blue-12"
	>
		<ImportIcon className="size-3.5" aria-hidden />
		Import from Loom
	</button>
);
