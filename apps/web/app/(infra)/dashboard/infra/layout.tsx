import type { Metadata } from "next";
import { infraMono, infraSans } from "./_components/fonts";
import { getInfraAccess } from "./infra-data";

const INFRA_GLOBAL_CSS = [
	"html,body{background:#0A0B0D}",
	"[data-sonner-toaster] [data-sonner-toast]{background:#121317!important;color:#E8ECF4!important;border:1px solid rgba(222,230,246,0.14)!important;box-shadow:0 18px 60px rgba(0,0,0,0.6)!important}",
	"[data-sonner-toaster] [data-sonner-toast] [data-icon],[data-sonner-toaster] [data-sonner-toast] [data-title]{color:#E8ECF4!important}",
	"[data-sonner-toaster] [data-sonner-toast][data-type=error] [data-icon]{color:#F2A199!important}",
].join("");

const NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.1 -0.2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")`;

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
			className={`${infraSans.variable} ${infraMono.variable} relative isolate min-h-dvh bg-[#0A0B0D] text-[#E8ECF4] antialiased [color-scheme:dark] [font-family:var(--font-infra-sans),system-ui,sans-serif]`}
		>
			<style>{INFRA_GLOBAL_CSS}</style>
			<div
				aria-hidden="true"
				className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(900px_420px_at_68%_-140px,rgba(196,212,255,0.11),transparent_70%),radial-gradient(1400px_700px_at_50%_-300px,rgba(196,212,255,0.045),transparent_75%)]"
			/>
			{children}
			<div
				aria-hidden="true"
				className="pointer-events-none fixed inset-0 z-[60] opacity-[0.04]"
				style={{ backgroundImage: NOISE, backgroundSize: "160px 160px" }}
			/>
		</div>
	);
}
