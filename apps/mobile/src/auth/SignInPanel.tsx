import { SymbolView } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { MobileApiError } from "@/api/mobile";
import { ActionButton } from "@/components/ActionButton";
import { CapLogoBadge } from "@/components/CapLogoBadge";
import { GlassSurface } from "@/components/GlassSurface";
import { colors, fonts, radius, squircle } from "@/theme";
import { apiBaseUrl, useAuth } from "./AuthContext";

type SignInPanelProps = {
	title?: string;
	subtitle?: string;
};

const codePattern = /^\d{6}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailCodeCooldownMs = 30_000;
const codeSlots = ["code-0", "code-1", "code-2", "code-3", "code-4", "code-5"];
type FocusedInput = "code" | "email" | "sso" | null;
type LoadingKind = "email" | "code" | "google" | "sso";
type SignInError = {
	message: string;
	source: LoadingKind | "resend";
};

const getEmailRequestErrorMessage = (error: unknown) => {
	if (error instanceof MobileApiError) {
		if (error.status === 400) return "Enter a valid email address.";
		if (error.status === 403) {
			return "This email cannot be used to sign in to Cap.";
		}
	}
	return error instanceof Error
		? error.message
		: "Unable to send a code. Try again.";
};

const getCodeVerificationErrorMessage = (error: unknown) => {
	if (error instanceof MobileApiError) {
		if (error.status === 400) return "Enter a valid email and 6-digit code.";
		if (error.status === 403) return "That code is invalid or expired.";
	}
	return error instanceof Error ? error.message : "Unable to verify that code.";
};

const getProviderErrorMessage = (error: unknown, fallback: string) => {
	return error instanceof Error ? error.message : fallback;
};

const openWebPath = (path: string) => {
	void WebBrowser.openBrowserAsync(new URL(path, apiBaseUrl).toString());
};

function GoogleMark() {
	return (
		<Svg width={16} height={16} viewBox="-3 0 262 262">
			<Path
				d="M255.878 133.451c0-10.734-.871-18.567-2.756-26.69H130.55v48.448h71.947c-1.45 12.04-9.283 30.172-26.69 42.356l-.244 1.622 38.755 30.023 2.685.268c24.659-22.774 38.875-56.282 38.875-96.027"
				fill="#4285F4"
			/>
			<Path
				d="M130.55 261.1c35.248 0 64.839-11.605 86.453-31.622l-41.196-31.913c-11.024 7.688-25.82 13.055-45.257 13.055-34.523 0-63.824-22.773-74.269-54.25l-1.531.13-40.298 31.187-.527 1.465C35.393 231.798 79.49 261.1 130.55 261.1"
				fill="#34A853"
			/>
			<Path
				d="M56.281 156.37c-2.756-8.123-4.351-16.827-4.351-25.82 0-8.994 1.595-17.697 4.206-25.82l-.073-1.73L15.26 71.312l-1.335.635C5.077 89.644 0 109.517 0 130.55s5.077 40.905 13.925 58.602l42.356-32.782"
				fill="#FBBC05"
			/>
			<Path
				d="M130.55 50.479c24.514 0 41.05 10.589 50.479 19.438l36.844-35.974C195.245 12.91 165.798 0 130.55 0 79.49 0 35.393 29.301 13.925 71.947l42.211 32.783c10.59-31.477 39.891-54.251 74.414-54.251"
				fill="#EB4335"
			/>
		</Svg>
	);
}

export function SignInPanel({
	title = "Sign in to Cap",
	subtitle = "Your videos, organized and ready to share.",
}: SignInPanelProps) {
	const auth = useAuth();
	const codeInputRef = useRef<TextInput>(null);
	const loadingRef = useRef(false);
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [organizationId, setOrganizationId] = useState("");
	const [codeSent, setCodeSent] = useState(false);
	const [lastCodeRequestedAt, setLastCodeRequestedAt] = useState<number | null>(
		null,
	);
	const [lastCodeRequestedEmail, setLastCodeRequestedEmail] = useState<
		string | null
	>(null);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [showSso, setShowSso] = useState(false);
	const [focusedInput, setFocusedInput] = useState<FocusedInput>(null);
	const [loading, setLoading] = useState<LoadingKind | null>(null);
	const [error, setError] = useState<SignInError | null>(null);

	const normalizedEmail = email.trim().toLowerCase();
	const normalizedOrganizationId = organizationId.trim();
	const cooldownEndsAt =
		lastCodeRequestedAt !== null && lastCodeRequestedEmail === normalizedEmail
			? lastCodeRequestedAt + emailCodeCooldownMs
			: null;
	const cooldownRemainingMs =
		cooldownEndsAt !== null ? Math.max(0, cooldownEndsAt - nowMs) : 0;
	const cooldownRemainingSeconds = Math.ceil(cooldownRemainingMs / 1000);
	const isCodeRequestCoolingDown = cooldownRemainingSeconds > 0;
	const isEmailReady = emailPattern.test(normalizedEmail);
	const isCodeReady = codePattern.test(code);
	const isSsoReady = normalizedOrganizationId.length > 0;
	const canRequestCode =
		isEmailReady && loading === null && !isCodeRequestCoolingDown;
	const canVerifyCode = isCodeReady && loading === null;
	const canStartSso = isSsoReady && loading === null;
	const isCodeStep = codeSent && !showSso;
	const showBackButton = showSso || isCodeStep;
	const showGoogle = auth.authConfig.googleAuthAvailable;
	const showSaml = auth.authConfig.workosAuthAvailable;
	const showProviderOptions = showGoogle || showSaml;
	const errorMessage = error?.message ?? null;
	const emailInputHasError =
		error?.source === "email" && !showSso && !isCodeStep;
	const ssoInputHasError = error?.source === "sso" && showSso;
	const codeEntryHasError = error?.source === "code" && isCodeStep;
	const googleActionHasError =
		error?.source === "google" && !showSso && !isCodeStep;
	const ssoActionHasError = error?.source === "sso" && showSso;
	const backDisabled = loading !== null;
	const codeEntryDisabled = loading !== null;
	const activeCodeSlotIndex = Math.min(code.length, codeSlots.length - 1);
	const linkDisabled = loading !== null;
	const resendDisabled = loading !== null || isCodeRequestCoolingDown;
	const headerTitle = isCodeStep ? "Enter verification code" : title;
	const headerSubtitle = isCodeStep
		? `We sent a 6-digit code to ${normalizedEmail}`
		: subtitle;
	const resendLabel = isCodeRequestCoolingDown
		? `Resend in ${cooldownRemainingSeconds}s`
		: "Didn't receive the code? Resend";
	const emailButtonLabel = "Login with email";
	const verifyButtonLabel = "Verify Code";
	const googleButtonLabel = googleActionHasError
		? "Retry Google"
		: "Login with Google";
	const ssoContinueButtonLabel = ssoActionHasError
		? "Retry SSO"
		: "Continue with SSO";
	const googleButtonAccessibilityLabel = googleActionHasError
		? "Retry Google sign in"
		: undefined;
	const ssoContinueButtonAccessibilityLabel = ssoActionHasError
		? "Retry SAML SSO sign in"
		: undefined;
	const activeSignInAccessibilityText =
		loading === "email"
			? "Sending verification code"
			: loading === "code"
				? "Verifying code"
				: loading === "google"
					? "Starting Google sign in"
					: loading === "sso"
						? "Starting SAML SSO sign in"
						: null;
	const activeSignInAccessibilityValue = activeSignInAccessibilityText
		? { text: activeSignInAccessibilityText }
		: undefined;
	const emailButtonAccessibilityValue =
		loading === "email"
			? activeSignInAccessibilityValue
			: emailInputHasError && errorMessage
				? { text: errorMessage }
				: normalizedEmail.length > 0 && !isEmailReady
					? { text: "Email address is not valid" }
					: loading !== null
						? activeSignInAccessibilityValue
						: undefined;
	const verifyButtonAccessibilityValue =
		loading === "code"
			? activeSignInAccessibilityValue
			: isCodeStep
				? { text: `${code.length} of 6 digits entered` }
				: undefined;
	const googleButtonAccessibilityValue =
		loading === "google"
			? activeSignInAccessibilityValue
			: googleActionHasError && errorMessage
				? { text: errorMessage }
				: loading !== null
					? activeSignInAccessibilityValue
					: undefined;
	const samlButtonAccessibilityValue =
		loading !== null ? activeSignInAccessibilityValue : undefined;
	const ssoContinueButtonAccessibilityValue =
		loading === "sso"
			? activeSignInAccessibilityValue
			: ssoActionHasError && errorMessage
				? { text: errorMessage }
				: normalizedOrganizationId.length > 0
					? undefined
					: { text: "Organization ID required" };
	const resendAccessibilityLabel =
		loading === "email" ? "Didn't receive the code? Resend" : resendLabel;
	const resendAccessibilityValue =
		loading === "email"
			? activeSignInAccessibilityValue
			: loading !== null
				? activeSignInAccessibilityValue
				: isCodeRequestCoolingDown
					? { text: `Wait ${cooldownRemainingSeconds} seconds` }
					: undefined;
	const codeEntryAccessibilityValue =
		loading === "code"
			? activeSignInAccessibilityValue
			: { text: `${code.length} of 6 digits entered` };
	const linkAccessibilityValue =
		loading !== null ? activeSignInAccessibilityValue : undefined;
	const emailInputAccessibilityValue =
		loading !== null ? activeSignInAccessibilityValue : undefined;
	const ssoInputAccessibilityValue =
		loading !== null
			? activeSignInAccessibilityValue
			: ssoInputHasError && errorMessage
				? { text: errorMessage }
				: undefined;
	const backButtonAccessibilityValue =
		loading !== null ? activeSignInAccessibilityValue : undefined;
	const resendHint =
		loading !== null
			? "Sign in is in progress"
			: isCodeRequestCoolingDown
				? `Wait ${cooldownRemainingSeconds} seconds before requesting a new code`
				: "Requests a new verification code";
	const emailButtonHint =
		loading === "email"
			? "Sending verification code"
			: loading !== null
				? "Sign in is in progress"
				: !isEmailReady
					? "Enter a valid email address to continue"
					: "Sends a verification code to this email";
	const verifyButtonHint =
		loading === "code"
			? "Verifying code"
			: loading !== null
				? "Sign in is in progress"
				: !isCodeReady
					? "Enter the 6-digit code to continue"
					: "Verifies the 6-digit code";
	const googleButtonHint =
		loading === "google"
			? "Google sign in is starting"
			: loading !== null
				? "Sign in is in progress"
				: googleActionHasError && errorMessage
					? errorMessage
					: "Starts Google sign in";
	const samlButtonHint =
		loading !== null
			? "Sign in is in progress"
			: "Shows the SSO organization step";
	const ssoButtonHint =
		loading === "sso"
			? "SAML SSO sign in is starting"
			: loading !== null
				? "Sign in is in progress"
				: ssoActionHasError && errorMessage
					? errorMessage
					: !isSsoReady
						? "Enter your organization ID to continue"
						: "Starts SAML SSO for this organization";
	const emailInputHint =
		emailInputHasError && errorMessage
			? errorMessage
			: "Enter your email to request a verification code";
	const ssoInputHint =
		ssoInputHasError && errorMessage
			? errorMessage
			: "Enter your organization ID to continue with SSO";
	const codeEntryHint =
		codeEntryHasError && errorMessage
			? errorMessage
			: loading === "code"
				? "Verifying code"
				: loading !== null
					? "Sign in is in progress"
					: "Tap to enter the 6-digit code";
	const signupLinkHint =
		loading !== null
			? "Sign in is in progress"
			: "Opens sign up in a browser sheet";
	const termsLinkHint =
		loading !== null
			? "Sign in is in progress"
			: "Opens Terms of Service in a browser sheet";
	const privacyLinkHint =
		loading !== null
			? "Sign in is in progress"
			: "Opens Privacy Policy in a browser sheet";
	const backButtonHint =
		loading !== null
			? "Sign in is in progress"
			: isCodeStep
				? "Returns to email sign in"
				: "Returns to sign in options";

	const beginLoading = (nextLoading: LoadingKind) => {
		if (loadingRef.current || loading !== null) return false;
		loadingRef.current = true;
		setLoading(nextLoading);
		return true;
	};

	const endLoading = () => {
		loadingRef.current = false;
		setLoading(null);
	};

	const isAuthBusy = () => loadingRef.current || loading !== null;

	useEffect(() => {
		if (!isCodeRequestCoolingDown) return;
		const interval = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(interval);
	}, [isCodeRequestCoolingDown]);

	const goBack = () => {
		if (isAuthBusy()) return;
		if (showSso) setShowSso(false);
		if (isCodeStep) {
			setCodeSent(false);
			setCode("");
		}
		setFocusedInput(null);
		setError(null);
	};

	const updateOrganizationId = (value: string) => {
		if (isAuthBusy()) return;
		setOrganizationId(value.trim());
		setError(null);
	};

	const updateEmail = (value: string) => {
		if (isAuthBusy()) return;
		setEmail(value.toLowerCase());
		setCodeSent(false);
		setCode("");
		setError(null);
	};

	const requestCode = async () => {
		if (!emailPattern.test(normalizedEmail)) return;
		if (isCodeRequestCoolingDown) {
			setError({
				message: `Please wait ${cooldownRemainingSeconds} seconds before requesting a new code.`,
				source: "resend",
			});
			return;
		}
		if (!beginLoading("email")) return;
		setError(null);
		try {
			await auth.requestEmailCode(normalizedEmail);
			const requestedAt = Date.now();
			setEmail(normalizedEmail);
			setCode("");
			setCodeSent(true);
			setLastCodeRequestedAt(requestedAt);
			setLastCodeRequestedEmail(normalizedEmail);
			setNowMs(requestedAt);
		} catch (requestError) {
			setError({
				message: getEmailRequestErrorMessage(requestError),
				source: "email",
			});
		} finally {
			endLoading();
		}
	};

	const verifyCode = async (codeToVerify = code) => {
		if (!codePattern.test(codeToVerify)) return;
		if (!beginLoading("code")) return;
		setError(null);
		try {
			await auth.verifyEmailCode(normalizedEmail, codeToVerify);
		} catch (verifyError) {
			setError({
				message: getCodeVerificationErrorMessage(verifyError),
				source: "code",
			});
			setCode("");
		} finally {
			endLoading();
		}
	};

	const updateCode = (value: string) => {
		if (isAuthBusy()) return;
		const nextCode = value.replace(/\D/g, "").slice(0, 6);
		setCode(nextCode);
		setError(null);
		if (codePattern.test(nextCode)) void verifyCode(nextCode);
	};

	const submitCode = () => {
		void verifyCode();
	};

	const focusCodeInput = () => {
		if (codeEntryDisabled) return;
		setFocusedInput("code");
		codeInputRef.current?.focus();
	};

	const openWebPathIfIdle = (path: string) => {
		if (isAuthBusy()) return;
		openWebPath(path);
	};

	const signInWithGoogle = async () => {
		if (!beginLoading("google")) return;
		setError(null);
		try {
			await auth.signInWithGoogle();
		} catch (googleError) {
			setError({
				message: getProviderErrorMessage(
					googleError,
					"Unable to start Google sign in.",
				),
				source: "google",
			});
		} finally {
			endLoading();
		}
	};

	const signInWithSso = async () => {
		if (normalizedOrganizationId.length === 0) return;
		if (!beginLoading("sso")) return;
		setError(null);
		try {
			await auth.signInWithSso(normalizedOrganizationId);
		} catch (ssoError) {
			setError({
				message: getProviderErrorMessage(
					ssoError,
					"Unable to start SSO sign in.",
				),
				source: "sso",
			});
		} finally {
			endLoading();
		}
	};

	const showSsoStep = () => {
		if (isAuthBusy()) return;
		setShowSso(true);
		setCodeSent(false);
		setCode("");
		setError(null);
	};

	return (
		<View style={styles.shell}>
			<GlassSurface
				fallbackStyle={styles.cardFallback}
				glassEffectStyle="regular"
				isInteractive
				style={styles.card}
				tintColor={colors.gray3}
			>
				{showBackButton ? (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Back"
						accessibilityHint={backButtonHint}
						accessibilityState={{ disabled: backDisabled }}
						accessibilityValue={backButtonAccessibilityValue}
						disabled={backDisabled}
						hitSlop={6}
						onPress={goBack}
						style={({ pressed }) => [
							styles.backPill,
							pressed && !backDisabled && styles.backPillPressed,
							backDisabled && styles.backPillDisabled,
						]}
					>
						<SymbolView
							name="arrow.left"
							size={11}
							tintColor={backDisabled ? colors.gray9 : colors.gray12}
							weight="semibold"
						/>
						<Text
							style={[
								styles.backPillText,
								backDisabled && styles.backPillTextDisabled,
							]}
						>
							Back
						</Text>
					</Pressable>
				) : null}
				<View style={styles.brandBlock}>
					<CapLogoBadge />
				</View>
				<View style={styles.header}>
					<Text style={[styles.title, isCodeStep && styles.codeTitle]}>
						{headerTitle}
					</Text>
					<Text style={[styles.subtitle, isCodeStep && styles.codeSubtitle]}>
						{headerSubtitle}
					</Text>
				</View>
				<View style={styles.formStack}>
					{showSso ? (
						<View style={styles.ssoStack}>
							<TextInput
								accessibilityHint={ssoInputHint}
								accessibilityLabel="Organization ID"
								accessibilityState={{ disabled: loading !== null }}
								accessibilityValue={ssoInputAccessibilityValue}
								value={organizationId}
								onChangeText={updateOrganizationId}
								autoCapitalize="none"
								autoCorrect={false}
								autoFocus
								clearButtonMode="while-editing"
								editable={loading === null}
								enablesReturnKeyAutomatically
								placeholder="Enter your Organization ID..."
								placeholderTextColor={colors.gray9}
								returnKeyType="go"
								selectionColor={colors.blue9}
								onBlur={() => setFocusedInput(null)}
								onFocus={() => setFocusedInput("sso")}
								onSubmitEditing={signInWithSso}
								style={[
									styles.input,
									focusedInput === "sso" && styles.inputFocused,
									ssoInputHasError && styles.inputError,
								]}
							/>
							<ActionButton
								label={ssoContinueButtonLabel}
								accessibilityLabel={ssoContinueButtonAccessibilityLabel}
								accessibilityHint={ssoButtonHint}
								accessibilityValue={ssoContinueButtonAccessibilityValue}
								onPress={signInWithSso}
								loading={loading === "sso"}
								disabled={!canStartSso}
								size="md"
								symbol="arrow.up.right"
								variant="dark"
							/>
						</View>
					) : isCodeStep ? (
						<View style={styles.codeSection}>
							<Pressable
								accessibilityLabel="Verification code"
								accessibilityRole="button"
								accessibilityHint={codeEntryHint}
								accessibilityState={{
									busy: loading === "code",
									disabled: codeEntryDisabled,
								}}
								accessibilityValue={codeEntryAccessibilityValue}
								disabled={codeEntryDisabled}
								onPress={focusCodeInput}
								style={[
									styles.codeBoxes,
									codeEntryDisabled && styles.codeBoxesDisabled,
								]}
							>
								{codeSlots.map((slot, index) => (
									<View
										key={slot}
										style={[
											styles.codeBox,
											activeCodeSlotIndex === index && styles.codeBoxActive,
											focusedInput === "code" &&
												activeCodeSlotIndex === index &&
												styles.codeBoxFocused,
											codeEntryHasError && styles.codeBoxError,
										]}
									>
										<Text style={styles.codeDigit}>{code[index] ?? ""}</Text>
									</View>
								))}
								<TextInput
									ref={codeInputRef}
									accessibilityElementsHidden
									accessible={false}
									value={code}
									onChangeText={updateCode}
									autoComplete="one-time-code"
									autoFocus
									editable={loading === null}
									enablesReturnKeyAutomatically
									keyboardType="number-pad"
									returnKeyType="done"
									onBlur={() => setFocusedInput(null)}
									onFocus={() => setFocusedInput("code")}
									onSubmitEditing={submitCode}
									maxLength={6}
									importantForAccessibility="no-hide-descendants"
									selectionColor={colors.blue9}
									textContentType="oneTimeCode"
									style={styles.codeInput}
								/>
							</Pressable>
							<ActionButton
								label={verifyButtonLabel}
								accessibilityHint={verifyButtonHint}
								accessibilityValue={verifyButtonAccessibilityValue}
								onPress={submitCode}
								loading={loading === "code"}
								disabled={!canVerifyCode}
								size="md"
								variant="primary"
							/>
						</View>
					) : (
						<>
							<TextInput
								accessibilityHint={emailInputHint}
								accessibilityLabel="Email address"
								accessibilityState={{ disabled: loading !== null }}
								accessibilityValue={emailInputAccessibilityValue}
								value={email}
								onChangeText={updateEmail}
								autoCapitalize="none"
								autoComplete="email"
								autoCorrect={false}
								autoFocus
								clearButtonMode="while-editing"
								editable={loading === null}
								enablesReturnKeyAutomatically
								keyboardType="email-address"
								placeholder="tim@apple.com"
								placeholderTextColor={colors.gray9}
								returnKeyType="send"
								selectionColor={colors.blue9}
								textContentType="emailAddress"
								onBlur={() => setFocusedInput(null)}
								onFocus={() => setFocusedInput("email")}
								onSubmitEditing={requestCode}
								style={[
									styles.input,
									focusedInput === "email" && styles.inputFocused,
									emailInputHasError && styles.inputError,
								]}
							/>
							<ActionButton
								label={emailButtonLabel}
								accessibilityHint={emailButtonHint}
								accessibilityValue={emailButtonAccessibilityValue}
								onPress={requestCode}
								loading={loading === "email"}
								disabled={!canRequestCode}
								size="md"
								symbol="envelope"
								variant="dark"
							/>
						</>
					)}
					{errorMessage ? (
						<View
							accessibilityLabel={`Sign-in error: ${errorMessage}`}
							accessibilityLiveRegion="polite"
							accessibilityRole="alert"
							style={styles.errorBanner}
						>
							<SymbolView
								name="exclamationmark.triangle"
								size={14}
								tintColor={colors.red9}
								weight="medium"
							/>
							<Text style={styles.errorText}>{errorMessage}</Text>
						</View>
					) : null}
					{isCodeStep ? (
						<View style={styles.codeLinks}>
							<Pressable
								accessibilityLabel={resendAccessibilityLabel}
								accessibilityRole="button"
								accessibilityHint={resendHint}
								accessibilityState={{
									busy: loading === "email",
									disabled: resendDisabled,
								}}
								accessibilityValue={resendAccessibilityValue}
								disabled={resendDisabled}
								hitSlop={6}
								onPress={requestCode}
								style={styles.resendButton}
							>
								<Text
									style={[
										styles.resendText,
										resendDisabled && styles.resendTextDisabled,
									]}
								>
									{resendLabel}
								</Text>
							</Pressable>
						</View>
					) : null}
					{showSso || isCodeStep ? null : (
						<>
							<Text style={styles.signupText}>
								Don't have an account?{" "}
								<Text
									accessibilityHint={signupLinkHint}
									accessibilityRole="link"
									accessibilityState={{ disabled: linkDisabled }}
									accessibilityValue={linkAccessibilityValue}
									style={[
										styles.signupLink,
										linkDisabled && styles.linkDisabled,
									]}
									onPress={() => openWebPathIfIdle("signup")}
								>
									Sign up here
								</Text>
							</Text>
							{showProviderOptions ? (
								<>
									<View style={styles.dividerRow}>
										<View style={styles.divider} />
										<Text style={styles.dividerText}>OR</Text>
										<View style={styles.divider} />
									</View>
									{showGoogle ? (
										<ActionButton
											label={googleButtonLabel}
											accessibilityLabel={googleButtonAccessibilityLabel}
											accessibilityHint={googleButtonHint}
											accessibilityValue={googleButtonAccessibilityValue}
											leading={<GoogleMark />}
											onPress={signInWithGoogle}
											loading={loading === "google"}
											disabled={loading !== null}
											variant="gray"
											size="md"
										/>
									) : null}
									{showSaml ? (
										<ActionButton
											label="Login with SAML SSO"
											accessibilityHint={samlButtonHint}
											accessibilityValue={samlButtonAccessibilityValue}
											onPress={showSsoStep}
											disabled={loading !== null}
											variant="gray"
											size="md"
											symbol="arrow.up.right"
										/>
									) : null}
								</>
							) : null}
						</>
					)}
					<Text style={styles.legalText}>
						{isCodeStep
							? "By entering your email, you acknowledge that you have both read and agree to Cap's "
							: "By typing your email and clicking continue, you acknowledge that you have both read and agree to Cap's "}
						<Text
							accessibilityHint={termsLinkHint}
							accessibilityRole="link"
							accessibilityState={{ disabled: linkDisabled }}
							accessibilityValue={linkAccessibilityValue}
							style={[styles.legalLink, linkDisabled && styles.linkDisabled]}
							onPress={() => openWebPathIfIdle("terms")}
						>
							Terms of Service
						</Text>{" "}
						and{" "}
						<Text
							accessibilityHint={privacyLinkHint}
							accessibilityRole="link"
							accessibilityState={{ disabled: linkDisabled }}
							accessibilityValue={linkAccessibilityValue}
							style={[styles.legalLink, linkDisabled && styles.linkDisabled]}
							onPress={() => openWebPathIfIdle("privacy")}
						>
							Privacy Policy
						</Text>
						.
					</Text>
				</View>
			</GlassSurface>
		</View>
	);
}

const styles = StyleSheet.create({
	shell: {
		flex: 1,
		justifyContent: "center",
		paddingVertical: 22,
	},
	card: {
		width: "100%",
		maxWidth: 432,
		alignSelf: "center",
		borderRadius: radius.lg,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray5,
		paddingHorizontal: 28,
		paddingVertical: 28,
		gap: 28,
		...squircle,
	},
	cardFallback: {
		backgroundColor: colors.gray3,
	},
	backPill: {
		position: "absolute",
		left: 20,
		top: 20,
		zIndex: 2,
		minHeight: 30,
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		borderRadius: radius.full,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		paddingHorizontal: 12,
		backgroundColor: "transparent",
		...squircle,
	},
	backPillPressed: {
		backgroundColor: colors.gray1,
	},
	backPillDisabled: {
		opacity: 0.55,
	},
	backPillText: {
		fontFamily: fonts.regular,
		fontSize: 12,
		lineHeight: 17,
		color: colors.gray12,
	},
	backPillTextDisabled: {
		color: colors.gray9,
	},
	brandBlock: {
		alignItems: "center",
	},
	header: {
		alignItems: "center",
		gap: 8,
	},
	title: {
		fontFamily: fonts.medium,
		fontSize: 24,
		lineHeight: 30,
		color: colors.gray12,
		textAlign: "center",
	},
	codeTitle: {
		fontSize: 20,
		lineHeight: 26,
	},
	subtitle: {
		fontFamily: fonts.regular,
		fontSize: 16,
		lineHeight: 22,
		color: colors.gray10,
		textAlign: "center",
	},
	codeSubtitle: {
		fontSize: 14,
		lineHeight: 20,
	},
	formStack: {
		gap: 12,
	},
	input: {
		minHeight: 44,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		backgroundColor: colors.gray1,
		paddingHorizontal: 14,
		fontFamily: fonts.regular,
		fontSize: 16,
		color: colors.gray12,
		...squircle,
	},
	inputFocused: {
		backgroundColor: colors.gray2,
		borderWidth: 1,
		borderColor: colors.gray5,
		shadowColor: colors.gray12,
		shadowOffset: { width: 0, height: 0 },
		shadowOpacity: 0.12,
		shadowRadius: 1,
	},
	inputError: {
		backgroundColor: colors.red1,
		borderWidth: 1,
		borderColor: colors.red7,
	},
	codeSection: {
		gap: 20,
		paddingTop: 2,
	},
	codeBoxes: {
		flexDirection: "row",
		gap: 8,
		justifyContent: "space-between",
		position: "relative",
	},
	codeBoxesDisabled: {
		opacity: 0.68,
	},
	codeBox: {
		flex: 1,
		height: 52,
		borderRadius: radius.sm,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray5,
		backgroundColor: colors.gray1,
		alignItems: "center",
		justifyContent: "center",
		...squircle,
	},
	codeBoxActive: {
		borderColor: colors.blue9,
	},
	codeBoxFocused: {
		backgroundColor: colors.gray2,
		borderWidth: 1,
		shadowColor: colors.gray12,
		shadowOffset: { width: 0, height: 0 },
		shadowOpacity: 0.12,
		shadowRadius: 1,
	},
	codeBoxError: {
		backgroundColor: colors.red1,
		borderColor: colors.red7,
	},
	codeDigit: {
		fontFamily: fonts.medium,
		fontSize: 22,
		lineHeight: 27,
		color: colors.gray12,
		textAlign: "center",
	},
	ssoStack: {
		gap: 10,
	},
	codeInput: {
		position: "absolute",
		width: 1,
		height: 1,
		opacity: 0,
	},
	codeLinks: {
		alignItems: "center",
		marginTop: 2,
	},
	resendButton: {
		minHeight: 30,
		justifyContent: "center",
		paddingHorizontal: 4,
	},
	resendText: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray10,
		textDecorationLine: "underline",
	},
	resendTextDisabled: {
		color: colors.gray9,
		textDecorationLine: "none",
	},
	errorBanner: {
		minHeight: 42,
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.red6,
		backgroundColor: colors.red1,
		paddingHorizontal: 12,
		paddingVertical: 10,
		...squircle,
	},
	dividerRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingVertical: 3,
	},
	divider: {
		flex: 1,
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.gray5,
	},
	dividerText: {
		fontFamily: fonts.medium,
		fontSize: 12,
		textTransform: "uppercase",
		color: colors.gray9,
	},
	legalText: {
		fontFamily: fonts.regular,
		fontSize: 12,
		lineHeight: 18,
		color: colors.gray9,
		textAlign: "center",
	},
	legalLink: {
		fontFamily: fonts.medium,
		color: colors.gray12,
	},
	linkDisabled: {
		opacity: 0.55,
	},
	signupText: {
		fontFamily: fonts.regular,
		fontSize: 12,
		lineHeight: 18,
		color: colors.gray9,
		textAlign: "center",
	},
	signupLink: {
		fontFamily: fonts.medium,
		color: colors.blue9,
	},
	errorText: {
		flex: 1,
		fontFamily: fonts.medium,
		fontSize: 14,
		lineHeight: 20,
		color: colors.red9,
	},
});
