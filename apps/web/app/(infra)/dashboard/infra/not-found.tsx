import clsx from "clsx";
import Link from "next/link";
import PlainNotFound from "@/app/not-found";
import { INFRA_BASE_PATH } from "@/lib/infra-routes";
import { Missing } from "./_components/missing";
import { Brand } from "./_components/shell";
import { FOCUS } from "./_components/ui";
import { getInfraAccess } from "./infra-data";

export default async function InfraNotFound() {
	if ((await getInfraAccess()) !== "allowed") return <PlainNotFound />;

	return (
		<div className="flex min-h-dvh flex-col">
			<header className="mx-auto flex h-14 w-full max-w-[1184px] items-center justify-between px-5 sm:px-8">
				<Brand />
				<Link
					href="/dashboard/caps"
					className={clsx(
						"rounded-[6px] px-2.5 py-1.5 text-[13.5px] text-[rgba(232,236,244,0.58)] transition-colors duration-200 hover:text-[#E8ECF4]",
						FOCUS,
					)}
				>
					Back to Cap
				</Link>
			</header>
			<main className="mx-auto w-full max-w-[1184px] flex-1 px-5 pb-24 pt-[9vh] sm:px-8 lg:pt-[14vh]">
				<Missing
					title="App not found"
					href={INFRA_BASE_PATH}
					action="Go to your apps"
				>
					This app does not exist, or it was deleted.
				</Missing>
			</main>
		</div>
	);
}
