"use client";

import { ArrowLeftIcon, CirclePlayIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EditorShellBar } from "@/components/editor-shell/editor-shell-bar";
import { useDashboardContext } from "../../../Contexts";

interface WebRecorderDialogHeaderProps {
	isBusy: boolean;
	freeMinutes: number;
	onBack: () => void;
	onShowHowItWorks?: () => void;
	/** The Editor page's tabs, which take the title's place when embedded. */
	tabs?: ReactNode;
}

export const WebRecorderDialogHeader = ({
	isBusy,
	freeMinutes,
	onBack,
	onShowHowItWorks,
	tabs,
}: WebRecorderDialogHeaderProps) => {
	const { user, setUpgradeModalOpen } = useDashboardContext();

	const back = (
		<button
			type="button"
			onClick={onBack}
			disabled={isBusy}
			className="rec-btn is-ghost"
		>
			<ArrowLeftIcon className="size-4" aria-hidden />
			Dashboard
		</button>
	);

	const actions = (
		<>
			{onShowHowItWorks && (
				<button
					type="button"
					className="rec-btn is-ghost max-sm:!w-8 max-sm:!px-0"
					onClick={onShowHowItWorks}
					aria-label="How does recording work?"
				>
					<CirclePlayIcon className="size-4" aria-hidden />
					<span className="hidden sm:inline">How does recording work?</span>
				</button>
			)}
			{user.isPro ? (
				<span className="rounded-md bg-[var(--rec-ctl)] px-2 py-1 text-[12px] font-medium text-[var(--rec-text-2)]">
					Pro
				</span>
			) : (
				<button
					type="button"
					onClick={() => setUpgradeModalOpen(true)}
					className="rec-btn !h-7 !px-2.5 !text-[12px] text-[var(--rec-text-2)]"
				>
					Free · up to {freeMinutes} min
				</button>
			)}
		</>
	);

	if (tabs) {
		return <EditorShellBar left={back} center={tabs} right={actions} />;
	}

	return (
		<header className="flex h-[52px] shrink-0 items-center justify-between gap-3 px-2 sm:px-3">
			<div className="flex min-w-0 items-center gap-2">
				{back}
				<svg
					className="size-5 shrink-0"
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 40 40"
					aria-hidden
				>
					<title>Cap</title>
					<path
						fill="#4785FF"
						d="M20 36c8.837 0 16-7.163 16-16S28.837 4 20 4 4 11.164 4 20s7.164 16 16 16"
					/>
					<path
						fill="#ADC9FF"
						d="M20 33c7.18 0 13-5.82 13-13S27.18 7 20 7 7 12.82 7 20s5.82 13 13 13"
					/>
					<path
						fill="#fff"
						d="M20 30c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10"
					/>
				</svg>
				<span className="truncate text-[14px] font-medium">New recording</span>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">{actions}</div>
		</header>
	);
};
