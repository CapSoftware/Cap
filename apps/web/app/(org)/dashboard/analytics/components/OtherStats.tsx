"use client";

import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@cap/ui";
import {
	faAppleWhole,
	faDesktop,
	faGlobe,
	faMobileScreen,
	faTablet,
} from "@fortawesome/free-solid-svg-icons";
import {
	FontAwesomeIcon,
	type FontAwesomeIconProps,
} from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import getUnicodeFlagIcon from "country-flag-icons/unicode";
import Image from "next/image";

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
								views: "1,234",
								percentage: "45.6%",
							},
							{
								icon: countryCodeToIcon("GB"),
								name: "United Kingdom",
								views: "892",
								percentage: "23.4%",
							},
							{
								icon: countryCodeToIcon("CA"),
								name: "Canada",
								views: "567",
								percentage: "30.9%",
							},
							{
								icon: countryCodeToIcon("DE"),
								name: "Germany",
								views: "432",
								percentage: "15.6%",
							},
							{
								icon: countryCodeToIcon("FR"),
								name: "France",
								views: "389",
								percentage: "10.9%",
							},
							{
								icon: countryCodeToIcon("AU"),
								name: "Australia",
								views: "276",
								percentage: "10.9%",
							},
							{
								icon: countryCodeToIcon("JP"),
								name: "Japan",
								views: "198",
								percentage: "10.9%",
							},
							{
								icon: countryCodeToIcon("BR"),
								name: "Brazil",
								views: "156",
								percentage: "10.9%",
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
								views: "1,234",
								percentage: "45.6%",
							},
							{
								name: "Los Angeles",
								icon: countryCodeToIcon("US"),
								views: "892",
								percentage: "23.4%",
							},
							{
								name: "Chicago",
								icon: countryCodeToIcon("US"),
								views: "567",
								percentage: "30.9%",
							},
							{
								name: "Houston",
								icon: countryCodeToIcon("US"),
								views: "432",
								percentage: "15.6%",
							},
							{
								name: "Miami",
								icon: countryCodeToIcon("US"),
								views: "389",
								percentage: "10.9%",
							},
							{
								name: "San Francisco",
								icon: countryCodeToIcon("US"),
								views: "389",
								percentage: "10.9%",
							},
							{
								name: "Seattle",
								icon: countryCodeToIcon("US"),
								views: "389",
								percentage: "10.9%",
							},
							{
								name: "Boston",
								icon: countryCodeToIcon("US"),
								views: "389",
								percentage: "10.9%",
							},
							{
								name: "Washington, D.C. asd asd asdsa d",
								icon: countryCodeToIcon("US"),
								views: "1,000",
								percentage: "10.9%",
							},
							{
								name: "Atlanta",
								icon: countryCodeToIcon("US"),
								views: "1,000",
								percentage: "10.9%",
							},
							{
								name: "Denver",
								icon: countryCodeToIcon("US"),
								views: "1,000",
								percentage: "10.9%",
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
								percentage: "45.6%",
								views: "1,234",
							},
							{
								icon: <BrowserIcon browser="firefox" />,
								name: "Firefox",
								percentage: "23.4%",
								views: "892",
							},
							{
								icon: <BrowserIcon browser="safari" />,
								name: "Safari",
								percentage: "30.9%",
								views: "567",
							},
							{
								icon: <BrowserIcon browser="explorer" />,
								name: "Edge",
								percentage: "15.6%",
								views: "432",
							},
							{
								icon: <BrowserIcon browser="opera" />,
								name: "Opera",
								percentage: "10.9%",
								views: "432",
							},
							{
								icon: <BrowserIcon browser="brave" />,
								name: "Brave",
								percentage: "5.6%",
								views: "432",
							},
							{
								icon: <BrowserIcon browser="vivaldi" />,
								name: "Vivaldi",
								percentage: "3.4%",
								views: "432",
							},
							{
								icon: <BrowserIcon browser="yandex" />,
								name: "Yandex",
								percentage: "2.9%",
								views: "432",
							},
							{
								icon: <BrowserIcon browser="duckduckgo" />,
								name: "DuckDuckGo",
								percentage: "1.6%",
								views: "432",
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
								views: "1,234",
								percentage: "45.6%",
							},
							{
								icon: <OperatingSystemIcon operatingSystem="ios" />,
								name: "iOS",
								views: "892",
								percentage: "23.4%",
							},
							{
								icon: <OperatingSystemIcon operatingSystem="linux" />,
								name: "Linux",
								views: "892",
								percentage: "15.6%",
							},
							{
								icon: <OperatingSystemIcon operatingSystem="fedora" />,
								name: "Fedora",
								views: "892",
								percentage: "10.9%",
							},
							{
								icon: <OperatingSystemIcon operatingSystem="ubuntu" />,
								name: "Ubuntu",
								views: "892",
								percentage: "10.9%",
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
						tableClassname="h-fit"
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
								<span className="truncate text-nowrap max-w-[100px]">
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
