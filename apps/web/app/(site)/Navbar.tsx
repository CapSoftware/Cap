import { Logo } from "@cap/ui/logo";
import Image from "next/image";
import Link from "next/link";
import MobileMenu from "@/components/ui/MobileMenu";
import { DesktopNavLinks } from "./DesktopNavLinks";
import { NavbarFrame } from "./NavbarFrame";

interface NavbarProps {
	stars?: string;
}

export const Navbar = ({ stars }: NavbarProps) => {
	return (
		<NavbarFrame>
			<div className="flex gap-4 justify-between items-center px-5 mx-auto h-[68px] group-data-[island=true]:h-[60px] group-data-[island=true]:px-4 lg:h-[76px] lg:px-8 lg:group-data-[island=true]:h-[64px] lg:group-data-[island=true]:px-5 xl:gap-6">
				<div className="flex gap-2 items-center lg:gap-3 xl:gap-6">
					<Link passHref href="/home" className="shrink-0">
						<Logo
							className="transition-all duration-200 ease-out"
							squaredMark
							viewBoxDimensions="0 0 120 40"
							style={{
								width: 90,
								height: 40,
							}}
						/>
					</Link>
					<div className="hidden lg:flex">
						<DesktopNavLinks />
					</div>
				</div>
				<div className="hidden gap-2.5 items-center lg:flex">
					<a
						href="https://github.com/CapSoftware/Cap"
						target="_blank"
						rel="noreferrer"
						className="group relative flex gap-2 items-center px-2.5 py-2 whitespace-nowrap rounded-[8px] text-[14.5px] font-medium text-[rgba(17,17,17,0.85)] transition-colors duration-200 hover:text-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-12 xl:px-3 xl:text-[15.5px]"
					>
						<span
							aria-hidden="true"
							className="pointer-events-none absolute inset-0 -z-10 scale-[0.86] rounded-[8px] bg-gray-3 opacity-0 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-100 group-hover:opacity-100"
						/>
						<Image src="/github.svg" alt="" width={16} height={16} />
						<span>
							GitHub
							{stars ? (
								<span className="hidden xl:inline"> ({stars})</span>
							) : null}
						</span>
					</a>
					<Link
						href="/login"
						className="inline-flex justify-center items-center px-4 whitespace-nowrap rounded-[10px] border border-gray-12 h-[42px] text-[14.5px] font-medium text-gray-12 transition-colors duration-200 hover:bg-gray-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-12 focus-visible:ring-offset-2 xl:px-5 xl:text-[15.5px]"
					>
						Login
					</Link>
					<Link
						href="/signup"
						className="inline-flex justify-center items-center px-4 whitespace-nowrap rounded-[10px] bg-gray-12 h-[42px] text-[14.5px] font-medium text-gray-1 transition-colors duration-200 hover:bg-gray-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-12 focus-visible:ring-offset-2 xl:px-5 xl:text-[15.5px]"
					>
						Sign Up
					</Link>
				</div>
				<div className="lg:hidden">
					<MobileMenu stars={stars} />
				</div>
			</div>
		</NavbarFrame>
	);
};
