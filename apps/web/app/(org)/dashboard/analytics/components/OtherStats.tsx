"use client";

import {
	faAndroid,
	faApple,
	faEdge,
	faLinux,
	faUbuntu,
	faWindows,
} from "@fortawesome/free-brands-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import getUnicodeFlagIcon from "country-flag-icons/unicode";
import { motion } from "framer-motion";
import {
	ChevronRight,
	Globe2,
	Monitor,
	Play,
	Smartphone,
	Tablet,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import type { BreakdownRow } from "../types";
import { GlobeDoodle, LaptopDoodle, StackDoodle } from "./Doodles";
import { countryName, formatCompact, formatPercent } from "./format";

export interface OtherStatsData {
	countries: BreakdownRow[];
	cities: BreakdownRow[];
	browsers: BreakdownRow[];
	operatingSystems: BreakdownRow[];
	deviceTypes: BreakdownRow[];
	topCaps?: Array<BreakdownRow & { id?: string }> | null;
}

interface OtherStatsProps {
	data: OtherStatsData;
	isLoading?: boolean;
}

type Row = {
	key: string;
	label: string;
	icon: ReactNode;
	views: number;
	percentage: number;
	onSelect?: () => void;
};

type Tab = {
	id: string;
	label: string;
	rows: Row[];
};

const flag = (code: string | null | undefined) => {
	if (!code || !/^[A-Za-z]{2}$/.test(code.trim())) {
		return <Globe2 className="size-4 text-gray-10" />;
	}
	return (
		<span className="text-[15px] leading-none">
			{getUnicodeFlagIcon(code.trim().toUpperCase())}
		</span>
	);
};

const BROWSER_LOGOS: Record<string, string> = {
	chrome: "google-chrome",
	firefox: "firefox",
	safari: "safari",
	opera: "opera",
	brave: "brave",
	vivaldi: "vivaldi",
	yandex: "yandex",
	duckduckgo: "duckduckgo",
	"internet explorer": "explorer",
};

const browserIcon = (name: string) => {
	const lower = name.toLowerCase();
	if (lower.includes("edge")) {
		return <FontAwesomeIcon icon={faEdge} className="size-4 text-[#0f7cd8]" />;
	}
	const logo = BROWSER_LOGOS[lower];
	if (!logo) return <Globe2 className="size-4 text-gray-10" />;
	return (
		<Image
			src={`/logos/browsers/${logo}.svg`}
			alt=""
			width={16}
			height={16}
			className="size-4"
		/>
	);
};

const osIcon = (name: string) => {
	const lower = name.toLowerCase();
	if (lower.includes("mac") || lower === "ios")
		return <FontAwesomeIcon icon={faApple} className="size-4 text-gray-12" />;
	if (lower.includes("windows"))
		return (
			<FontAwesomeIcon icon={faWindows} className="size-4 text-[#0078d4]" />
		);
	if (lower.includes("android"))
		return (
			<FontAwesomeIcon icon={faAndroid} className="size-4 text-[#3ddc84]" />
		);
	if (lower.includes("ubuntu"))
		return (
			<FontAwesomeIcon icon={faUbuntu} className="size-4 text-[#e95420]" />
		);
	if (lower.includes("linux") || lower.includes("fedora"))
		return <FontAwesomeIcon icon={faLinux} className="size-4 text-gray-12" />;
	return <Monitor className="size-4 text-gray-10" />;
};

const deviceIcon = (name: string) => {
	const lower = name.toLowerCase();
	if (lower === "mobile") return <Smartphone className="size-4 text-gray-11" />;
	if (lower === "tablet") return <Tablet className="size-4 text-gray-11" />;
	return <Monitor className="size-4 text-gray-11" />;
};

const toRows = (
	rows: BreakdownRow[],
	map: (row: BreakdownRow) => Pick<Row, "label" | "icon">,
): Row[] =>
	rows.map((row, i) => ({
		key: `${row.name}-${row.subtitle ?? ""}-${i}`,
		views: row.views,
		percentage: row.percentage,
		...map(row),
	}));

export default function OtherStats({ data, isLoading }: OtherStatsProps) {
	const router = useRouter();

	const locationTabs: Tab[] = [
		{
			id: "country",
			label: "Country",
			rows: toRows(data.countries, (row) => ({
				label: countryName(row.name),
				icon: flag(row.name),
			})),
		},
		{
			id: "city",
			label: "City",
			rows: toRows(data.cities, (row) => ({
				label: row.subtitle
					? `${row.name}, ${countryName(row.subtitle)}`
					: row.name,
				icon: flag(row.subtitle),
			})),
		},
	];

	const techTabs: Tab[] = [
		{
			id: "browser",
			label: "Browser",
			rows: toRows(data.browsers, (row) => ({
				label: row.name,
				icon: browserIcon(row.name),
			})),
		},
		{
			id: "os",
			label: "OS",
			rows: toRows(data.operatingSystems, (row) => ({
				label: row.name,
				icon: osIcon(row.name),
			})),
		},
		{
			id: "device",
			label: "Device",
			rows: toRows(data.deviceTypes, (row) => ({
				label: row.name,
				icon: deviceIcon(row.name),
			})),
		},
	];

	const topCaps = data.topCaps;

	return (
		<div className="grid grid-cols-1 gap-5 w-full lg:grid-cols-2">
			<BreakdownCard
				tabs={locationTabs}
				isLoading={isLoading}
				empty={{
					doodle: <GlobeDoodle />,
					title: "Nowhere yet",
					body: "Countries and cities show up as people watch.",
				}}
			/>
			<BreakdownCard
				tabs={techTabs}
				isLoading={isLoading}
				empty={{
					doodle: <LaptopDoodle />,
					title: "No devices yet",
					body: "Browsers, systems and devices show up as people watch.",
				}}
			/>
			{topCaps && (
				<BreakdownCard
					className="lg:col-span-2"
					tabs={[
						{
							id: "caps",
							label: "Top Caps",
							rows: topCaps.map((row, i) => ({
								key: row.id ?? `${row.name}-${i}`,
								label: row.name,
								icon: (
									<span className="flex justify-center items-center rounded-md size-5 bg-gray-3">
										<Play className="size-2.5 fill-gray-11 text-gray-11" />
									</span>
								),
								views: row.views,
								percentage: row.percentage,
								onSelect: row.id
									? () => router.push(`/dashboard/analytics?capId=${row.id}`)
									: undefined,
							})),
						},
					]}
					isLoading={isLoading}
					empty={{
						doodle: <StackDoodle />,
						title: "No Caps watched yet",
						body: "Your most watched Caps will line up here.",
					}}
				/>
			)}
		</div>
	);
}

function BreakdownCard({
	tabs,
	isLoading,
	empty,
	className,
}: {
	tabs: Tab[];
	isLoading?: boolean;
	empty: { doodle: ReactNode; title: string; body: string };
	className?: string;
}) {
	const [activeId, setActiveId] = useState(tabs[0]?.id ?? "");
	const layoutId = useId();
	const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
	const rows = active?.rows ?? [];
	const max = rows.reduce((m, r) => Math.max(m, r.views), 0);

	return (
		<section
			className={clsx(
				"flex flex-col w-full rounded-2xl border shadow-[0_1px_2px_rgba(0,0,0,0.04)] bg-gray-1 border-gray-4",
				tabs.length > 1 && "min-h-[460px]",
				className,
			)}
		>
			<div className="flex justify-between items-center px-3 pt-3 pb-2">
				{tabs.length === 1 ? (
					<h3 className="px-3 py-1.5 text-[15px] font-medium text-gray-12">
						{tabs[0]?.label}
					</h3>
				) : (
					<div
						className="flex gap-0.5 items-center p-1 rounded-xl bg-gray-3"
						role="tablist"
					>
						{tabs.map((tab) => {
							const selected = tab.id === active?.id;
							return (
								<button
									key={tab.id}
									type="button"
									role="tab"
									aria-selected={selected}
									onClick={() => setActiveId(tab.id)}
									className={clsx(
										"relative px-3 py-1 text-[13px] font-medium rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-9/40",
										selected
											? "text-gray-12"
											: "text-gray-10 hover:text-gray-12",
									)}
								>
									{selected && (
										<motion.span
											layoutId={layoutId}
											className="absolute inset-0 rounded-lg border shadow-sm bg-gray-1 border-gray-4"
											transition={{
												type: "spring",
												stiffness: 500,
												damping: 38,
											}}
										/>
									)}
									<span className="relative">{tab.label}</span>
								</button>
							);
						})}
					</div>
				)}
				<span className="pr-3 text-[13px] font-medium text-gray-10">Views</span>
			</div>

			<div className="flex flex-col flex-1 px-2 pb-3">
				{isLoading ? (
					<div className="flex flex-col gap-1 pt-1">
						{[86, 64, 48, 36, 28, 20].map((w) => (
							<div key={w} className="relative h-10 rounded-lg">
								<div
									className="absolute inset-y-0 left-0 rounded-lg animate-pulse bg-gray-3"
									style={{ width: `${w}%` }}
								/>
							</div>
						))}
					</div>
				) : rows.length === 0 ? (
					<div className="flex flex-col flex-1 justify-center items-center px-6 pb-6 text-center">
						{empty.doodle}
						<p className="mt-3 text-[15px] font-medium text-gray-12">
							{empty.title}
						</p>
						<p className="mt-1 max-w-[260px] text-[13px] text-gray-10 text-pretty">
							{empty.body}
						</p>
					</div>
				) : (
					<ul key={active?.id} className="flex flex-col gap-1 pt-1">
						{rows.map((row, i) => (
							<BreakdownRowItem key={row.key} row={row} max={max} index={i} />
						))}
					</ul>
				)}
			</div>
		</section>
	);
}

function BreakdownRowItem({
	row,
	max,
	index,
}: {
	row: Row;
	max: number;
	index: number;
}) {
	const width = max > 0 ? Math.max(2, (row.views / max) * 100) : 0;
	const content = (
		<>
			<motion.span
				className="absolute inset-y-0 left-0 rounded-lg bg-[#4785ff]/[0.09] transition-colors group-hover:bg-[#4785ff]/[0.16] dark:bg-[#4785ff]/[0.16] dark:group-hover:bg-[#4785ff]/[0.24]"
				initial={{ width: 0 }}
				animate={{ width: `${width}%` }}
				transition={{
					duration: 0.6,
					delay: index * 0.035,
					ease: [0.3, 0.9, 0.4, 1],
				}}
			/>
			<span className="flex relative z-[1] flex-1 gap-2.5 items-center min-w-0">
				<span className="flex flex-shrink-0 justify-center items-center size-5">
					{row.icon}
				</span>
				<span className="text-sm truncate text-gray-12">{row.label}</span>
				{row.onSelect && (
					<ChevronRight className="flex-shrink-0 opacity-0 transition-opacity size-3.5 text-gray-10 group-hover:opacity-100" />
				)}
			</span>
			<span className="flex relative z-[1] flex-shrink-0 gap-2 items-baseline pl-3 tabular-nums">
				<span className="text-xs opacity-0 transition-opacity text-gray-10 group-hover:opacity-100">
					{formatPercent(row.percentage)}
				</span>
				<span className="text-sm font-medium text-gray-12">
					{formatCompact(row.views)}
				</span>
			</span>
		</>
	);

	const rowClass =
		"group relative flex items-center w-full h-10 px-3 rounded-lg text-left overflow-hidden";

	return (
		<li>
			{row.onSelect ? (
				<button
					type="button"
					onClick={row.onSelect}
					className={clsx(
						rowClass,
						"cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-9/40",
					)}
					title={row.label}
				>
					{content}
				</button>
			) : (
				<div className={rowClass} title={row.label}>
					{content}
				</div>
			)}
		</li>
	);
}
