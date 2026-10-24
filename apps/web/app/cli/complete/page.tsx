import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "Cap CLI",
};

type PageProps = {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function CliCompletePage({ searchParams }: PageProps) {
	const values = Object.values(await searchParams).flatMap((value) =>
		Array.isArray(value) ? value : value ? [value] : [],
	);
	const cancelled = values.includes("cancelled");

	return (
		<main className="grid min-h-screen place-items-center bg-gray-1 px-6 text-gray-12">
			<div className="w-full max-w-md rounded-2xl border border-gray-4 bg-gray-2 p-8 text-center shadow-sm">
				<div className="mx-auto mb-5 grid size-12 place-items-center rounded-full bg-gray-12 text-xl font-semibold text-gray-1">
					C
				</div>
				<h1 className="text-xl font-semibold tracking-tight">
					{cancelled ? "Action cancelled" : "Action complete"}
				</h1>
				<p className="mt-2 text-sm leading-6 text-gray-10">
					{cancelled
						? "No changes were made. You can close this window and return to your terminal."
						: "You can close this window and return to your terminal. Cap CLI can now continue."}
				</p>
			</div>
		</main>
	);
}
