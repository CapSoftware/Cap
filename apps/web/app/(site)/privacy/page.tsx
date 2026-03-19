import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "Privacy Policy — Cap",
};

export default function App() {
	return (
		<div className="py-32 wrapper wrapper-sm md:py-40">
			<div className="space-y-6 text-center">
				<h1 className="text-3xl md:text-4xl fade-in-down animate-delay-1">
					Privacy Policy
				</h1>
				<p className="pb-10 mx-auto max-w-lg text-lg text-gray-10 fade-in-down animate-delay-2">
					We've tried to make this privacy policy as simple and digestible as
					possible. If you have any questions, please don't hesitate to reach
					out to us.
				</p>
				<div className="text-left legal-body fade-in-up animate-delay-2">
					<p>
						At Cap Software, Inc. ("Cap," "we," "us," or "our"), we are
						committed to protecting your privacy and ensuring the security of
						your personal information. This Privacy Policy explains how we
						collect, use, disclose, and safeguard your information when you use
						our software application and services (collectively, the
						"Services"). By using our Services, you consent to the collection,
						use, and disclosure of your information as described in this Privacy
						Policy.
					</p>
					<ol>
						<li>
							<h3>Information We Collect</h3>
							<br />
							a. Personal Information: When you create an account, we collect
							your name, email address, and any other information you
							voluntarily provide to us.
							<br />
							b. Usage Data: We collect information about how you use our
							Services, such as the videos you create, the duration of your
							recordings, and the features you utilize.
							<br />
							c. Device Information: We may collect information about the
							devices you use to access our Services, including the hardware
							model, operating system and version, and unique device
							identifiers.
							<br />
							d. Cookies and Similar Technologies: We use cookies and similar
							technologies to enhance your experience, analyze trends, and
							administer our Services.
						</li>
						<li>
							<h3>How We Use Your Information</h3>
							<br />
							a. To provide, maintain, and improve our Services.
							<br />
							b. To communicate with you, provide customer support, and respond
							to your inquiries.
							<br />
							c. To personalize your experience and deliver content and product
							offerings relevant to your interests.
							<br />
							d. To detect, prevent, and address technical issues and protect
							against fraudulent or illegal activities.
							<br />
							e. To generate aggregated, anonymized data for statistical and
							research purposes.
						</li>
						<li>
							<h3>Sharing Your Information</h3>
							<br />
							a. We may share your information with third-party service
							providers who assist us in operating our Services and conducting
							our business.
							<br />
							b. We may disclose your information if required to do so by law or
							in the good faith belief that such action is necessary to comply
							with legal obligations or to protect our rights, property, or
							safety, or that of our users or the public.
							<br />
							c. In the event of a merger, acquisition, or sale of all or a
							portion of our assets, your information may be transferred as part
							of the transaction.
						</li>
						<li>
							<h3>Data Security</h3>
							<br />
							We implement reasonable security measures to protect your
							information from unauthorized access, alteration, disclosure, or
							destruction. However, no method of transmission over the internet
							or electronic storage is 100% secure, and we cannot guarantee
							absolute security.
						</li>
						<li>
							<h3>Your Choices</h3>
							<br />
							a. You can update, correct, or delete your account information at
							any time by logging into your account.
							<br />
							b. You can opt-out of receiving promotional emails from us by
							following the unsubscribe instructions provided in those emails.
							<br />
							c. You can control the use of cookies through your browser
							settings, but note that disabling cookies may limit your ability
							to use certain features of our Services.
						</li>
						<li>
							<h3>Retention of Your Information</h3>
							<br />
							We retain your information for as long as necessary to fulfill the
							purposes outlined in this Privacy Policy, unless a longer
							retention period is required or permitted by law.
						</li>
						<li>
							<h3>Children's Privacy</h3>
							<br />
							Our Services are not intended for children under the age of 13. We
							do not knowingly collect personal information from children under
							13. If we become aware that a child under 13 has provided us with
							personal information, we will take steps to delete such
							information.
						</li>
						<li>
							<h3>Changes to This Privacy Policy</h3>
							<br />
							We may update our Privacy Policy from time to time. We will notify
							you of any changes by posting the new Privacy Policy on this page
							and updating the "Last Updated" date at the top of this Privacy
							Policy.
						</li>
						<li>
							<h3>Contact Us</h3>
							<br />
							If you have any questions or concerns about this Privacy Policy or
							our privacy practices, please contact us at hello@cap.so.
						</li>
					</ol>
					<p>
						By using our Services, you acknowledge that you have read and
						understood this Privacy Policy and agree to be bound by its terms.
					</p>
					<p>Privacy Policy for Cap Software, Inc.</p>
					<p>Last Updated: 24th April 2024</p>
				</div>
			</div>
		</div>
	);
}
