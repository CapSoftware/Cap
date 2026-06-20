"use client";

import {
	ArrowUpRight,
	BookOpen,
	Github,
	Mail,
	MessageCircle,
} from "lucide-react";
import Link from "next/link";
import { ReadyToGetStarted } from "../ReadyToGetStarted";

type SupportChannel = {
	title: string;
	description: string;
	icon: typeof Mail;
	href: string;
	cta: string;
	isExternal?: boolean;
};

const supportChannels: SupportChannel[] = [
	{
		title: "Join our Discord",
		description:
			"Chat with the Cap team and community in real time. The fastest way to get help, share feedback, and stay up to date.",
		icon: MessageCircle,
		href: "https://discord.gg/y8gdQ3WRN3",
		cta: "Open Discord",
		isExternal: true,
	},
	{
		title: "Email support",
		description:
			"Have a question, billing issue, or something you'd rather keep private? Send us an email and we'll get back to you.",
		icon: Mail,
		href: "mailto:support@cap.so",
		cta: "support@cap.so",
	},
	{
		title: "Read the docs",
		description:
			"Guides, tutorials, and references covering recording, sharing, self-hosting, and everything in between.",
		icon: BookOpen,
		href: "/docs",
		cta: "Browse docs",
	},
	{
		title: "Report an issue",
		description:
			"Found a bug or want to request a feature? Cap is open source, so you can open an issue directly on GitHub.",
		icon: Github,
		href: "https://github.com/CapSoftware/Cap/issues",
		cta: "Open an issue",
		isExternal: true,
	},
];

const quickLinks = [
	{ label: "FAQs", href: "/faq" },
	{ label: "Self-hosting guide", href: "/self-hosting" },
	{
		label: "System status",
		href: "https://cap.openstatus.dev/",
		isExternal: true,
	},
	{ label: "Trust portal", href: "https://trust.cap.so", isExternal: true },
	{ label: "Download Cap", href: "/download" },
];

export const SupportPage = () => {
	return (
		<div className="mt-[120px]">
			<div className="wrapper wrapper-sm">
				<div className="mx-auto max-w-[760px] pt-16 pb-24 md:pt-24 md:pb-32">
					<div className="mb-16 text-center md:mb-20">
						<p className="mb-4 text-sm font-medium tracking-widest uppercase text-gray-9">
							Support
						</p>
						<h1 className="text-[2rem] leading-[2.5rem] md:text-[3.25rem] md:leading-[3.75rem] text-gray-12 mb-6">
							How can we help?
						</h1>
						<p className="mx-auto max-w-[560px] text-lg md:text-xl leading-relaxed text-gray-10">
							Whether you're stuck, curious, or just want to say hi, here's how
							to reach the Cap team and community.
						</p>
					</div>

					<div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
						{supportChannels.map((channel) => {
							const Icon = channel.icon;
							return (
								<Link
									key={channel.title}
									href={channel.href}
									target={channel.isExternal ? "_blank" : undefined}
									rel={channel.isExternal ? "noopener noreferrer" : undefined}
									className="group flex flex-col p-6 rounded-2xl border transition-colors duration-200 border-gray-4 bg-gray-1 hover:border-gray-6 hover:bg-gray-2"
								>
									<div className="flex justify-center items-center mb-5 rounded-xl size-11 bg-gray-3 text-gray-12">
										<Icon className="size-5" />
									</div>
									<h2 className="mb-2 text-xl text-gray-12">{channel.title}</h2>
									<p className="flex-1 text-[0.9375rem] leading-relaxed text-gray-10">
										{channel.description}
									</p>
									<span className="inline-flex gap-1 items-center mt-5 text-[0.9375rem] font-medium text-gray-12 transition-colors duration-200 group-hover:text-blue-9">
										{channel.cta}
										<ArrowUpRight className="size-4" />
									</span>
								</Link>
							);
						})}
					</div>

					<div className="mt-16 md:mt-20">
						<div className="h-px bg-gray-4" />
						<h2 className="mt-12 mb-5 text-2xl md:text-3xl text-gray-12">
							More resources
						</h2>
						<ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							{quickLinks.map((link) => (
								<li key={link.label}>
									<Link
										href={link.href}
										target={link.isExternal ? "_blank" : undefined}
										rel={link.isExternal ? "noopener noreferrer" : undefined}
										className="inline-flex gap-1 items-center text-[1.0625rem] text-gray-11 transition-colors duration-200 hover:text-gray-12"
									>
										{link.label}
										<ArrowUpRight className="size-4 text-gray-9" />
									</Link>
								</li>
							))}
						</ul>
					</div>
				</div>
			</div>

			<ReadyToGetStarted />
		</div>
	);
};
