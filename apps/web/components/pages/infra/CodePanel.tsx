"use client";

import { classNames } from "@cap/utils/helpers";
import {
	type KeyboardEvent,
	type ReactNode,
	useId,
	useRef,
	useSyncExternalStore,
} from "react";
import { CopyIconButton } from "@/components/pages/agents/copy";
import { GRAIN, MONO } from "@/components/pages/HomeTwo/theme";

export type PanelTab = {
	id: string;
	label: string;
	code: string;
	content: ReactNode;
};

const listeners = new Set<() => void>();
let preferred = "curl";

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

const setPreferred = (id: string) => {
	preferred = id;
	for (const listener of listeners) listener();
};

const usePreferred = () =>
	useSyncExternalStore(
		subscribe,
		() => preferred,
		() => "curl",
	);

const PRE = `${MONO} m-0 overflow-x-auto px-5 py-4 text-[12px] leading-[1.75] [tab-size:2] sm:text-[13px]`;

export const CodePanel = ({
	tabs,
	response,
	label,
	className,
}: {
	tabs: readonly PanelTab[];
	response?: ReactNode;
	label: string;
	className?: string;
}) => {
	const preferredId = usePreferred();
	const baseId = useId();
	const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const active = tabs.find((tab) => tab.id === preferredId) ?? tabs[0];
	if (!active) return null;
	const activeIndex = tabs.indexOf(active);
	const switchable = tabs.length > 1;

	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
		event.preventDefault();
		const step = event.key === "ArrowRight" ? 1 : -1;
		const next = (activeIndex + step + tabs.length) % tabs.length;
		const tab = tabs[next];
		if (!tab) return;
		setPreferred(tab.id);
		tabRefs.current[next]?.focus();
	};

	return (
		<div
			className={classNames(
				"min-w-0 overflow-hidden rounded-[18px] text-[#E8EDF3] shadow-[0_0_0_1px_rgba(17,17,17,0.9),0_24px_48px_-24px_rgba(17,17,17,0.45)]",
				className,
			)}
			style={{
				backgroundColor: "#141517",
				backgroundImage: GRAIN,
				backgroundSize: "200px 200px",
			}}
		>
			<div className="flex items-center justify-between gap-3 border-b border-white/[0.07] py-2 pl-2 pr-2">
				{switchable ? (
					<div role="tablist" aria-label={label} className="flex gap-1">
						{tabs.map((tab, i) => {
							const selected = tab.id === active.id;
							return (
								<button
									key={tab.id}
									ref={(node) => {
										tabRefs.current[i] = node;
									}}
									type="button"
									role="tab"
									id={`${baseId}-tab-${tab.id}`}
									aria-selected={selected}
									aria-controls={`${baseId}-panel`}
									tabIndex={selected ? 0 : -1}
									onClick={() => setPreferred(tab.id)}
									onKeyDown={onKeyDown}
									className={classNames(
										"h-8 rounded-[9px] px-3 text-[13px] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
										selected
											? "bg-white/[0.09] text-white"
											: "text-white/50 hover:bg-white/[0.05] hover:text-white/85",
									)}
								>
									{tab.label}
								</button>
							);
						})}
					</div>
				) : (
					<p className="m-0 px-3 text-[13px] leading-8 text-white/60">
						{active.label}
					</p>
				)}
				<CopyIconButton text={active.code} label={label} dark />
			</div>
			{switchable ? (
				<div
					id={`${baseId}-panel`}
					role="tabpanel"
					aria-labelledby={`${baseId}-tab-${active.id}`}
				>
					<pre className={PRE}>
						<code>{active.content}</code>
					</pre>
				</div>
			) : (
				<pre className={PRE}>
					<code>{active.content}</code>
				</pre>
			)}
			{response ? (
				<div className="border-t border-white/[0.07] bg-black/25">
					<p className="m-0 px-5 pt-3.5 text-[12.5px] text-white/45">
						Response
					</p>
					<pre className={classNames(PRE, "pt-2")}>
						<code>{response}</code>
					</pre>
				</div>
			) : null}
		</div>
	);
};
