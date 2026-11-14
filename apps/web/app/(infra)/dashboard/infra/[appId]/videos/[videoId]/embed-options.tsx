"use client";

import clsx from "clsx";
import Link from "next/link";
import { useId, useState } from "react";
import {
	DEFAULT_EMBED_OPTIONS,
	type InfraEmbedOptions,
	infraVideoEmbedCode,
} from "@/lib/infra-video-view";
import { KeyRow } from "../../../_components/copy";
import { FOCUS, MUTED, TEXT_LINK, Toggle } from "../../../_components/ui";

const DEFAULT_ACCENT = "#3b82f6";

type Switch = Exclude<keyof InfraEmbedOptions, "color">;

export function EmbedOptions({
	embedUrl,
	video,
	hasCaptions,
}: {
	embedUrl: string;
	video: { name: string; width: number | null; height: number | null };
	hasCaptions: boolean;
}) {
	const [options, setOptions] = useState(DEFAULT_EMBED_OPTIONS);
	const colorId = useId();
	const set = (name: Switch) => (on: boolean) =>
		setOptions((current) => ({ ...current, [name]: on }));

	return (
		<>
			<div className="flex flex-wrap items-center gap-2 border-b border-[rgba(222,230,246,0.07)] py-3.5">
				<label
					htmlFor={colorId}
					className={clsx(
						"relative inline-flex h-8 cursor-pointer items-center gap-2 rounded-[8px] px-3 text-[13px] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12)] transition-shadow duration-200 hover:shadow-[inset_0_0_0_1px_rgba(222,230,246,0.22)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[rgba(232,236,244,0.8)]",
						options.color ? "text-[#E8ECF4]" : "text-[rgba(232,236,244,0.58)]",
					)}
				>
					<span
						aria-hidden="true"
						className="size-3 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]"
						style={{ background: options.color ?? "#f4f6fa" }}
					/>
					Accent colour
					<input
						id={colorId}
						type="color"
						value={options.color ?? DEFAULT_ACCENT}
						onChange={(event) =>
							setOptions((current) => ({
								...current,
								color: event.target.value,
							}))
						}
						className="absolute inset-0 size-full cursor-pointer opacity-0"
					/>
				</label>
				{options.color && (
					<button
						type="button"
						onClick={() =>
							setOptions((current) => ({ ...current, color: null }))
						}
						className={clsx(
							"h-8 rounded-[8px] px-2 text-[13px] text-[rgba(232,236,244,0.58)] transition-colors duration-200 hover:text-[#E8ECF4]",
							FOCUS,
						)}
					>
						Reset
					</button>
				)}
				<Toggle
					label="Controls"
					on={options.controls}
					onChange={set("controls")}
				/>
				<Toggle
					label="Autoplay muted"
					on={options.autoplay}
					onChange={set("autoplay")}
				/>
				{hasCaptions && (
					<Toggle
						label="Captions on"
						on={options.captions}
						onChange={set("captions")}
					/>
				)}
				<Toggle
					label="Quality menu"
					on={options.qualityMenu}
					onChange={set("qualityMenu")}
				/>
			</div>
			<KeyRow
				label="Embed code"
				value={infraVideoEmbedCode(embedUrl, video, options)}
			/>
			<p
				className={clsx(
					MUTED,
					"m-0 py-3.5 text-pretty text-[13px] leading-[1.55]",
				)}
			>
				Corner radius, a quality cap, hiding other buttons and events your page
				can listen to are in{" "}
				<Link
					href="/docs/api/rest-api#embed-options"
					className={clsx(TEXT_LINK, FOCUS, "rounded-[2px]")}
				>
					Embed Options
				</Link>
				.
			</p>
		</>
	);
}
