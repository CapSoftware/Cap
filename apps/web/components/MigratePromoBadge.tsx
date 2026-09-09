"use client";

import { classNames } from "@cap/utils/helpers";
import { Check, Copy, Tag } from "lucide-react";
import { useEffect, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { MONO } from "@/components/pages/HomeTwo/theme";
import { MIGRATE_PROMO_CODE } from "@/components/pages/seo/migrate-from-loom-content";

const COPIED_MS = 1800;

export const MigratePromoBadge = ({
	sourcePage,
	className,
}: {
	sourcePage: string;
	className?: string;
}) => {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
		return () => window.clearTimeout(timer);
	}, [copied]);

	const copy = async () => {
		trackEvent("loom_promo_code_copied", {
			source_page: sourcePage,
			code: MIGRATE_PROMO_CODE,
		});
		try {
			await navigator.clipboard.writeText(MIGRATE_PROMO_CODE);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	};

	return (
		<div
			className={classNames(
				"inline-flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-full bg-white py-1.5 pl-2 pr-1.5 shadow-[0_0_0_1px_rgba(17,17,17,0.08)]",
				className,
			)}
		>
			<span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#DDF5E8] text-[#1B6E45]">
				<Tag className="size-3.5" strokeWidth={2} />
			</span>
			<span className="text-[14px] leading-none text-[#111111]">
				<span className="font-medium">20% off Cap Pro</span>
				<span className="text-[rgba(17,17,17,0.6)]"> with code</span>
			</span>
			<button
				type="button"
				onClick={copy}
				aria-label={
					copied
						? `Copied ${MIGRATE_PROMO_CODE}`
						: `Copy code ${MIGRATE_PROMO_CODE}`
				}
				className={classNames(
					MONO,
					"inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-[#111111] pl-2.5 pr-2 text-[12px] leading-none tracking-[0.05em] text-white transition-colors duration-200 hover:bg-[#2A2A2A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-2",
				)}
			>
				{MIGRATE_PROMO_CODE}
				{copied ? (
					<Check className="size-3 text-[#8FDCBB]" strokeWidth={2.5} />
				) : (
					<Copy className="size-3 opacity-70" strokeWidth={2} />
				)}
			</button>
			<span aria-live="polite" className="sr-only">
				{copied ? "Code copied" : ""}
			</span>
		</div>
	);
};
