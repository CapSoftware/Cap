"use client";

import clsx from "clsx";
import { type CSSProperties, type ReactNode, useId } from "react";
import { BoilFilter } from "./paper";

export const PaperRoot = ({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) => {
	const filterId = `ob-boil-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

	return (
		<div
			className={clsx("cap-ob flex flex-col", className)}
			style={{ "--ob-boil-filter": `url(#${filterId})` } as CSSProperties}
		>
			<BoilFilter id={filterId} />
			{children}
		</div>
	);
};
