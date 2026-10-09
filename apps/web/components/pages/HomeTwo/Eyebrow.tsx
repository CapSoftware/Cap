import { classNames } from "@cap/utils/helpers";
import type { ReactNode } from "react";
import { EYEBROW, INK } from "./theme";

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
