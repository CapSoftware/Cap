// million-ignore
"use client";

import { Button } from "@cap/ui";
import { faPlay } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AnimatePresence, motion } from "framer-motion";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import Image from "next/image";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { sendDownloadLink } from "@/actions/send-download-link";
import { trackEvent } from "@/app/utils/analytics";
import { LogoMarquee } from "@/components/ui/LogoMarquee";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getPlatformIcon,
	PlatformIcons,
} from "@/utils/platform";
import { homepageCopy } from "../../../data/homepage-copy";
import UpgradeToPro from "../_components/UpgradeToPro";
import type { ProArtRef } from "./Pricing/ProArt";
import VideoModal from "./VideoModal";

interface HeaderProps {
	serverHomepageCopyVariant?: string;
}

// Animation variants
const fadeIn = {
	hidden: { opacity: 0, y: 20 },
	visible: (custom: number) => ({
		opacity: 1,
		y: 0,
		transition: {
			delay: custom * 0.1,
			duration: 0.5,
			ease: "easeOut",
		},
	}),
};

const fadeInFromRight = {
	hidden: { opacity: 0, x: 50 },
	visible: {
		opacity: 1,
		x: 0,
		transition: {
			delay: 0.5,
			duration: 0.6,
			ease: "easeOut",
		},
	},
};

const Header = ({ serverHomepageCopyVariant = "" }: HeaderProps) => {
	const [videoToggled, setVideoToggled] = useState(false);
	const { platform, isIntel } = useDetectPlatform();
	const loading = platform === null;
	const [email, setEmail] = useState("");
	const [emailStatus, setEmailStatus] = useState<
		"idle" | "sending" | "sent" | "error"
	>("idle");
	const [emailError, setEmailError] = useState("");
	const [isPending, startTransition] = useTransition();
	const primaryDownloadUrl =
		platform === "windows" ? "/download" : getDownloadUrl(platform, isIntel);

	const handleEmailSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setEmailStatus("sending");
		setEmailError("");

		startTransition(async () => {
			const result = await sendDownloadLink(email);
			if (result.success) {
				setEmailStatus("sent");
				if (typeof window !== "undefined" && window.bento) {
					window.bento.identify(email);
				}
			} else {
				setEmailStatus("error");
				setEmailError(result.error ?? "Something went wrong.");
			}
		});
	};

	const getHeaderContent = () => {
		const variant =
			serverHomepageCopyVariant as keyof typeof homepageCopy.header.variants;
		return (
			homepageCopy.header.variants[variant] ||
			homepageCopy.header.variants.default
		);
	};

	const _proArtRef = useRef<ProArtRef>(null);

	const headerContent = getHeaderContent();

	return (
		<div className="mt-[90px] mb-[60px] sm:mb-[100px] md:mb-[160px] w-full max-w-[1920px] overflow-x-hidden md:overflow-visible mx-auto md:mt-[140px] xl:min-h-[700px]">
			<div className="flex flex-col justify-center lg:justify-start xl:flex-row relative z-10 px-5 w-full mb-0">
				<div className="w-full max-w-2xl xl:max-w-[530px] 2xl:mt-12 mx-auto xl:ml-[100px] 2xl:ml-[150px]">
					<div className="flex flex-col text-center md:text-left w-full max-w-[650px]">
						<motion.h1
							className="text-[2.25rem] font-medium leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] relative z-10 text-black mb-4"
							initial="hidden"
							animate="visible"
							custom={1}
							variants={fadeIn}
						>
							{headerContent.title}
						</motion.h1>

						<motion.p
							className="mx-auto mb-8 max-w-3xl text-lg text-zinc-500"
							initial="hidden"
							animate="visible"
							custom={2}
							variants={fadeIn}
						>
							{headerContent.description}
						</motion.p>
					</div>

					<motion.div
						className="hidden md:flex flex-wrap gap-4 items-center mb-5"
						initial="hidden"
						animate="visible"
						custom={3}
						variants={fadeIn}
					>
						<Button
							variant="dark"
							href={primaryDownloadUrl}
							onClick={() =>
								trackEvent("download_cta_clicked", {
									source_page: "home_header",
									cta_location: "primary",
									target_url: primaryDownloadUrl,
									detected_platform: platform ?? "unknown",
									is_intel: Boolean(isIntel),
								})
							}
							size="lg"
							className="flex justify-center items-center font-medium max-w-fit"
						>
							{!loading && getPlatformIcon(platform)}
							{getDownloadButtonText(platform, loading, isIntel)}
						</Button>
						<UpgradeToPro text={homepageCopy.header.cta.primaryButton} />
					</motion.div>

					<motion.div
						className="flex md:hidden flex-col gap-3 mb-5"
						initial="hidden"
						animate="visible"
						custom={3}
						variants={fadeIn}
					>
						{emailStatus === "sent" ? (
							<div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3">
								<p className="text-sm font-medium text-green-800">
									Check your inbox! We've sent the download links to{" "}
									<strong>{email}</strong>.
								</p>
							</div>
						) : (
							<form
								onSubmit={handleEmailSubmit}
								className="flex flex-col gap-2"
							>
								<input
									type="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									placeholder="you@email.com"
									required
									className="w-full rounded-full border border-gray-300 bg-white px-4 py-2.5 text-sm text-black placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
								/>
								<button
									type="submit"
									disabled={isPending}
									className="w-full rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-opacity disabled:opacity-60"
								>
									{isPending ? "Sending..." : "Email me the download link"}
								</button>
								{emailStatus === "error" && (
									<p className="text-xs text-red-600">{emailError}</p>
								)}
							</form>
						)}
						<div className="flex items-center gap-3 my-1">
							<div className="h-px flex-1 bg-gray-300" />
							<span className="text-sm font-medium text-gray-500">or</span>
							<div className="h-px flex-1 bg-gray-300" />
						</div>
						<div className="flex justify-center">
							<UpgradeToPro text={homepageCopy.header.cta.primaryButton} />
						</div>
					</motion.div>

					<motion.p
						className="text-sm text-gray-10 text-center md:text-left"
						initial="hidden"
						animate="visible"
						custom={4}
						variants={fadeIn}
					>
						{homepageCopy.header.cta.freeVersionText}
					</motion.p>

					<motion.div
						className="hidden md:block mt-6 mb-10"
						initial="hidden"
						animate="visible"
						custom={5}
						variants={fadeIn}
					>
						<PlatformIcons source="home_header" />

						<Link
							href="/download"
							onClick={() =>
								trackEvent("download_cta_clicked", {
									source_page: "home_header",
									cta_location: "see_other_options",
									target_url: "/download",
									detected_platform: platform ?? "unknown",
									is_intel: Boolean(isIntel),
								})
							}
							className="mt-2 text-sm underline text-gray-10 hover:text-gray-12"
						>
							{homepageCopy.header.cta.seeOtherOptionsText}
						</Link>
					</motion.div>

					<motion.div
						className="mt-14"
						initial="hidden"
						animate="visible"
						custom={6}
						variants={fadeIn}
					>
						<p className="mb-4 text-sm italic text-gray-10 text-center md:text-left">
							Trusted by <strong>30,000+</strong> teams, builders and creators
						</p>
						<LogoMarquee />
					</motion.div>
				</div>

				<motion.div
					className="xl:absolute drop-shadow-2xl -top-[22%] lg:-right-[400px] 2xl:-right-[300px] w-full xl:max-w-[1000px] 2xl:max-w-[1200px]"
					initial="hidden"
					animate="visible"
					variants={fadeInFromRight}
				>
					{/* Play Button*/}
					<motion.div
						whileTap={{ scale: 0.95 }}
						whileHover={{ scale: 1.05 }}
						onClick={() => setVideoToggled(true)}
						className="size-[100px] md:size-[150px] inset-x-0 mx-auto top-[35vw] xs:top-[180px] sm:top-[35vw] xl:top-[350px] 2xl:top-[400px] xl:left-[-120px] relative cursor-pointer z-10 
              shadow-[0px_60px_40px_3px_rgba(0,0,0,0.4)] flex items-center justify-center rounded-full bg-blue-500"
					>
						<FontAwesomeIcon
							icon={faPlay}
							className="text-white size-8 md:size-12"
						/>
					</motion.div>
					<Image
						src="/illustrations/app.webp"
						width={1000}
						height={1000}
						quality={100}
						alt="App"
						className="object-cover relative inset-0 rounded-xl opacity-70 size-full"
					/>
				</motion.div>
			</div>
			<AnimatePresence>
				{videoToggled && <VideoModal setVideoToggled={setVideoToggled} />}
			</AnimatePresence>
		</div>
	);
};

export default Header;
