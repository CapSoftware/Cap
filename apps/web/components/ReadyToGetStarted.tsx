"use client";

import { Button } from "@cap/ui";
import Link from "next/link";
import { homepageCopy } from "../data/homepage-copy";
import UpgradeToPro from "./pages/_components/UpgradeToPro";

export function ReadyToGetStarted() {
	return (
		<div
			className="max-w-[1000px] md:bg-center w-[calc(100%-20px)] bg-white min-h-[300px] mx-auto border border-gray-5 my-[150px] md:my-[200px] lg:my-[250px] rounded-[20px] overflow-hidden relative flex flex-col justify-center p-8"
			style={{
				backgroundImage: "url('/illustrations/ctabg.svg')",
				backgroundSize: "cover",
				backgroundRepeat: "no-repeat",
			}}
		>
			<div className="flex relative z-10 flex-col justify-center items-center mx-auto h-full wrapper">
				<div className="text-center max-w-[800px] mx-auto mb-8">
					<h2 className="mb-3 text-3xl md:text-4xl text-gray-12">
						{homepageCopy.readyToGetStarted.title}
					</h2>
				</div>
				<div className="flex flex-col justify-center items-center mb-8 space-y-4 w-full sm:flex-row sm:space-y-0 sm:space-x-2">
					<Button
						variant="gray"
						href="/pricing"
						size="lg"
						className="font-medium w-fit"
					>
						{homepageCopy.readyToGetStarted.buttons.secondary}
					</Button>
					<UpgradeToPro text={homepageCopy.header.cta.primaryButton} />
				</div>
				<div>
					<p>
						or,{" "}
						<Link
							href="/loom-alternative"
							className="font-semibold underline hover:text-gray-12"
						>
							Switch from Loom
						</Link>
					</p>
				</div>
			</div>
		</div>
	);
}
