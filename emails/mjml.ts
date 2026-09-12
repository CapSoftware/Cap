import {
	bodyLineHeightPercent,
	footer,
	logo,
	paragraphSpacing,
	signature,
	theme,
} from "./brand";
import type { EmailDefinition } from "./types";

const escape = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

export const mjmlVariables = (value: string) =>
	value.replace(/\{contact\.(\w+)\}/g, "{$1}");

const renderBody = (body: string) => {
	for (const [, tag] of body.matchAll(/<\/?([A-Za-z][\w]*)\b/g)) {
		if (!["Paragraph", "Link", "Strong", "Em", "Br"].includes(tag))
			throw new Error(`Unsupported marketing content tag: ${tag}`);
	}
	return mjmlVariables(
		body
			.replaceAll("<Paragraph>", "<mj-text>")
			.replaceAll("</Paragraph>", "</mj-text>\n")
			.replaceAll(
				"<Link ",
				`<a style="color:${theme.styles.textLinkColor};text-decoration:underline" `,
			)
			.replaceAll("</Link>", "</a>")
			.replaceAll("<Strong>", "<strong>")
			.replaceAll("</Strong>", "</strong>")
			.replaceAll("<Em>", "<em>")
			.replaceAll("</Em>", "</em>")
			.replaceAll("<Br />", "<br />"),
	);
};

export const renderMjml = (email: EmailDefinition) => `<mjml lang="en">
	<mj-head>
		<mj-title>${escape(mjmlVariables(email.subject))}</mj-title>
		<mj-preview>${escape(mjmlVariables(email.previewText))}</mj-preview>
		<mj-attributes>
			<mj-all font-family="Helvetica, Arial, sans-serif" />
			<mj-text font-size="${theme.styles.textBaseFontSize}px" line-height="${Math.round((theme.styles.textBaseFontSize * bodyLineHeightPercent) / 100)}px" color="${theme.styles.textBaseColor}" padding="0 0 ${paragraphSpacing}px" />
		</mj-attributes>
	</mj-head>
	<mj-body width="600px" background-color="${theme.styles.backgroundColor}">
		<mj-section background-color="${theme.styles.bodyColor}" padding="${theme.styles.bodyYPadding}px ${theme.styles.bodyXPadding}px">
			<mj-column>
				<mj-image src="img/cap-logo.png" alt="Cap" width="${logo.width}px" align="left" padding="0 0 24px" />
				${renderBody(email.body)}
				<mj-text padding="8px 0 0">${signature.map(escape).join("<br />")}</mj-text>
				<mj-text font-size="12px" line-height="19px" color="#6b7280" padding="24px 0 0">${escape(footer.company)}<br />${escape(footer.address)}<br /><a href="{unsubscribe_link}" style="color:#6b7280;text-decoration:underline">${escape(footer.unsubscribeLabel)}</a></mj-text>
			</mj-column>
		</mj-section>
	</mj-body>
</mjml>
`;
