"use client";

import {
	faDesktop,
	faGlobe,
	faMobileScreen,
	faRecordVinyl,
} from "@fortawesome/free-solid-svg-icons";
import OtherStatBox from "./OtherStatBox";
import type { BreakdownRow } from "../types";
import TableCard, {
	BrowserRowData,
	CapRowData,
	CityRowData,
	CountryRowData,
	DeviceRowData,
	OSRowData,
} from "./TableCard";

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

const deviceMap: Record<string, DeviceRowData["device"]> = {
	desktop: "desktop",
	mobile: "mobile",
	tablet: "tablet",
};

const toCountryRow = (row: BreakdownRow): CountryRowData => ({
	countryCode: row.name,
	name: row.name,
	views: row.views,
	comments: null,
	reactions: null,
	percentage: row.percentage,
});

const toCityRow = (row: BreakdownRow): CityRowData => ({
	countryCode: row.subtitle || "",
	name: row.subtitle ? `${row.name}, ${row.subtitle}` : row.name,
	views: row.views,
	comments: null,
	reactions: null,
	percentage: row.percentage,
});

const toBrowserRow = (row: BreakdownRow): BrowserRowData => ({
	browser: browserNameToSlug(row.name),
	name: row.name,
	views: row.views,
	comments: null,
	reactions: null,
	percentage: row.percentage,
});

const toOSRow = (row: BreakdownRow): OSRowData => ({
	os: osNameToKey(row.name),
	name: row.name,
	views: row.views,
	comments: null,
	reactions: null,
	percentage: row.percentage,
});

const toCapRow = (row: BreakdownRow & { id?: string }): CapRowData => ({
	name: row.name,
	views: row.views,
	comments: null,
	reactions: null,
	percentage: row.percentage,
	id: row.id,
});

const browserNameToSlug = (name: string): BrowserRowData["browser"] => {
	switch (name.toLowerCase()) {
		case "chrome":
			return "google-chrome";
		case "firefox":
			return "firefox";
		case "safari":
			return "safari";
		case "edge":
		case "internet explorer":
			return "explorer";
		case "opera":
			return "opera";
		case "brave":
			return "brave";
		default:
			return "google-chrome";
	}
};

const osNameToKey = (name: string): OSRowData["os"] => {
	const normalized = name.toLowerCase().trim();
	if (normalized.includes("mac") || normalized === "ios") {
		return "ios";
	}
	switch (normalized) {
		case "linux":
			return "linux";
		case "ubuntu":
			return "ubuntu";
		case "fedora":
			return "fedora";
		default:
			return "windows";
	}
};

export default function OtherStats({ data, isLoading }: OtherStatsProps) {
	return (
		<div className="grid grid-cols-1 gap-8 w-full xl:grid-cols-4">
			<OtherStatBox className="col-span-2" title="Geography" icon={faGlobe}>
				<div className="flex flex-col flex-1 gap-5 justify-center w-full">
					<TableCard
						title="Countries"
						columns={[
							"Country",
							"Views",
							"Percentage",
						]}
						rows={data.countries.map(toCountryRow)}
						type="country"
						isLoading={isLoading}
					/>
					<TableCard
						title="Cities"
						columns={["City", "Views", "Percentage"]}
						rows={data.cities.map(toCityRow)}
						type="city"
						isLoading={isLoading}
					/>
				</div>
			</OtherStatBox>
			<OtherStatBox className="col-span-2" title="Software" icon={faDesktop}>
				<div className="flex flex-col flex-1 gap-5 justify-center w-full">
					<TableCard
						title="Browsers"
						columns={[
							"Browser",
							"Views",
							"Percentage",
						]}
						rows={data.browsers.map(toBrowserRow)}
						type="browser"
						isLoading={isLoading}
					/>
					<TableCard
						title="Operating Systems"
						columns={[
							"Operating System",
							"Views",
							"Percentage",
						]}
						rows={data.operatingSystems.map(toOSRow)}
						type="os"
						isLoading={isLoading}
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
						rows={data.deviceTypes.map((device) => ({
							device: deviceMap[device.name.toLowerCase()] ?? "desktop",
							name: device.name,
							views: device.views,
							comments: null,
							reactions: null,
							percentage: device.percentage,
						}))}
						type="device"
						isLoading={isLoading}
					/>
				</div>
			</OtherStatBox>
			{data.topCaps && data.topCaps.length > 0 && (
				<OtherStatBox
					className="col-span-2"
					title="Top Caps"
					icon={faRecordVinyl}
				>
					<div className="flex flex-col flex-1 gap-5 justify-center w-full">
						<TableCard
							title="Caps"
							columns={["Name", "Views", "Percentage"]}
							rows={data.topCaps.map(toCapRow)}
							type="cap"
							isLoading={isLoading}
						/>
					</div>
				</OtherStatBox>
			)}
		</div>
	);
} 
