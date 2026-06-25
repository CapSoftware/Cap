import { Button, Logo } from "@cap/ui";
import Image from "next/image";
import Link from "next/link";
import MobileMenu from "@/components/ui/MobileMenu";
import { DesktopNavLinks } from "./DesktopNavLinks";

interface NavbarProps {
	stars?: string;
}

export const Navbar = ({ stars }: NavbarProps) => {
	return (
		<header className="fixed left-0 right-0 z-[51] top-4 lg:top-6">
			<nav className="relative p-2 mx-auto w-full max-w-[calc(100%-20px)] bg-white rounded-full border lg:max-w-fit border-zinc-200 h-fit">
				<div className="flex gap-12 justify-between items-center mx-auto max-w-5xl h-full transition-all">
					<div className="flex items-center">
						<Link passHref href="/home">
							<Logo
								className="transition-all duration-200 ease-out"
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
					<div className="hidden items-center space-x-2 lg:flex">
						<Button
							variant="outline"
							icon={
								<Image src="/github.svg" alt="Github" width={16} height={16} />
							}
							target="_blank"
							href="https://github.com/CapSoftware/Cap"
							size="sm"
							className="w-full font-medium sm:w-auto"
						>
							{`GitHub${stars ? ` (${stars})` : ""}`}
						</Button>
						<Button
							variant="gray"
							href="/login"
							size="sm"
							className="w-full font-medium sm:w-auto"
						>
							Login
						</Button>
						<Button
							variant="dark"
							href="/signup"
							size="sm"
							className="w-full font-medium sm:w-auto"
						>
							Sign Up
						</Button>
					</div>
					<div className="lg:hidden">
						<MobileMenu stars={stars} />
					</div>
				</div>
			</nav>
		</header>
	);
};
