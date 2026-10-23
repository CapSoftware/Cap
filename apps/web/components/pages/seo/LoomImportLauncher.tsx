"use client";

import { classNames } from "@cap/utils/helpers";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { BTN_PRIMARY, MONO } from "@/components/pages/HomeTwo/theme";
import {
	buildLoomImportHref,
	isLoomShareUrl,
	type LoomImportMode,
} from "@/lib/loom-import-href";

const SOURCE_PAGE = "migrate_from_loom";

const track = (location: string, extra: Record<string, unknown>) =>
	trackEvent("loom_import_cta_clicked", {
		source_page: SOURCE_PAGE,
		cta_location: location,
		...extra,
	});

export const LoomImportLink = ({
	signedIn,
	location,
	mode,
	className,
	children,
}: {
	signedIn: boolean;
	location: string;
	mode?: LoomImportMode;
	className?: string;
	children: ReactNode;
}) => (
	<Link
		href={buildLoomImportHref({ signedIn, mode })}
		onClick={() =>
			track(location, { mode: mode ?? "single", signed_in: signedIn })
		}
		className={className}
	>
		{children}
	</Link>
);

export const LoomImportLauncher = ({ signedIn }: { signedIn: boolean }) => {
	const router = useRouter();
	const inputId = useId();
	const errorId = useId();
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const loomUrl = value.trim();
		if (loomUrl && !isLoomShareUrl(loomUrl)) {
			setError(
				"That doesn't look like a Loom link. Paste a share link such as https://www.loom.com/share/abc123.",
			);
			return;
		}
		setError(null);
		setSubmitting(true);
		track("hero_paste", { has_url: Boolean(loomUrl), signed_in: signedIn });
		router.push(
			buildLoomImportHref({ signedIn, loomUrl: loomUrl || undefined }),
		);
	};

	return (
		<form onSubmit={submit} noValidate className="mt-9 w-full max-w-[600px]">
			<label htmlFor={inputId} className="sr-only">
				Loom share link
			</label>
			<div className="flex flex-col gap-2 rounded-[16px] bg-white p-2 shadow-[0_0_0_1px_rgba(17,17,17,0.08),0_18px_40px_-28px_rgba(17,17,17,0.35)] sm:flex-row sm:items-center">
				<input
					id={inputId}
					type="url"
					inputMode="url"
					autoComplete="off"
					spellCheck={false}
					value={value}
					onChange={(event) => {
						setValue(event.target.value);
						if (error) setError(null);
					}}
					placeholder="https://www.loom.com/share/..."
					aria-invalid={Boolean(error)}
					aria-describedby={error ? errorId : undefined}
					className={classNames(
						MONO,
						"h-[48px] min-w-0 flex-1 rounded-[10px] bg-transparent px-4 text-[14px] text-[#111111] placeholder:text-[rgba(17,17,17,0.35)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#55A0EA]",
					)}
				/>
				<button
					type="submit"
					disabled={submitting}
					className={classNames(BTN_PRIMARY, "shrink-0 disabled:opacity-80")}
				>
					Import to Cap
					<ArrowRight className="ml-2 size-4" />
				</button>
			</div>
			{error ? (
				<p
					id={errorId}
					role="alert"
					className="mt-2 text-[13.5px] leading-[1.5] text-[#B42318]"
				>
					{error}
				</p>
			) : null}
			<div className="mt-4 flex flex-col gap-2 text-[14px] leading-[1.5] text-[rgba(17,17,17,0.6)] sm:flex-row sm:items-center sm:justify-between">
				<span>Paste one link now, or skip it and add videos inside Cap.</span>
				<LoomImportLink
					signedIn={signedIn}
					mode="csv"
					location="hero_csv"
					className="inline-flex items-center gap-1 whitespace-nowrap text-[#111111] underline decoration-[rgba(17,17,17,0.3)] underline-offset-[5px] transition-colors duration-200 hover:decoration-[#111111]"
				>
					Bulk import from a CSV
					<ArrowRight className="size-3.5" />
				</LoomImportLink>
			</div>
		</form>
	);
};
