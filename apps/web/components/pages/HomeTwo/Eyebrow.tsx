import { classNames } from "@cap/utils/helpers";
import type { ReactNode } from "react";
import { EYEBROW, INK } from "./theme";

/**
 * 12px uppercase mono eyebrow with a small accent square, the way Intercom
 * marks its sections. `color` covers the dark band; `accent` picks up the
 * section's mode hue.
 */
export const Eyebrow = ({
	children,
	accent = "#8DBCF0",
	color = INK,
	className,
}: {
	children: ReactNode;
	accent?: string;
	color?: string;
	className?: string;
}) => (
	<p
		className={classNames(
			EYEBROW,
			"inline-flex items-center gap-2.5",
			className,
		)}
		style={{ color }}
	>
		<span
			aria-hidden="true"
			className="inline-block size-[7px]"
			style={{ background: accent }}
		/>
		{children}
	</p>
);
