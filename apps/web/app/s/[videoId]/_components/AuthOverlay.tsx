import { NODE_ENV } from "@cap/env";
import { Button, Dialog, DialogContent, Input, LogoBadge } from "@cap/ui";
import { faArrowLeft, faEnvelope } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { trackEvent } from "@/app/utils/analytics";
import { usePublicEnv } from "@/utils/public-env";
import OtpForm from "./OtpForm";

interface AuthOverlayProps {
	isOpen: boolean;
	onClose: () => void;
}

export const AuthOverlay: React.FC<AuthOverlayProps> = ({
	isOpen,
	onClose,
}) => {
	const [email, setEmail] = useState("");
	const [loading, setLoading] = useState(false);
	const [emailSent, setEmailSent] = useState(false);
	const [step, setStep] = useState(1);
	const [code, setCode] = useState(["", "", "", "", "", ""]);

	const [lastResendTime, setLastResendTime] = useState<number | null>(null);

	const emailId = useId();
	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="w-[90vw] bg-gray-3 relative sm:max-w-md p-6 rounded-xl">
				{emailSent && (
					<div
						onClick={() => {
							setEmailSent(false);
							setEmail("");
							setLoading(false);
							setStep(1);
							setCode(["", "", "", "", "", ""]);
							setLastResendTime(null);
						}}
						className="absolute top-5 left-5 cursor-pointer z-20 flex gap-2 items-center py-1.5 px-3 text-gray-12 bg-transparent border border-gray-4 rounded-full hover:bg-gray-1 transition-colors duration-300"
					>
						<FontAwesomeIcon className="w-2" icon={faArrowLeft} />
						<p className="text-xs">Back</p>
					</div>
				)}
				<div className="space-y-6">
					<LogoBadge className="mx-auto w-auto h-12" />

					<div className="text-center">
						<h1 className="text-xl font-semibold">
							{step === 1 ? "Sign in to comment" : "Email sent"}
						</h1>
						<p className="text-base text-gray-9">
							{step === 1
								? "Join the conversation."
								: "We sent a 6-digit code to your email."}
						</p>
					</div>

					<div className="flex flex-col">
						{step === 1 ? (
							<StepOne
								email={email}
								emailSent={emailSent}
								setEmail={setEmail}
								loading={loading}
								setEmailSent={setEmailSent}
								setLoading={setLoading}
								setStep={setStep}
								setLastResendTime={setLastResendTime}
								emailId={emailId}
							/>
						) : (
							<OtpForm
								email={email}
								code={code}
								setCode={setCode}
								onClose={onClose}
								step={step}
								lastResendTime={lastResendTime}
								setLastResendTime={setLastResendTime}
							/>
						)}
						<p className="mt-6 text-xs text-center text-gray-9">
							By entering your email, you acknowledge that you have both read
							and agree to Cap's{" "}
							<Link
								href="/terms"
								target="_blank"
								className="text-xs font-semibold text-gray-12 hover:text-blue-300"
							>
								Terms of Service
							</Link>{" "}
							and{" "}
							<Link
								href="/privacy"
								target="_blank"
								className="text-xs font-semibold text-gray-12 hover:text-blue-300"
							>
								Privacy Policy
							</Link>
							.
						</p>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};

const StepOne = ({
	email,
	emailSent,
	setEmail,
	loading,
	setEmailSent,
	setLoading,
	setStep,
	setLastResendTime,
	emailId,
}: {
	email: string;
	emailSent: boolean;
	setEmail: (email: string) => void;
	loading: boolean;
	setEmailSent: (emailSent: boolean) => void;
	setLoading: (loading: boolean) => void;
	setStep: (step: number) => void;
	setLastResendTime: (time: number | null) => void;
	emailId: string;
}) => {
	const videoId = useParams().videoId;
	const handleGoogleSignIn = () => {
		trackEvent("auth_started", { method: "google", is_signup: true });
		setLoading(true);
		signIn("google", {
			redirect: false,
			callbackUrl: `${window.location.origin}/s/${videoId}`,
		});
	};
	const publicEnv = usePublicEnv();

	return (
		<form
			onSubmit={async (e) => {
				e.preventDefault();
				if (!email) return;

				setLoading(true);
				signIn("email", {
					email: email.trim().toLowerCase(),
					redirect: false,
				})
					.then((res) => {
						setLoading(false);
						if (res?.ok && !res?.error) {
							setEmail("");
							setEmailSent(true);
							setStep(2);
							setLastResendTime(Date.now());
							toast.success("Email sent - check your inbox!");
						} else {
							toast.error("Error sending email - try again?");
						}
					})
					.catch(() => {
						setEmailSent(false);
						setLoading(false);
						toast.error("Error sending email - try again?");
					});
			}}
			className="flex flex-col gap-3"
		>
			<div>
				<Input
					id={emailId}
					name="email"
					autoFocus
					type="email"
					placeholder={emailSent ? "" : "tim@apple.com"}
					autoComplete="email"
					required
					value={email}
					disabled={emailSent || loading}
					onChange={(e) => {
						setEmail(e.target.value.toLowerCase());
					}}
				/>
			</div>
			<Button
				variant="dark"
				type="submit"
				icon={<FontAwesomeIcon className="mr-1 size-4" icon={faEnvelope} />}
				disabled={loading || emailSent}
			>
				{emailSent
					? NODE_ENV === "development"
						? "Email sent to your terminal"
						: "Email sent to your inbox"
					: "Continue with Email"}
			</Button>
			{publicEnv.googleAuthAvailable && (
				<>
					<div className="flex gap-4 items-center">
						<span className="flex-1 h-px bg-gray-5" />
						<p className="text-sm text-center text-gray-10">OR</p>
						<span className="flex-1 h-px bg-gray-5" />
					</div>
					<Button
						variant="gray"
						type="button"
						className="flex gap-2 justify-center items-center my-1 w-full text-sm"
						onClick={handleGoogleSignIn}
						disabled={loading}
					>
						<Image src="/google.svg" alt="Google" width={16} height={16} />
						Login with Google
					</Button>
				</>
			)}
		</form>
	);
};
