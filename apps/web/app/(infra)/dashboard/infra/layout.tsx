import type { Metadata } from "next";
import { infraMono, infraSans } from "./_components/fonts";
import { getInfraAccess } from "./infra-data";

const INFRA_GLOBAL_CSS = [
	"html,body{background:#050506}",
	"[data-sonner-toaster] [data-sonner-toast]{background:#0B0C0E!important;color:#E8ECF4!important;border:1px solid rgba(222,230,246,0.14)!important;box-shadow:0 18px 60px rgba(0,0,0,0.6)!important}",
	"[data-sonner-toaster] [data-sonner-toast] [data-icon],[data-sonner-toaster] [data-sonner-toast] [data-title]{color:#E8ECF4!important}",
	"[data-sonner-toaster] [data-sonner-toast][data-type=error] [data-icon]{color:#F2A199!important}",
].join("");

export async function generateMetadata(): Promise<Metadata> {
	return (await getInfraAccess()) === "allowed" ? { title: "Cap Infra" } : {};
}

export default function InfraLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<div
			className={`${infraSans.variable} ${infraMono.variable} min-h-dvh bg-[#050506] text-[#E8ECF4] antialiased [color-scheme:dark] [font-family:var(--font-infra-sans),system-ui,sans-serif]`}
		>
			<style>{INFRA_GLOBAL_CSS}</style>
			{children}
		</div>
	);
}
