"use client";

import { useDetectPlatform } from "hooks/useDetectPlatform";
import Link from "next/link";
import { useEffect } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { PhoneDownload } from "@/components/download/PhoneDownload";
import { htMono, htSans, htSerif } from "@/components/pages/HomeTwo/fonts";
import {
	BAND,
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	CREAM,
	grainBg,
	H_HERO,
	SHELL,
} from "@/components/pages/HomeTwo/theme";
import { claimDownloadStart, getDownloadTarget } from "@/lib/download";

const LINK =
	"text-[#111111] underline decoration-[rgba(17,17,17,0.25)] underline-offset-[4px] transition-colors duration-200 hover:decoration-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-4 focus-visible:ring-offset-[#EDF1F6]";

export const DownloadStartedPage = ({ platform }: { platform: string }) => {
	const target = getDownloadTarget(platform);
	const device = useDetectPlatform();
	const detected = device.platform !== null;
	const isPhone = device.isIOS || device.platform === "android";

	useEffect(() => {
		if (!target || !detected || isPhone) return;
		if (!claimDownloadStart(window.history)) return;
		trackEvent("download_started", {
			source_page: "download_started",
			target_url: target.installerUrl,
		});
		window.location.assign(target.installerUrl);
	}, [target, detected, isPhone]);

	if (!target) return null;

	return (
		<div
			data-header-flat
			className={`${htSans.className} ${htSans.variable} ${htSerif.variable} ${htMono.variable} text-[#111111]`}
			style={grainBg(SHELL)}
		>
			<div className="px-2.5 pb-2.5 pt-[68px] sm:px-4 sm:pb-4 lg:pt-[76px]">
				<div
					className="rounded-[24px] shadow-[0_0_0_1px_rgba(17,17,17,0.045)]"
					style={grainBg(CREAM)}
				>
					<section
						className="relative rounded-[24px] px-5 pb-16 pt-14 lg:pb-24 lg:pt-20"
						style={grainBg(BAND)}
					>
						<div className="mx-auto flex max-w-[720px] flex-col items-center text-center">
							<h1
								className={`${H_HERO} text-balance text-[clamp(38px,5.4vw,64px)]`}
							>
								{isPhone
									? "Open this on your computer"
									: `Cap for ${target.name} is downloading`}
							</h1>
							{isPhone ? (
								<>
									<p
										className={`${BODY_TEXT} mt-6 max-w-[520px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[18px]`}
									>
										Cap for {target.name} installs on a computer. Open this page
										there and the download starts by itself.
									</p>
									<PhoneDownload
										sourcePage="download_started"
										className="mt-9"
									/>
								</>
							) : (
								<>
									<p
										className={`${BODY_TEXT} mt-6 max-w-[520px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[18px]`}
									>
										Nothing happening?{" "}
										<a
											href={target.installerUrl}
											onClick={() =>
												trackEvent("download_cta_clicked", {
													source_page: "download_started",
													cta_location: "retry",
													target_url: target.installerUrl,
												})
											}
											className={LINK}
										>
											Download it again
										</a>
										, or{" "}
										<Link href="/download" className={LINK}>
											pick another platform
										</Link>
										.
									</p>

									<ol className="mt-12 w-full space-y-3 text-left">
										{target.steps.map((step, index) => (
											<li
												key={step}
												className="flex items-start gap-4 rounded-[16px] bg-white p-5 shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_1px_2px_rgba(17,17,17,0.03)]"
											>
												<span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#E7EDF3] text-[13.5px] font-medium tabular-nums text-[#111111]">
													{index + 1}
												</span>
												<span className="pt-0.5 text-[15.5px] leading-[1.5] text-[rgba(17,17,17,0.82)]">
													{step}
												</span>
											</li>
										))}
									</ol>
								</>
							)}

							<div className="mt-10 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
								<Link
									href="/signup"
									onClick={() =>
										trackEvent("download_started_cta_clicked", {
											target_url: "/signup",
										})
									}
									className={BTN_PRIMARY}
								>
									Create your free account
								</Link>
								<Link
									href="/migrate-from-loom"
									onClick={() =>
										trackEvent("download_started_cta_clicked", {
											target_url: "/migrate-from-loom",
										})
									}
									className={BTN_SECONDARY}
								>
									Import from Loom
								</Link>
							</div>
							<p className="mt-4 text-[14px] text-[rgba(17,17,17,0.5)]">
								An account lets you share recordings with a link.
							</p>
							<span
								data-header-sentinel
								aria-hidden="true"
								className="pointer-events-none absolute bottom-0 left-0 size-px"
							/>
						</div>
					</section>
				</div>
			</div>
		</div>
	);
};
