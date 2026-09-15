import type { EmailDefinition } from "../types";

export const freeUpdate = {
	id: "free-update",
	key: "free-update",
	purpose:
		"One-off Cap v0.6 launch announcement for eligible independent noncustomers, showing the demo workflow through the release video.",
	subject: "Meet Cap v0.6, our biggest update yet",
	previewText:
		"Meet Cap v0.6: 3D scenes, animated titles and cleaner audio, all in one app.",
	variables: ["capGreeting"],
	assets: ["emails/assets/cap-v06-player.jpg"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph><Strong>Cap v0.6 is here, and it's our biggest release yet.</Strong></Paragraph>",
		`<Image src="img/cap-v06-player.jpg" alt="Watch the Cap v0.6 launch video" href="https://cap.so/blog/cap-v06?utm_source=loops&amp;utm_medium=email&amp;utm_campaign=cap_v06_launch&amp;utm_content=noncustomers" />`,
		"<Paragraph>We've rebuilt the editor to turn your screen recordings into polished demos. Record your screen, add a 3D scene, animated titles and a moving background, then export a video you'll want to share.</Paragraph>",
		"<Paragraph>There's also Studio Sound to reduce microphone noise, plus faster exports. Whether it's a product demo, a client walkthrough or a team update, you can make it in Cap.</Paragraph>",
		"<Paragraph>The release video is the best way to see what's new:</Paragraph>",
		`<Paragraph><Link href="https://cap.so/blog/cap-v06?utm_source=loops&amp;utm_medium=email&amp;utm_campaign=cap_v06_launch&amp;utm_content=noncustomers">See Cap v0.6 in action →</Link></Paragraph>`,
	].join(""),
} satisfies EmailDefinition;
