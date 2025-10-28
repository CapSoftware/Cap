"use client";

import {
	faDesktop,
	faGlobe,
	faMobileScreen,
	faRecordVinyl,
} from "@fortawesome/free-solid-svg-icons";
import OtherStatBox from "./OtherStatBox";
import type {
	BrowserRowData,
	CapRowData,
	CityRowData,
	CountryRowData,
	DeviceRowData,
	OSRowData,
} from "./TableCard";
import TableCard from "./TableCard";

export interface OtherStatsData {
	countries: CountryRowData[];
	cities: CityRowData[];
	browsers: BrowserRowData[];
	operatingSystems: OSRowData[];
	deviceTypes: DeviceRowData[];
	topCaps: CapRowData[];
}

interface OtherStatsProps {
	data: OtherStatsData;
}

export default function OtherStats({ data }: OtherStatsProps) {
	return (
		<div className="grid grid-cols-1 gap-8 w-full xl:grid-cols-4">
			<OtherStatBox className="col-span-2" title="Geography" icon={faGlobe}>
				<div className="flex flex-col flex-1 gap-5 justify-center w-full">
					<TableCard
						title="Countries"
						columns={[
							"Country",
							"Views",
							"Comments",
							"Reactions",
							"Percentage",
						]}
						rows={data.countries}
						type="country"
					/>
					<TableCard
						title="Cities"
						columns={["City", "Views", "Comments", "Reactions", "Percentage"]}
						rows={data.cities}
						type="city"
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
							"Comments",
							"Reactions",
							"Percentage",
						]}
						rows={data.browsers}
						type="browser"
					/>
					<TableCard
						title="Operating Systems"
						columns={[
							"Operating System",
							"Views",
							"Comments",
							"Reactions",
							"Percentage",
						]}
						rows={data.operatingSystems}
						type="os"
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
						columns={["Device", "Views", "Comments", "Reactions", "Percentage"]}
						rows={data.deviceTypes}
						type="device"
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
						columns={["Cap", "Views", "Comments", "Reactions", "Percentage"]}
						rows={data.topCaps}
						type="cap"
					/>
				</div>
			</OtherStatBox>
		</div>
	);
}
