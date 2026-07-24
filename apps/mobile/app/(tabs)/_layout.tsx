import { Tabs } from "expo-router";
import { TabBar } from "@/components/TabBar";

export default function TabsLayout() {
	return (
		<Tabs
			screenOptions={{ headerShown: false }}
			tabBar={(props) => (
				<TabBar
					activeRouteName={
						props.state.routes[props.state.index]?.name ?? "index"
					}
					onSelect={(routeName) => {
						props.navigation.navigate(routeName);
					}}
				/>
			)}
		>
			<Tabs.Screen name="index" options={{ title: "My Caps" }} />
			<Tabs.Screen name="upload" options={{ href: null }} />
			<Tabs.Screen name="account" options={{ title: "Account" }} />
		</Tabs>
	);
}
