import Header from "../../components/Header";
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
		</div>
	);
}
