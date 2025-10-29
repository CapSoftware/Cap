import Header from "../../components/Header";
import OtherStats, { type OtherStatsData } from "../../components/OtherStats";
import StatsChart from "../../components/StatsChart";

export default function AnalyticsPage() {
	return (
		<div className="space-y-8">
			<Header />
			<StatsChart
				counts={{
					views: "2,768",
					chats: "100",
					reactions: "100",
				}}
				defaultSelectedBox="views"
			/>
			<OtherStats data={mockData} />
		</div>
	);
}

const mockData: OtherStatsData = {
	countries: [
		{
			countryCode: "US",
			name: "United States",
			views: "8,452",
			comments: "100",
			reactions: "100",
			percentage: "34.2%",
		},
		{
			countryCode: "GB",
			name: "United Kingdom",
			views: "3,891",
			comments: "100",
			reactions: "100",
			percentage: "15.7%",
		},
		{
			countryCode: "CA",
			name: "Canada",
			views: "2,764",
			comments: "100",
			reactions: "100",
			percentage: "11.2%",
		},
		{
			countryCode: "DE",
			name: "Germany",
			views: "2,143",
			comments: "100",
			reactions: "100",
			percentage: "8.7%",
		},
		{
			countryCode: "FR",
			name: "France",
			views: "1,876",
			comments: "100",
			reactions: "100",
			percentage: "7.6%",
		},
		{
			countryCode: "AU",
			name: "Australia",
			views: "1,542",
			comments: "100",
			reactions: "100",
			percentage: "6.2%",
		},
	],
	cities: [
		{
			countryCode: "US",
			name: "New York",
			views: "3,421",
			comments: "100",
			reactions: "100",
			percentage: "18.7%",
		},
		{
			countryCode: "US",
			name: "Los Angeles",
			views: "2,876",
			comments: "100",
			reactions: "100",
			percentage: "15.7%",
		},
		{
			countryCode: "GB",
			name: "London",
			views: "2,145",
			comments: "100",
			reactions: "100",
			percentage: "11.7%",
		},
		{
			countryCode: "CA",
			name: "Toronto",
			views: "1,892",
			comments: "100",
			reactions: "100",
			percentage: "10.3%",
		},
	],
	browsers: [
		{
			browser: "google-chrome",
			name: "Chrome",
			views: "8,452",
			comments: "100",
			reactions: "100",
			percentage: "34.2%",
		},
	],
	operatingSystems: [
		{
			os: "windows",
			name: "Windows",
			views: "8,452",
			comments: "100",
			reactions: "100",
			percentage: "34.2%",
		},
	],
	deviceTypes: [
		{
			device: "desktop",
			name: "Desktop",
			views: "8,452",
			comments: "100",
			reactions: "100",
			percentage: "34.2%",
		},
	],
};
