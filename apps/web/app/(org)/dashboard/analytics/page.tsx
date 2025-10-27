import Header from "./components/Header";
import OtherStats from "./components/OtherStats";
import StatsChart from "./components/StatsChart";

export default function AnalyticsPage() {
	return (
		<div className="space-y-8">
			<Header />
			<StatsChart />
			<OtherStats />
		</div>
	);
}
