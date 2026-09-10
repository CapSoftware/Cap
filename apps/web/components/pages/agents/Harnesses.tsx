"use client";

import { classNames } from "@cap/utils/helpers";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { type ReactNode, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { Eyebrow } from "@/components/pages/HomeTwo/Eyebrow";
import {
	BAND,
	BODY_TEXT,
	grainBg,
	H_SECTION,
	MODE_THEME,
	MONO,
} from "@/components/pages/HomeTwo/theme";
import {
	ANCHORS,
	type HarnessKey,
	harnesses,
	INSTALLERS,
	VERIFY_LINES,
} from "./content";
import { Snippet } from "./copy";

type Os = keyof typeof INSTALLERS;

const OS_LABELS: Record<Os, string> = {
	unix: "macOS / Linux",
	windows: "Windows",
};

const TAB_CSS = `
	@keyframes ag-tab-in {
		from { opacity: 0; transform: translateY(6px); }
		to { opacity: 1; transform: none; }
	}
	.ag-tab-in { animation: ag-tab-in 340ms cubic-bezier(0.22, 1, 0.36, 1); }
	@media (prefers-reduced-motion: reduce) {
		.ag-tab-in { animation: none; }
	}
`;

const PILL_GROUP =
	"inline-flex flex-wrap items-center gap-1 rounded-full bg-white p-1 shadow-[0_0_0_1px_rgba(17,17,17,0.06)]";

const pill = (active: boolean) =>
	classNames(
		"rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]",
		active
			? "bg-[#111111] text-white"
			: "text-[rgba(17,17,17,0.6)] hover:text-[#111111]",
	);

const StepLabel = ({
	step,
	title,
	children,
}: {
	step: string;
	title: string;
	children: ReactNode;
}) => (
	<div>
		<span
			className={classNames(
				MONO,
				"text-[11px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.45)]",
			)}
		>
			{step}
		</span>
		<h3 className="mt-2.5 text-[21px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
			{title}
		</h3>
		<p
			className={`${BODY_TEXT} mt-2 max-w-[300px] text-[14.5px] leading-[1.5] text-[rgba(17,17,17,0.7)]`}
		>
			{children}
		</p>
	</div>
);

const Divider = () => <div className="my-7 h-px bg-[#E1E7EE] lg:my-8" />;

export const Harnesses = () => {
	const { platform } = useDetectPlatform();
	const [osChoice, setOsChoice] = useState<Os | null>(null);
	const os: Os = osChoice ?? (platform === "windows" ? "windows" : "unix");
	const [tab, setTab] = useState<HarnessKey>("claude");
	const active = harnesses.find((item) => item.key === tab) ?? harnesses[0];
	if (!active) return null;

	return (
		<section
			id={ANCHORS.harnesses}
			className="scroll-mt-24 px-5 pb-20 lg:pb-28"
		>
			<style>{TAB_CSS}</style>
			<div className="mx-auto max-w-[1200px]">
				<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
					<Eyebrow accent={MODE_THEME.screenshot.accent}>Every harness</Eyebrow>
					<h2
						className={`${H_SECTION} mt-6 text-balance text-[clamp(36px,4.6vw,56px)]`}
					>
						Works in Claude Code, Codex, Cursor and OpenCode
					</h2>
					<p
						className={`${BODY_TEXT} mt-6 max-w-[620px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
					>
						The setup prompt handles all of this for you. If you would rather
						wire it up by hand, this is exactly what gets installed for each
						agent and what to run to check it.
					</p>
				</div>

				<div className="mt-12 rounded-[20px] p-5 lg:p-8" style={grainBg(BAND)}>
					<div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-10">
						<StepLabel step="Step 1" title="Install the Cap CLI">
							Adds cap to your PATH and brings Cap Desktop with it. Open a new
							terminal afterwards.
						</StepLabel>
						<div>
							<div className={PILL_GROUP}>
								{(Object.keys(OS_LABELS) as Os[]).map((key) => (
									<button
										key={key}
										type="button"
										aria-pressed={os === key}
										onClick={() => setOsChoice(key)}
										className={pill(os === key)}
									>
										{OS_LABELS[key]}
									</button>
								))}
							</div>
							<Snippet
								lines={[INSTALLERS[os]]}
								label="installer command"
								onCopy={() =>
									trackEvent("agents_snippet_copied", {
										source_page: "agents_harnesses",
										snippet: "installer",
										os,
									})
								}
								className="mt-3"
							/>
						</div>
					</div>

					<Divider />

					<div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-10">
						<StepLabel step="Step 2" title="Connect your agent">
							A skill that routes Cap tasks through the CLI and MCP, plus a
							local MCP server entry. Nothing else in your config is touched.
						</StepLabel>
						<div>
							<div className={PILL_GROUP}>
								{harnesses.map((item) => (
									<button
										key={item.key}
										type="button"
										aria-pressed={item.key === tab}
										onClick={() => setTab(item.key)}
										className={pill(item.key === tab)}
									>
										{item.label}
									</button>
								))}
							</div>
							<div
								key={active.key}
								className="ag-tab-in mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_260px]"
							>
								<div className="flex flex-col gap-4">
									<p
										className={`${BODY_TEXT} text-[15px] leading-[1.5] text-[rgba(17,17,17,0.75)]`}
									>
										{active.tagline}
									</p>
									{active.snippets.map((snippet) => (
										<div key={snippet.label}>
											<span
												className={classNames(
													MONO,
													"mb-2 block text-[11px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.45)]",
												)}
											>
												{snippet.label}
											</span>
											<Snippet
												lines={snippet.lines}
												prompt={snippet.prompt}
												label={`${active.label} ${snippet.label.toLowerCase()}`}
												onCopy={() =>
													trackEvent("agents_snippet_copied", {
														source_page: "agents_harnesses",
														snippet: snippet.label,
														harness: active.key,
													})
												}
											/>
										</div>
									))}
								</div>
								<div className="flex flex-col rounded-[14px] bg-white p-5 shadow-[0_0_0_1px_rgba(17,17,17,0.06)]">
									<span
										className={classNames(
											MONO,
											"text-[11px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.45)]",
										)}
									>
										What gets installed
									</span>
									<dl className="mt-4 flex flex-col gap-3.5">
										{active.installs.map((item) => (
											<div key={item.label}>
												<dt className="text-[13px] font-medium text-[#111111]">
													{item.label}
												</dt>
												<dd
													className={classNames(
														MONO,
														"mt-1 break-words text-[12px] leading-[1.5] text-[rgba(17,17,17,0.65)]",
													)}
												>
													{item.value}
												</dd>
											</div>
										))}
									</dl>
									<p
										className={`${BODY_TEXT} mt-5 border-t border-[#E1E7EE] pt-4 text-[13.5px] leading-[1.5] text-[rgba(17,17,17,0.7)]`}
									>
										{active.after}
									</p>
								</div>
							</div>
						</div>
					</div>

					<Divider />

					<div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-10">
						<StepLabel step="Step 3" title="Verify, read only">
							Valid JSON on stdout, an authenticated status, and a real library
							result, even if it is empty. No secrets printed, nothing changed.
						</StepLabel>
						<Snippet
							lines={VERIFY_LINES}
							label="verification commands"
							onCopy={() =>
								trackEvent("agents_snippet_copied", {
									source_page: "agents_harnesses",
									snippet: "verify",
								})
							}
						/>
					</div>
				</div>
			</div>
		</section>
	);
};
