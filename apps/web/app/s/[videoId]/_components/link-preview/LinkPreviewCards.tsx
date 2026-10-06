"use client";

import clsx from "clsx";

export type UnfurlContent = {
	title: string;
	description: string;
	host: string;
	imageUrl: string;
	ownerName: string;
};

export type UnfurlApp = "imessage" | "slack" | "x";

export const UNFURL_APPS: { id: UnfurlApp; label: string }[] = [
	{ id: "imessage", label: "iMessage" },
	{ id: "slack", label: "Slack" },
	{ id: "x", label: "X" },
];

const SYSTEM_FONT =
	"font-[system-ui,-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]";

function UnfurlImage({
	src,
	className,
	children,
}: {
	src: string;
	className?: string;
	children?: React.ReactNode;
}) {
	return (
		<div
			className={clsx(
				"relative aspect-[1200/630] w-full overflow-hidden bg-gray-4 bg-cover bg-center",
				className,
			)}
			style={{ backgroundImage: `url(${JSON.stringify(src)})` }}
		>
			{children}
		</div>
	);
}

function IMessageCard({ content }: { content: UnfurlContent }) {
	return (
		<div className={clsx("flex flex-col items-end gap-1", SYSTEM_FONT)}>
			<div className="w-full max-w-[300px] overflow-hidden rounded-[18px] bg-[#e9e9eb] dark:bg-[#26252a]">
				<UnfurlImage src={content.imageUrl} />
				<div className="px-3.5 py-2.5">
					<p className="line-clamp-2 text-[13px] font-semibold leading-[1.3] text-black dark:text-white">
						{content.title}
					</p>
					<p className="mt-0.5 truncate text-[12px] leading-[1.3] text-[#8a8a8e]">
						{content.host}
					</p>
				</div>
			</div>
			<p className="pr-1.5 text-[10px] font-medium text-gray-9">Delivered</p>
		</div>
	);
}

function SlackCard({ content }: { content: UnfurlContent }) {
	const initial = content.ownerName.trim().charAt(0).toUpperCase() || "C";
	return (
		<div className={clsx("flex w-full max-w-[420px] gap-2.5", SYSTEM_FONT)}>
			<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-9 text-sm font-semibold text-white">
				{initial}
			</span>
			<div className="min-w-0 flex-1">
				<p className="flex items-baseline gap-2 text-[14px] leading-5">
					<span className="truncate font-bold text-gray-12">
						{content.ownerName}
					</span>
					<span className="shrink-0 text-[11px] text-gray-9">10:24 AM</span>
				</p>
				<p className="truncate text-[14px] leading-5 text-[#1264a3] dark:text-[#1d9bd1]">
					https://{content.host}/s/…
				</p>
				<div className="mt-1.5 flex gap-3">
					<span className="w-1 shrink-0 rounded-full bg-gray-5" />
					<div className="min-w-0 flex-1 pb-0.5">
						<p className="flex items-center gap-1.5 text-[13px] font-bold leading-5 text-gray-12">
							<span className="flex size-4 items-center justify-center rounded-[4px] bg-gray-12 text-[9px] font-bold text-gray-1">
								{content.host.charAt(0).toUpperCase()}
							</span>
							<span className="truncate">{content.host}</span>
						</p>
						<p className="mt-0.5 line-clamp-2 text-[14px] font-bold leading-5 text-[#1264a3] dark:text-[#1d9bd1]">
							{content.title}
						</p>
						<p className="mt-0.5 line-clamp-3 text-[14px] leading-5 text-gray-12">
							{content.description}
						</p>
						<UnfurlImage
							src={content.imageUrl}
							className="mt-2 max-w-[340px] rounded-lg ring-1 ring-black/10 dark:ring-white/10"
						/>
					</div>
				</div>
			</div>
		</div>
	);
}

function XCard({ content }: { content: UnfurlContent }) {
	return (
		<div className={clsx("w-full max-w-[400px]", SYSTEM_FONT)}>
			<UnfurlImage
				src={content.imageUrl}
				className="rounded-2xl ring-1 ring-black/10 dark:ring-white/15"
			>
				<span className="absolute bottom-2.5 left-2.5 max-w-[calc(100%-1.25rem)] truncate rounded-[4px] bg-black/75 px-1.5 py-0.5 text-[13px] leading-[1.3] text-white">
					{content.title}
				</span>
			</UnfurlImage>
			<p className="mt-1 truncate text-[13px] text-gray-10">
				From {content.host}
			</p>
		</div>
	);
}

export function UnfurlCard({
	app,
	content,
}: {
	app: UnfurlApp;
	content: UnfurlContent;
}) {
	if (app === "imessage") return <IMessageCard content={content} />;
	if (app === "slack") return <SlackCard content={content} />;
	return <XCard content={content} />;
}
