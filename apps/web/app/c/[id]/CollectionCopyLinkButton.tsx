"use client";

import { Button } from "@cap/ui";
import { faLink } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { toast } from "sonner";

export function CollectionCopyLinkButton() {
	return (
		<Button
			type="button"
			variant="gray"
			size="sm"
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(
						window.location.origin + window.location.pathname,
					);
					toast.success("Link copied");
				} catch {
					toast.error("Failed to copy link");
				}
			}}
		>
			<FontAwesomeIcon icon={faLink} className="size-3" />
			Copy link
		</Button>
	);
}
