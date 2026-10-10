"use client";

import type { Organisation } from "@cap/web-domain";
import { ArrowRight, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	type ChangeEvent,
	type CSSProperties,
	type DragEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import type { UploadStatus } from "@/app/(org)/dashboard/caps/UploadingContext";
import { importMediaFile } from "@/app/(org)/dashboard/import/import-media";
import { isSupportedVideoFile } from "@/app/(org)/dashboard/import/media-file-types";
import { trackEvent } from "@/app/utils/analytics";
import { UpgradeModal } from "@/components/UpgradeModal";
import { onboardingStepHref } from "../onboarding-flow";
import { Explainer, SquiggleProgress } from "./paper";
import { BackLink, ProNote, StepLede, StepPage, StepTitle } from "./StepChrome";
import { DoneDoodle, UploadDoodle, UploadScene } from "./scenes";
import { useGetStarted } from "./use-get-started";
import { useUpgradeConfirmation } from "./use-upgrade-confirmation";

const VIDEO_ACCEPT = "video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi";

const statusLabel = (status: UploadStatus | undefined) => {
	switch (status?.status) {
		case "parsing":
			return "Reading your video…";
		case "creating":
			return "Getting your link ready…";
		case "uploadingVideo":
		case "uploadingThumbnail":
		case "converting":
			return "Uploading…";
		case "serverProcessing":
			return "Almost there…";
		default:
			return "Starting…";
	}
};

const statusProgress = (status: UploadStatus | undefined) => {
	if (!status) return null;
	if (status.status === "serverProcessing") return 1;
	if ("progress" in status)
		return Math.min(1, Math.max(0, status.progress / 100));
	return null;
};

export const UploadStep = ({
	organizationId,
	isPro,
	justUpgraded,
	completed,
}: {
	organizationId: Organisation.OrganisationId | null;
	isPro: boolean;
	justUpgraded: boolean;
	completed: boolean;
}) => {
	const router = useRouter();
	const inputRef = useRef<HTMLInputElement>(null);
	const capIdRef = useRef<string | null>(null);
	const { complete } = useGetStarted(completed, "upload");
	const upgrade = useUpgradeConfirmation({ justUpgraded, isPro });
	const [phase, setPhase] = useState<"idle" | "working" | "done">("idle");
	const [status, setStatus] = useState<UploadStatus | undefined>();
	const [fileName, setFileName] = useState("");
	const [capId, setCapId] = useState<string | null>(null);
	const [over, setOver] = useState(false);
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const [leaving, setLeaving] = useState(false);

	useEffect(() => {
		if (organizationId) return;
		complete("upload")
			.then(() => router.refresh())
			.catch(() => undefined);
	}, [organizationId, complete, router]);

	const promptUpgrade = () => {
		trackEvent("onboarding_upload_upgrade_prompted");
		setUpgradeOpen(true);
	};

	const upload = async (file: File) => {
		if (!isPro) {
			promptUpgrade();
			return;
		}
		if (!isSupportedVideoFile(file)) {
			toast.error("Please choose a video file, like an MP4, MOV or WebM.");
			return;
		}
		if (!organizationId) {
			toast.info("Your library is still being set up. Try again in a second.");
			router.refresh();
			return;
		}

		capIdRef.current = null;
		setFileName(file.name);
		setStatus(undefined);
		setPhase("working");
		await complete("upload").catch(() => undefined);

		const ok = await importMediaFile({
			file,
			orgId: organizationId,
			showSuccessToast: false,
			setUploadStatus: (next) => {
				setStatus(next);
				if (next && "capId" in next) capIdRef.current = next.capId;
			},
		});

		if (ok && capIdRef.current) {
			trackEvent("onboarding_video_uploaded");
			setCapId(capIdRef.current);
			setPhase("done");
		} else {
			setPhase("idle");
		}
	};

	const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (file) upload(file);
	};

	const onDrop = (event: DragEvent<HTMLButtonElement>) => {
		event.preventDefault();
		setOver(false);
		const file = event.dataTransfer.files[0];
		if (file) upload(file);
	};

	const leaveTo = async (href: string) => {
		setLeaving(true);
		try {
			await complete("upload");
			router.push(href);
		} catch {
			setLeaving(false);
			toast.error("Something went wrong. Please try again.");
		}
	};

	return (
		<StepPage>
			<BackLink />
			<div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
				<div className="flex min-w-0 flex-col">
					<StepTitle>Upload a video</StepTitle>
					<StepLede>
						Drop in a recording you already have and get a link you can share
						straight away. No attachments, no waiting for exports.
					</StepLede>

					<input
						ref={inputRef}
						type="file"
						accept={VIDEO_ACCEPT}
						className="hidden"
						onChange={onFileChange}
					/>

					{phase === "done" && capId ? (
						<div className="ob-card ob-rise mt-8 flex flex-col items-start p-6 sm:p-7">
							<DoneDoodle />
							<h2 className="mt-3 text-[22px] font-medium tracking-[-0.01em]">
								Your video is ready to share
							</h2>
							<p className="mt-1.5 break-all text-[15px] leading-relaxed text-[var(--ob-ink-soft)]">
								{fileName}
							</p>
							<p className="mt-1 text-[15px] leading-relaxed text-[var(--ob-ink-soft)]">
								We're polishing it in the background. Your link already works.
							</p>
							<div className="mt-6 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
								<button
									type="button"
									className="ob-cta"
									disabled={leaving}
									onClick={() => leaveTo(`/s/${capId}`)}
								>
									Open my video
									<ArrowRight className="ob-cta-arrow size-4" aria-hidden />
								</button>
								<button
									type="button"
									className="ob-cta is-quiet"
									disabled={leaving}
									onClick={() => leaveTo("/dashboard/caps")}
								>
									Go to my Caps
								</button>
							</div>
						</div>
					) : phase === "working" ? (
						<div
							className="ob-card ob-rise mt-8 flex flex-col gap-5 p-6 sm:p-7"
							aria-live="polite"
						>
							<div className="flex items-center gap-3">
								<LoaderCircle
									className="size-5 shrink-0 animate-spin text-[var(--ob-accent)]"
									aria-hidden
								/>
								<div className="min-w-0">
									<p className="text-[16px] font-medium">
										{statusLabel(status)}
									</p>
									<p className="truncate text-[13.5px] text-[var(--ob-ink-soft)]">
										{fileName}
									</p>
								</div>
							</div>
							<SquiggleProgress progress={statusProgress(status)} />
							<p className="text-[13.5px] text-[var(--ob-ink-soft)]">
								Keep this tab open until the upload finishes.
							</p>
						</div>
					) : (
						<div
							className="ob-rise mt-8 flex flex-col gap-3"
							style={{ "--d": "0.12s" } as CSSProperties}
						>
							<button
								type="button"
								className="ob-drop ob-focus min-h-[260px] px-6 py-10"
								data-over={over}
								onClick={() =>
									isPro ? inputRef.current?.click() : promptUpgrade()
								}
								onDragOver={(event) => {
									event.preventDefault();
									setOver(true);
								}}
								onDragLeave={() => setOver(false)}
								onDrop={onDrop}
								disabled={upgrade.waiting}
							>
								<span className="ob-drop-outline ob-boil" aria-hidden="true" />
								<span className="block w-[92px]">
									<UploadDoodle />
								</span>
								<span className="mt-4 text-[18px] font-medium tracking-[-0.01em]">
									<span className="ob-pointer-only">
										{over ? "Let go to upload" : "Drop your video here"}
									</span>
									<span className="ob-touch-only">Choose a video</span>
								</span>
								<span className="mt-1 text-[14.5px] text-[var(--ob-ink-soft)]">
									<span className="ob-pointer-only">or </span>
									<span className="font-medium text-[var(--ob-ink)] underline decoration-[var(--ob-track-strong)] decoration-[1.5px] underline-offset-4">
										{isPro ? "choose a file" : "upgrade to upload"}
									</span>
								</span>
								<span className="mt-4 text-[12.5px] text-[var(--ob-ink-faint)]">
									MP4, MOV, WebM, MKV or AVI
								</span>
							</button>
							{upgrade.waiting ? (
								<ProNote>
									<span className="inline-flex items-center gap-2">
										<LoaderCircle
											className="size-3.5 animate-spin"
											aria-hidden
										/>
										Finishing your upgrade. This only takes a moment.
									</span>
								</ProNote>
							) : upgrade.timedOut ? (
								<ProNote>
									Your upgrade is taking a little longer than usual. Refresh
									this page in a moment to upload.
								</ProNote>
							) : (
								!isPro && (
									<ProNote>
										Uploading videos is part of Cap Pro.{" "}
										<Link
											href={onboardingStepHref("record")}
											className="ob-link !inline !text-[14px]"
										>
											Or record one for free
										</Link>
									</ProNote>
								)
							)}
						</div>
					)}
				</div>

				<Explainer
					className="ob-rise lg:sticky lg:top-8"
					label="How uploading works"
					loopSeconds={8}
					scene={<UploadScene />}
					steps={[
						{
							title: "Drop in a video file",
							body: "Drag it onto the page or choose it from your computer.",
						},
						{
							title: "We upload it and get it ready",
							body: "Big files are fine. Keep the tab open while it uploads.",
						},
						{
							title: "Share your link",
							body: "Send it anywhere. People can watch without signing up.",
						},
					]}
				/>
			</div>
			<UpgradeModal
				open={upgradeOpen}
				onOpenChange={setUpgradeOpen}
				returnPath={onboardingStepHref("upload")}
			/>
		</StepPage>
	);
};
