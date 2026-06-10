"use client";

import type { VideoCta } from "@cap/database/types";
import { faArrowUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

export function CtaButton({ cta }: { cta?: VideoCta | null }) {
	if (!cta?.enabled || !cta.url || !cta.label) return null;

	return (
		<a
			href={cta.url}
			target="_blank"
			rel="noopener noreferrer"
			className="absolute top-3 right-3 z-30 inline-flex items-center gap-2 rounded-full bg-blue-500 px-4 py-2 text-sm font-medium text-white shadow-lg transition-colors hover:bg-blue-600"
		>
			<span className="truncate max-w-[200px]">{cta.label}</span>
			<FontAwesomeIcon className="size-3" icon={faArrowUpRightFromSquare} />
		</a>
	);
}
