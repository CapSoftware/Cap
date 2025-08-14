import { Suspense } from "react";

export default function ToolsLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<Suspense>
			<section>{children}</section>
		</Suspense>
	);
}
