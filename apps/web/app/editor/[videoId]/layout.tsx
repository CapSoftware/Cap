import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "Editor — Cap",
	description: "Edit and export your recordings in Cap.",
};

export default function EditorLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<div className="h-screen h-dvh w-screen w-dvw overflow-hidden bg-gray-1 flex flex-col">
			{children}
		</div>
	);
}
