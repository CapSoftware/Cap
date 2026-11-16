"use client";
import { LibraryDoodleFilters } from "./library-doodles";
import Top from "./Navbar/Top";

export default function DashboardInner({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<div className="flex overflow-hidden flex-col flex-1 pt-[126px] w-full md:pt-0 lg:my-2 lg:mr-2 lg:rounded-2xl dashboard-sheet">
			<LibraryDoodleFilters />
			<Top />
			<main className="flex relative flex-col flex-1 h-full min-h-0 [grid-area:main]">
				<div className="flex overflow-y-auto overscroll-contain relative flex-col flex-1 p-5 h-full lg:px-8 lg:pt-7 lg:pb-10">
					<div className="flex flex-col flex-1 gap-4 min-h-fit">{children}</div>
				</div>
			</main>
		</div>
	);
}
