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
