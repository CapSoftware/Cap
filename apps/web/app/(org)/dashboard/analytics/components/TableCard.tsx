import {
	LogoBadge,
	Select,
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
	faMobileScreen,
	faFilter,
	faTablet,
	faDownLong,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import getUnicodeFlagIcon from "country-flag-icons/unicode";
import Image from "next/image";

const countryCodeToIcon = (countryCode: string) => {
	return getUnicodeFlagIcon(countryCode.toUpperCase());
};

type BrowserType =
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
	| "lunascape";

type OperatingSystemType = "windows" | "ios" | "linux" | "fedora" | "ubuntu";

type DeviceType = "desktop" | "tablet" | "mobile";

export interface CountryRowData {
	countryCode: string;
	name: string;
	views: string;
	comments: string;
	reactions: string;
	percentage: string;
}

export interface CityRowData {
	countryCode: string;
	name: string;
	views: string;
	comments: string;
	reactions: string;
	percentage: string;
}

export interface BrowserRowData {
	browser: BrowserType;
	name: string;
	views: string;
	comments: string;
	reactions: string;
	percentage: string;
}

export interface OSRowData {
	os: OperatingSystemType;
	name: string;
	views: string;
	comments: string;
	reactions: string;
	percentage: string;
}

export interface DeviceRowData {
	device: DeviceType;
	name: string;
	views: string;
	comments: string;
	reactions: string;
	percentage: string;
}

export interface CapRowData {
	name: string;
	views: string;
	comments: string;
	reactions: string;
	percentage: string;
}

export interface TableCardProps {
	title: string;
	columns: string[];
	tableClassname?: string;
	type: "country" | "city" | "browser" | "os" | "device" | "cap";
	rows:
		| CountryRowData[]
		| CityRowData[]
		| BrowserRowData[]
		| OSRowData[]
		| DeviceRowData[]
		| CapRowData[];
}

const TableCard = ({
	title,
	columns,
	rows,
	type,
	tableClassname,
}: TableCardProps) => {
	return (
		<div className="p-5 w-full rounded-xl border bg-gray-2 border-gray-4">
			<div className="flex flex-1 gap-2 justify-between items-center h-[48px]">
				<p className="text-lg font-medium text-gray-12">{title}</p>
				<Select
					variant="light"
					icon={<FontAwesomeIcon icon={faFilter} />}
					size="md"
					options={[
						{ label: "Views", value: "views_desc" },
						{ label: "Comments", value: "comments_desc" },
						{ label: "Reactions", value: "reactions_desc" },
						{ label: "Percentage", value: "percentage_desc" },
					]}
					onValueChange={() => {}}
					placeholder="Sort by"
				/>
			</div>
			<div className="w-full">
				<Table
					className={clsx(
						"w-full border-separate table-fixed border-spacing-y-0",
						tableClassname,
					)}
				>
					<TableHeader>
						<TableRow className="w-full">
							{columns.map((column) => (
								<TableHead
									key={column}
									className="border-b px-[6px] text-nowrap border-gray-4 bg-gray-2 text-gray-10"
								>
									{column}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
				</Table>
				<div className="h-[400px] overflow-auto custom-scroll pr-2">
					<Table
						className={clsx(
							"w-full border-separate table-fixed border-spacing-y-2",
							tableClassname,
						)}
					>
						<TableBody className="before:content-[''] before:block w-full">
							{rows.map((row) => (
								<TableRow className="w-full" key={row.name}>
									<TableCell className="p-2.5 text-sm rounded-l-lg border-l border-y text-gray-11 bg-gray-3 border-gray-5">
										<div className="flex gap-2 items-center min-w-0">
											<span className="flex-shrink-0 fill-[var(--gray-12)]">
												{getIconForRow(row, type)}
											</span>
											<span className="truncate">{row.name}</span>
										</div>
									</TableCell>
									<TableCell className="py-2.5 px-3 text-sm text-nowrap text-gray-11 bg-gray-3 border-y border-gray-5 whitespace-nowrap">
										{row.views}
									</TableCell>
									<TableCell className="p-2.5 px-3 text-sm text-nowrap text-gray-11 bg-gray-3 border-y border-gray-5 whitespace-nowrap">
										{row.comments}
									</TableCell>
									<TableCell className="p-2.5 px-3 text-sm text-nowrap text-gray-11 bg-gray-3 border-y border-gray-5 whitespace-nowrap">
										{row.reactions}
									</TableCell>
									<TableCell className="p-2.5 px-3 text-sm text-nowrap rounded-r-lg border-r text-gray-11 bg-gray-3 border-y border-gray-5 whitespace-nowrap">
										{row.percentage}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</div>
		</div>
	);
};

const getIconForRow = (
	row:
		| CountryRowData
		| CityRowData
		| BrowserRowData
		| OSRowData
		| DeviceRowData
		| CapRowData,
	type: TableCardProps["type"],
) => {
	switch (type) {
		case "country":
			return countryCodeToIcon((row as CountryRowData).countryCode);
		case "city":
			return countryCodeToIcon((row as CityRowData).countryCode);
		case "browser":
			return <BrowserIcon browser={(row as BrowserRowData).browser} />;
		case "os":
			return <OperatingSystemIcon operatingSystem={(row as OSRowData).os} />;
		case "device": {
			const device = (row as DeviceRowData).device;
			const iconMap = {
				desktop: faDesktop,
				tablet: faTablet,
				mobile: faMobileScreen,
			};
			return (
				<FontAwesomeIcon icon={iconMap[device]} className="text-gray-12" />
			);
		}
		case "cap":
			return <LogoBadge className="size-4" />;
		default:
			return null;
	}
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

export default TableCard;
