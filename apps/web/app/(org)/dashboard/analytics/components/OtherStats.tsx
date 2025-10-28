"use client";

import {
	Logo,
	LogoBadge,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@cap/ui";
import {
	faAppleWhole,
	faCamera,
	faDesktop,
	faGlobe,
	faMobileScreen,
	faRecordVinyl,
	faTablet,
	faUserGroup,
} from "@fortawesome/free-solid-svg-icons";
import {
	FontAwesomeIcon,
	type FontAwesomeIconProps,
} from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import getUnicodeFlagIcon from "country-flag-icons/unicode";
import Image from "next/image";
import CapIcon from "../../_components/AnimatedIcons/Cap";

const countryCodeToIcon = (countryCode: string) => {
	return getUnicodeFlagIcon(countryCode.toUpperCase());
};

export default function OtherStats() {
	return (
		<div className="grid grid-cols-1 gap-8 w-full xl:grid-cols-4">
			<OtherStatBox className="col-span-2" title="Geography" icon={faGlobe}>
				<div className="flex flex-col flex-1 gap-5 justify-center w-full">
					<TableCard
						title="Countries"
						columns={["Country", "Views", "Percentage"]}
						rows={[
							{
								icon: countryCodeToIcon("US"),
								name: "United States",
								views: "8,452",
								percentage: "34.2%",
							},
							{
								icon: countryCodeToIcon("GB"),
								name: "United Kingdom",
								views: "3,891",
								percentage: "15.7%",
							},
							{
								icon: countryCodeToIcon("CA"),
								name: "Canada",
								views: "2,764",
								percentage: "11.2%",
							},
							{
								icon: countryCodeToIcon("DE"),
								name: "Germany",
								views: "2,143",
								percentage: "8.7%",
							},
							{
								icon: countryCodeToIcon("FR"),
								name: "France",
								views: "1,876",
								percentage: "7.6%",
							},
							{
								icon: countryCodeToIcon("AU"),
								name: "Australia",
								views: "1,542",
								percentage: "6.2%",
							},
							{
								icon: countryCodeToIcon("JP"),
								name: "Japan",
								views: "1,298",
								percentage: "5.2%",
							},
							{
								icon: countryCodeToIcon("BR"),
								name: "Brazil",
								views: "987",
								percentage: "4.0%",
							},
						]}
					/>
					<TableCard
						title="Cities"
						columns={["City", "Views", "Percentage"]}
						rows={[
							{
								name: "New York",
								icon: countryCodeToIcon("US"),
								views: "3,421",
								percentage: "18.7%",
							},
							{
								name: "Los Angeles",
								icon: countryCodeToIcon("US"),
								views: "2,876",
								percentage: "15.7%",
							},
							{
								name: "London",
								icon: countryCodeToIcon("GB"),
								views: "2,145",
								percentage: "11.7%",
							},
							{
								name: "Toronto",
								icon: countryCodeToIcon("CA"),
								views: "1,892",
								percentage: "10.3%",
							},
							{
								name: "San Francisco",
								icon: countryCodeToIcon("US"),
								views: "1,654",
								percentage: "9.0%",
							},
							{
								name: "Chicago",
								icon: countryCodeToIcon("US"),
								views: "1,432",
								percentage: "7.8%",
							},
							{
								name: "Berlin",
								icon: countryCodeToIcon("DE"),
								views: "1,198",
								percentage: "6.5%",
							},
							{
								name: "Seattle",
								icon: countryCodeToIcon("US"),
								views: "987",
								percentage: "5.4%",
							},
							{
								name: "Sydney",
								icon: countryCodeToIcon("AU"),
								views: "876",
								percentage: "4.8%",
							},
							{
								name: "Paris",
								icon: countryCodeToIcon("FR"),
								views: "743",
								percentage: "4.1%",
							},
							{
								name: "Boston",
								icon: countryCodeToIcon("US"),
								views: "621",
								percentage: "3.4%",
							},
						]}
					/>
				</div>
			</OtherStatBox>
			<OtherStatBox className="col-span-2" title="Software" icon={faDesktop}>
				<div className="flex flex-col flex-1 gap-5 justify-center w-full">
					<TableCard
						title="Browsers"
						columns={["Browser", "Views", "Percentage"]}
						rows={[
							{
								icon: <BrowserIcon browser="google-chrome" />,
								name: "Chrome",
								views: "12,456",
								percentage: "42.3%",
							},
							{
								icon: <BrowserIcon browser="safari" />,
								name: "Safari",
								views: "6,234",
								percentage: "21.2%",
							},
							{
								icon: <BrowserIcon browser="firefox" />,
								name: "Firefox",
								views: "4,187",
								percentage: "14.2%",
							},
							{
								icon: <BrowserIcon browser="explorer" />,
								name: "Edge",
								views: "3,542",
								percentage: "12.0%",
							},
							{
								icon: <BrowserIcon browser="brave" />,
								name: "Brave",
								views: "1,876",
								percentage: "6.4%",
							},
							{
								icon: <BrowserIcon browser="opera" />,
								name: "Opera",
								views: "654",
								percentage: "2.2%",
							},
							{
								icon: <BrowserIcon browser="vivaldi" />,
								name: "Vivaldi",
								views: "298",
								percentage: "1.0%",
							},
							{
								icon: <BrowserIcon browser="yandex" />,
								name: "Yandex",
								views: "143",
								percentage: "0.5%",
							},
							{
								icon: <BrowserIcon browser="duckduckgo" />,
								name: "DuckDuckGo",
								views: "67",
								percentage: "0.2%",
							},
						]}
					/>
					<TableCard
						title="Operating Systems"
						columns={["Operating System", "Views", "Percentage"]}
						rows={[
							{
								icon: <OperatingSystemIcon operatingSystem="windows" />,
								name: "Windows",
								views: "9,876",
								percentage: "38.7%",
							},
							{
								icon: <OperatingSystemIcon operatingSystem="ios" />,
								name: "macOS",
								views: "7,432",
								percentage: "29.1%",
							},
							{
								icon: <OperatingSystemIcon operatingSystem="linux" />,
								name: "Linux",
								views: "3,654",
								percentage: "14.3%",
							},
							{
								icon: <OperatingSystemIcon operatingSystem="ubuntu" />,
								name: "Ubuntu",
								views: "2,187",
								percentage: "8.6%",
							},
							{
								icon: <OperatingSystemIcon operatingSystem="fedora" />,
								name: "Fedora",
								views: "1,243",
								percentage: "4.9%",
							},
						]}
					/>
				</div>
			</OtherStatBox>
			<OtherStatBox
				className="col-span-2"
				title="Devices"
				icon={faMobileScreen}
			>
				<div className="flex flex-col flex-1 gap-5 justify-center w-full">
					<TableCard
						title="Device Type"
						columns={["Device", "Views", "Percentage"]}
						rows={[
							{
								icon: (
									<FontAwesomeIcon icon={faDesktop} className="text-gray-12" />
								),
								name: "Desktop",
								views: "2,456",
								percentage: "45.6%",
							},
							{
								icon: (
									<FontAwesomeIcon icon={faTablet} className="text-gray-12" />
								),
								name: "Tablet",
								views: "1,234",
								percentage: "23.4%",
							},
							{
								icon: (
									<FontAwesomeIcon
										icon={faMobileScreen}
										className="text-gray-12"
									/>
								),
								name: "Mobile",
								views: "1,789",
								percentage: "30.9%",
							},
						]}
					/>
				</div>
			</OtherStatBox>
			<OtherStatBox
				className="col-span-2"
				title="Top Caps"
				icon={faRecordVinyl}
			>
				<div className="flex flex-col flex-1 gap-5 justify-center w-full">
					<TableCard
						title="Caps"
						columns={["Cap", "Views", "Percentage"]}
						rows={[
							{
								name: "Product Demo - Q4 2024",
								views: "5,842",
								icon: <LogoBadge className="size-4" />,
								percentage: "28.3%",
							},
							{
								name: "Tutorial: Getting Started",
								views: "4,156",
								icon: <LogoBadge className="size-4" />,
								percentage: "20.1%",
							},
							{
								name: "Team Meeting Highlights",
								views: "3,421",
								icon: <LogoBadge className="size-4" />,
								percentage: "16.6%",
							},
							{
								name: "Bug Fix Walkthrough",
								views: "2,789",
								icon: <LogoBadge className="size-4" />,
								percentage: "13.5%",
							},
							{
								name: "Feature Announcement",
								views: "1,923",
								icon: <LogoBadge className="size-4" />,
								percentage: "9.3%",
							},
							{
								name: "Customer Feedback Review",
								views: "1,245",
								icon: <LogoBadge className="size-4" />,
								percentage: "6.0%",
							},
							{
								name: "Sprint Retrospective",
								views: "876",
								icon: <LogoBadge className="size-4" />,
								percentage: "4.2%",
							},
							{
								name: "Design System Update",
								views: "543",
								icon: <LogoBadge className="size-4" />,
								percentage: "2.6%",
							},
							{
								name: "API Documentation Demo",
								views: "289",
								icon: <LogoBadge className="size-4" />,
								percentage: "1.4%",
							},
						]}
					/>
				</div>
			</OtherStatBox>
		</div>
	);
}

interface OtherStatBoxProps {
	title: string;
	icon: FontAwesomeIconProps["icon"];
	children: React.ReactNode;
	className?: string;
}

const OtherStatBox = ({
	title,
	icon,
	children,
	className,
}: OtherStatBoxProps) => {
	return (
		<div
			className={clsx(
				className,
				"p-6 space-y-6 w-full rounded-xl border bg-gray-1 border-gray-3 h-fit",
			)}
		>
			<div className="flex gap-2 items-center">
				<FontAwesomeIcon icon={icon} className="size-4 text-gray-10" />
				<p className="text-xl font-medium text-gray-12">{title}</p>
			</div>
			{children}
		</div>
	);
};

interface TableCardProps {
	title: string;
	columns: string[];
	tableClassname?: string;
	rows: {
		icon?: string | React.ReactNode;
		name: string;
		views: string;
		comments?: string;
		reactions?: string;
		percentage?: string;
	}[];
}

const TableCard = ({
	title,
	columns,
	rows,
	tableClassname,
}: TableCardProps) => {
	return (
		<div className="p-5 w-full rounded-xl border bg-gray-2 border-gray-4">
			<p className="text-lg font-medium text-gray-12">{title}</p>
			<Table
				className={clsx(
					"block pr-2 w-full border-separate border-spacing-y-2 h-[400px] custom-scroll",
					tableClassname,
				)}
			>
				<TableHeader>
					<TableRow>
						{columns.map((column) => (
							<TableHead
								key={column}
								className="sticky top-0 border-b text-nowrap border-gray-4 bg-gray-2 text-gray-10"
							>
								{column}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody className="before:content-[''] before:block before:h-2 w-full">
					{rows.map((row) => (
						<TableRow className="cursor-pointer group" key={row.name}>
							<TableCell className="flex gap-2 items-center group-hover:bg-gray-6 group-hover:border-gray-8 transition-colors duration-200 w-full p-2.5 text-sm rounded-l-lg border-l border-y text-gray-11 bg-gray-3 border-gray-5">
								<span className="flex-shrink-0 fill-[var(--gray-12)]">
									{row.icon}
								</span>
								<span className="truncate text-nowrap max-w-[200px]">
									{row.name}
								</span>
							</TableCell>

							<TableCell className="p-2.5 text-sm w-full text-gray-11 bg-gray-3 border-y border-gray-5 group-hover:bg-gray-6 group-hover:border-gray-8 transition-colors duration-200">
								{row.views}
							</TableCell>
							<TableCell className="p-2.5 text-sm rounded-r-lg border-r w-full text-gray-11 bg-gray-3 border-y border-gray-5 group-hover:bg-gray-6 group-hover:border-gray-8 transition-colors duration-200">
								{row.percentage}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
};

type OperatingSystemIconProps = {
	operatingSystem: "windows" | "ios" | "linux" | "fedora" | "ubuntu";
};

const OperatingSystemIcon = ({ operatingSystem }: OperatingSystemIconProps) => {
	if (operatingSystem === "ios") {
		return <FontAwesomeIcon className="text-gray-12" icon={faAppleWhole} />;
	} else {
		return (
			<Image
				src={`/logos/os/${operatingSystem}.svg`}
				alt={operatingSystem}
				width={16}
				height={16}
				className="size-4"
			/>
		);
	}
};

type BrowserIconProps = {
	browser:
		| "google-chrome"
		| "firefox"
		| "safari"
		| "explorer"
		| "opera"
		| "brave"
		| "vivaldi"
		| "yandex"
		| "duckduckgo"
		| "internet-explorer"
		| "samsung-internet"
		| "uc-browser"
		| "qq-browser"
		| "maxthon"
		| "arora"
		| "lunascape"
		| "lunascape";
};

const BrowserIcon = ({ browser }: BrowserIconProps) => {
	return (
		<Image
			src={`/logos/browsers/${browser}.svg`}
			alt={browser}
			width={16}
			height={16}
			className="size-4"
		/>
	);
};
