"use client";

import { buildEnv } from "@cap/env";
import { classNames } from "@cap/utils/helpers";
import { type FormEvent, useState, useTransition } from "react";
import { sendDownloadLink } from "@/actions/send-download-link";
import { trackEvent } from "@/app/utils/analytics";
import { BTN_PRIMARY } from "@/components/pages/HomeTwo/theme";

const INPUT =
	"h-[48px] w-full rounded-[12px] border border-[#D3DCE6] bg-white px-4 text-[16px] text-[#111111] placeholder:text-[rgba(17,17,17,0.4)] focus:border-[#3F7FCD] focus:outline-none focus:ring-2 focus:ring-[rgba(63,127,205,0.25)]";

const HINT = "text-[14px] leading-[1.45] text-[rgba(17,17,17,0.6)]";

// The download email goes out from Cap's own sending domain, so only the
// hosted site can send it. Anywhere else the form would fail on every submit.
const HOSTED_DOWNLOAD_URL = "https://cap.so/download";

const SEND_FAILED =
	"We couldn't send that. Check your connection and try again.";

const EmailDownloadLink = ({ sourcePage }: { sourcePage: string }) => {
	const [email, setEmail] = useState("");
	const [sentTo, setSentTo] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	const submit = (event: FormEvent) => {
		event.preventDefault();
		setError(null);
		trackEvent("download_cta_clicked", {
			source_page: sourcePage,
			cta_location: "email_link",
			target: "email_download_link",
			target_url: "/download",
		});
		startTransition(async () => {
			try {
				const result = await sendDownloadLink(email);
				if (result.success) {
					trackEvent("download_link_emailed", { source_page: sourcePage });
					setSentTo(email.trim());
				} else {
					setError(result.error ?? SEND_FAILED);
				}
			} catch {
				setError(SEND_FAILED);
			}
		});
	};

	if (sentTo) {
		return (
			<output className={`${HINT} block text-center text-[#111111]`}>
				Sent to <span className="font-medium">{sentTo}</span>. Open it on your
				computer to install Cap.
			</output>
		);
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-2.5">
			<input
				type="email"
				name="email"
				autoComplete="email"
				inputMode="email"
				required
				value={email}
				onChange={(event) => setEmail(event.target.value)}
				placeholder="you@example.com"
				aria-label="Email address"
				className={INPUT}
			/>
			<button
				type="submit"
				disabled={pending}
				className={classNames(
					BTN_PRIMARY,
					"w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-60",
				)}
			>
				{pending ? "Sending..." : "Email me the download link"}
			</button>
			{error ? (
				<p role="alert" className="text-[13.5px] text-[#B42318]">
					{error}
				</p>
			) : null}
		</form>
	);
};

export const PhoneDownload = ({
	sourcePage,
	className,
}: {
	sourcePage: string;
	className?: string;
}) => {
	const canEmail = buildEnv.NEXT_PUBLIC_IS_CAP === "true";

	return (
		<div
			className={classNames(
				"flex w-full max-w-[380px] flex-col gap-3 text-left",
				className,
			)}
		>
			<p className={`${HINT} text-center`}>
				Cap runs on Mac, Windows and Linux. Send the link to your computer.
			</p>
			{canEmail ? (
				<EmailDownloadLink sourcePage={sourcePage} />
			) : (
				<a
					href={HOSTED_DOWNLOAD_URL}
					onClick={() =>
						trackEvent("download_cta_clicked", {
							source_page: sourcePage,
							cta_location: "email_link",
							target: "hosted_download_page",
							target_url: HOSTED_DOWNLOAD_URL,
						})
					}
					className={classNames(BTN_PRIMARY, "w-full")}
				>
					Email me the download link
				</a>
			)}
		</div>
	);
};
