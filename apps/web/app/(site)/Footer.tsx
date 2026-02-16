"use client";

import { Logo } from "@cap/ui";
import Link from "next/link";

type FooterLink = {
	label: string;
	href: string;
	isExternal?: boolean;
};

const footerLinks = {
	product: [
		{ label: "Blog", href: "/blog" },
		{ label: "Docs", href: "/docs" },
		{ label: "Pricing", href: "/pricing" },
		{ label: "Download", href: "/download" },
		{
			label: "Open Source",
			href: "https://github.com/CapSoftware/Cap",
			isExternal: true,
		},
		{
			label: "Join the community",
			href: "https://discord.gg/y8gdQ3WRN3",
			isExternal: true,
		},
		{
			label: "OSS Friends",
			href: "/oss-friends",
		},
	] as FooterLink[],
	help: [
		{ label: "About", href: "/about" },
		{ label: "Testimonials", href: "/testimonials" },
		{ label: "FAQs", href: "/faq" },
		{ label: "Self-hosting", href: "/self-hosting" },
		{ label: "Email Support", href: "mailto:hello@cap.so" },
		{ label: "Help Center", href: "https://help.cap.so" },
		{ label: "Trust Portal", href: "https://trust.cap.so" },
		{
			label: "Chat Support",
			href: "https://discord.gg/y8gdQ3WRN3",
			isExternal: true,
		},
		{
			label: "System Status",
			href: "https://cap.openstatus.dev/",
			isExternal: true,
		},
	] as FooterLink[],
	socials: [
		{ label: "X (@Cap)", href: "https://x.com/cap", isExternal: true },
		{
			label: "Discord",
			href: "https://discord.gg/y8gdQ3WRN3",
			isExternal: true,
		},
		{
			label: "LinkedIn",
			href: "https://www.linkedin.com/company/caprecorder/",
			isExternal: true,
		},
	] as FooterLink[],
	tools: [
		{ label: "WebM to MP4", href: "/tools/convert/webm-to-mp4" },
		{ label: "MOV to MP4", href: "/tools/convert/mov-to-mp4" },
		{ label: "AVI to MP4", href: "/tools/convert/avi-to-mp4" },
		{ label: "MP4 to GIF", href: "/tools/convert/mp4-to-gif" },
		{ label: "MP4 to MP3", href: "/tools/convert/mp4-to-mp3" },
		{ label: "MP4 to WebM", href: "/tools/convert/mp4-to-webm" },
		{ label: "Video Speed Controller", href: "/tools/video-speed-controller" },
		{ label: "Trim Video", href: "/tools/trim" },
	] as FooterLink[],
	useCases: [
		{
			label: "Remote Team Collaboration",
			href: "/solutions/remote-team-collaboration",
		},
		{
			label: "Employee Onboarding Platform",
			href: "/solutions/employee-onboarding-platform",
		},
		{
			label: "Daily Standup Software",
			href: "/solutions/daily-standup-software",
		},
		{
			label: "Online Classroom Tools",
			href: "/solutions/online-classroom-tools",
		},
		{
			label: "Agencies",
			href: "/solutions/agencies",
		},
	] as FooterLink[],
	additional: [
		{ label: "Loom Video Downloader", href: "/tools/loom-downloader" },
		{ label: "Screen Recorder", href: "/screen-recorder" },
		{ label: "Free Screen Recorder", href: "/free-screen-recorder" },
		{ label: "Screen Recorder for Mac", href: "/screen-recorder-mac" },
		{ label: "Screen Recorder for Windows", href: "/screen-recorder-windows" },
		{ label: "Screen Recording Software", href: "/screen-recording-software" },
		{ label: "Cap vs Loom", href: "/loom-alternative" },
		{ label: "Student Discount", href: "/student-discount" },
	] as FooterLink[],
};

export const Footer = () => {
	return (
		<footer className="p-5">
			<div
				style={{ boxShadow: "0px 2px 8px rgba(18, 22, 31, 0.02)" }}
				className="mx-auto max-w-[1400px] bg-gray-1 border-[1px] border-gray-200 p-8 lg:p-12 rounded-[20px] mb-10 relative overflow-hidden"
			>
				<div className="flex relative z-10 flex-col-reverse items-center">
					{/* Logo Column */}
					<div className="flex-1 mt-10 space-y-2 text-center md:mt-0">
						<Logo className="w-[104px] h-auto mx-auto" />
						<div className="w-full">
							<p className="max-w-sm text-gray-12">
								Cap is the open source alternative to Loom. Lightweight,
								powerful, and cross-platform. Record and share in seconds.
							</p>
						</div>
						<p className="pt-4 text-sm text-gray-9">
							© Cap Software, Inc. {new Date().getFullYear()}.
						</p>
						<div className="flex justify-center pt-6 space-x-10">
							<a className="text-sm text-gray-8" href="/terms">
								Terms of Service
							</a>
							<a className="text-sm text-gray-8" href="/privacy">
								Privacy Policy
							</a>
						</div>
					</div>

					{/* Links Container Column */}
					<div className="grid grid-cols-1 gap-10 w-full md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
						{/* Product Column */}
						<div className="space-y-2">
							<h3 className="text-lg font-semibold text-gray-12">Product</h3>
							<ul className="grid grid-cols-1 gap-2 pt-2">
								{footerLinks.product.map((link, index) => (
									<li key={index.toString()}>
										<Link
											className="text-gray-10"
											href={link.href}
											target={link.isExternal ? "_blank" : undefined}
										>
											{link.label}
										</Link>
									</li>
								))}
							</ul>
						</div>

						<div className="space-y-2">
							<h3 className="text-lg font-semibold text-gray-12">
								Additional Links
							</h3>
							<ul className="grid grid-cols-1 gap-2 pt-2">
								{footerLinks.additional.map((link, index) => (
									<li key={index.toString()}>
										<Link
											className="text-gray-10"
											href={link.href}
											target={link.isExternal ? "_blank" : undefined}
										>
											{link.label}
										</Link>
									</li>
								))}
							</ul>
						</div>

						{/* Help Column */}
						<div className="space-y-2">
							<h3 className="text-lg font-semibold text-gray-12">Cap</h3>
							<ul className="grid grid-cols-1 gap-2 pt-2">
								{footerLinks.help.map((link, index) => (
									<li key={index.toString()}>
										<Link
											className="text-gray-10"
											href={link.href}
											target={link.isExternal ? "_blank" : undefined}
										>
											{link.label}
										</Link>
									</li>
								))}
							</ul>
						</div>

						<div className="space-y-2">
							<h3 className="text-lg font-semibold text-gray-12">Use Cases</h3>
							<ul className="grid grid-cols-1 gap-2 pt-2">
								{footerLinks.useCases.map((link, index) => (
									<li key={index.toString()}>
										<Link
											className="text-gray-10"
											href={link.href}
											target={link.isExternal ? "_blank" : undefined}
										>
											{link.label}
										</Link>
									</li>
								))}
							</ul>
						</div>

						{/* Socials Column */}
						<div className="space-y-2">
							<h3 className="text-lg font-semibold text-gray-12">Socials</h3>
							<ul className="grid grid-cols-1 gap-2 pt-2">
								{footerLinks.socials.map((link, index) => (
									<li key={index.toString()}>
										<Link
											className="text-gray-10"
											href={link.href}
											target={link.isExternal ? "_blank" : undefined}
										>
											{link.label}
										</Link>
									</li>
								))}
							</ul>
						</div>

						<div className="space-y-2">
							<Link
								href="/tools"
								className="text-lg font-semibold text-gray-12"
							>
								Tools
							</Link>

							<ul className="grid grid-cols-1 gap-2 pt-2">
								{footerLinks.tools.map((link, index) => (
									<li key={index.toString()}>
										<Link
											className="text-gray-10"
											href={link.href}
											target={link.isExternal ? "_blank" : undefined}
										>
											{link.label}
										</Link>
									</li>
								))}
							</ul>
						</div>
					</div>
				</div>
			</div>
		</footer>
	);
};
