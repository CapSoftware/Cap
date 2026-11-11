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
import { MONO } from "./theme";

export type PanelTab = {
	id: string;
	label: string;
	code: string;
	content: ReactNode;
};

const listeners = new Set<() => void>();
const preferred = new Map<string, string>();

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

const setPreferred = (group: string, id: string) => {
	preferred.set(group, id);
	for (const listener of listeners) listener();
};

const usePreferred = (group: string) =>
	useSyncExternalStore(
		subscribe,
		() => preferred.get(group),
		() => undefined,
	);

const PRE = `${MONO} m-0 overflow-x-auto px-4 py-3.5 text-[12.5px] leading-[1.7] [tab-size:2]`;

export const CodePanel = ({
	tabs,
	response,
	responseLabel = "Response",
	label,
	group = "language",
	className,
}: {
	tabs: readonly PanelTab[];
	response?: ReactNode;
	responseLabel?: string;
	label: string;
	group?: string;
	className?: string;
}) => {
	const preferredId = usePreferred(group);
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
		setPreferred(group, tab.id);
		tabRefs.current[next]?.focus();
	};

	return (
		<div
			className={classNames(
				"min-w-0 overflow-hidden rounded-[10px] bg-[rgba(222,230,246,0.022)] text-[#E8ECF4] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.08)]",
				response ? "grid lg:grid-cols-2" : "",
				className,
			)}
		>
			<div className="min-w-0">
				<div className="flex h-10 items-center justify-between gap-3 border-b border-[rgba(222,230,246,0.07)] pl-4 pr-1.5">
					{switchable ? (
						<div role="tablist" aria-label={label} className="flex gap-4">
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
										onClick={() => setPreferred(group, tab.id)}
										onKeyDown={onKeyDown}
										className={classNames(
											"relative h-10 text-[13px] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.7)]",
											selected
												? "text-[#E8ECF4] after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-[#E8ECF4]"
												: "text-[rgba(232,236,244,0.42)] hover:text-[rgba(232,236,244,0.8)]",
										)}
									>
										{tab.label}
									</button>
								);
							})}
						</div>
					) : (
						<p className="m-0 text-[13px] leading-10 text-[rgba(232,236,244,0.42)]">
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
			</div>
			{response ? (
				<div className="min-w-0 border-t border-[rgba(222,230,246,0.07)] lg:border-l lg:border-t-0">
					<p className="m-0 flex h-10 items-center border-b border-[rgba(222,230,246,0.07)] px-4 text-[13px] text-[rgba(232,236,244,0.42)]">
						{responseLabel}
					</p>
					<pre className={PRE}>
						<code>{response}</code>
					</pre>
				</div>
			) : null}
		</div>
	);
};
