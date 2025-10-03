import { NODE_ENV } from "@cap/env";
import { Button, Dialog, DialogContent, Input, LogoBadge } from "@cap/ui";
import { faEnvelope } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Image from "next/image";
import { signIn } from "next-auth/react";
import { useState } from "react";
import { toast } from "sonner";

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

	const handleGoogleSignIn = () => {
		signIn("google");
	};

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="w-[90vw] sm:max-w-md p-6 rounded-xl">
				<div className="space-y-6">
					<LogoBadge className="w-auto h-12" />

					<div className="text-left">
						<h1 className="text-xl font-semibold">Sign in to comment</h1>
						<p className="text-lg text-gray-9">Join the conversation.</p>
					</div>

					<div className="flex flex-col space-y-3">
						{NODE_ENV === "development" && (
							<>
								<Button
									variant="primary"
									onClick={handleGoogleSignIn}
									disabled={loading}
								>
									<Image
										src="/google.svg"
										alt="Google"
										className="mr-1 size-4"
										width={16}
										height={16}
									/>
									Continue with Google
								</Button>
								<div className="flex gap-4 items-center my-4">
									<span className="flex-1 h-px bg-gray-5" />
									<p className="text-sm text-center text-gray-8">OR</p>
									<span className="flex-1 h-px bg-gray-5" />
								</div>
							</>
						)}

						<form
							onSubmit={async (e) => {
								e.preventDefault();
								if (!email) return;

								setLoading(true);
								signIn("email", {
									email,
									redirect: false,
								})
									.then((res) => {
										setLoading(false);
										if (res?.ok && !res?.error) {
											setEmail("");
											setEmailSent(true);
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
							className="flex flex-col space-y-3"
						>
							<div>
								<Input
									id="email"
									name="email"
									autoFocus
									type="email"
									placeholder={emailSent ? "" : "tim@apple.com"}
									autoComplete="email"
									required
									value={email}
									disabled={emailSent}
									onChange={(e) => {
										setEmail(e.target.value);
									}}
								/>
								{NODE_ENV === "development" && (
									<div className="flex justify-center items-center px-6 py-3 mt-3 bg-red-600 rounded-xl">
										<p className="text-lg text-white">
											<span className="font-medium text-white">
												Development mode:
											</span>{" "}
											Auth URL will be logged to your dev console.
										</p>
									</div>
								)}
							</div>
							<Button
								variant="primary"
								type="submit"
								icon={
									<FontAwesomeIcon className="mr-1 size-4" icon={faEnvelope} />
								}
								disabled={loading || emailSent}
							>
								{emailSent
									? NODE_ENV === "development"
										? "Email sent to your terminal"
										: "Email sent to your inbox"
									: "Continue with Email"}
							</Button>
							<p className="pt-2 text-xs text-center text-gray-12">
								By typing your email and clicking continue, you acknowledge that
								you have both read and agree to Cap's{" "}
								<a
									href="/terms"
									target="_blank"
									className="text-xs font-semibold text-gray-12 hover:text-blue-300"
									rel="noopener"
								>
									Terms of Service
								</a>{" "}
								and{" "}
								<a
									href="/privacy"
									target="_blank"
									className="text-xs font-semibold text-gray-12 hover:text-blue-300"
									rel="noopener"
								>
									Privacy Policy
								</a>
								.
							</p>
						</form>
					</div>

					{emailSent && (
						<div>
							<button
								className="mt-5 text-sm underline text-gray-1 hover:text-black"
								onClick={() => {
									setEmailSent(false);
									setEmail("");
									setLoading(false);
								}}
							>
								Click to restart sign in process.
							</button>
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
};
