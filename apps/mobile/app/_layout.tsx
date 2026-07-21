import "react-native-gesture-handler";
import "react-native-reanimated";

import { Stack, useSegments } from "expo-router";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	StatusBar,
	StyleSheet,
	View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "@/auth/AuthContext";
import { SignInPanel } from "@/auth/SignInPanel";
import { signInTitleForSegments } from "@/auth/signInDestination";
import { RecordingUploadStatus } from "@/components/recording-upload-status";
import { colors } from "@/theme";
import { RecordingUploadProvider } from "@/uploads/recording-upload-provider";

function AppShell() {
	const auth = useAuth();
	const segments = useSegments();

	if (auth.status === "loading") {
		return (
			<View style={styles.loadingScreen}>
				<ActivityIndicator color={colors.blue11} />
			</View>
		);
	}

	if (auth.status === "signedOut") {
		return (
			<SafeAreaView style={styles.authScreen}>
				<KeyboardAvoidingView
					behavior={Platform.OS === "ios" ? "padding" : undefined}
					style={styles.authKeyboard}
				>
					<ScrollView
						keyboardShouldPersistTaps="handled"
						contentContainerStyle={styles.authContent}
						style={styles.authScroll}
					>
						<SignInPanel title={signInTitleForSegments(segments)} />
					</ScrollView>
				</KeyboardAvoidingView>
			</SafeAreaView>
		);
	}

	return (
		<Stack screenOptions={{ headerShown: false }}>
			<Stack.Screen name="(tabs)" />
			<Stack.Screen name="caps/[id]" />
		</Stack>
	);
}

export default function RootLayout() {
	return (
		<GestureHandlerRootView
			style={{ flex: 1, backgroundColor: colors.appBackground }}
		>
			<SafeAreaProvider>
				<AuthProvider>
					<RecordingUploadProvider>
						<StatusBar
							backgroundColor={colors.appBackground}
							barStyle="dark-content"
						/>
						<AppShell />
						<RecordingUploadStatus />
					</RecordingUploadProvider>
				</AuthProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}

const styles = StyleSheet.create({
	loadingScreen: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.appBackground,
	},
	authScreen: {
		flex: 1,
		backgroundColor: colors.appBackground,
	},
	authKeyboard: {
		flex: 1,
	},
	authScroll: {
		flex: 1,
	},
	authContent: {
		flexGrow: 1,
		justifyContent: "center",
		paddingHorizontal: 20,
		paddingVertical: 28,
	},
});
