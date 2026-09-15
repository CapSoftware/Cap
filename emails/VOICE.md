# Writing emails from Richie

Use this alongside the [catalogue](CATALOG.md). The reference is Richie's actual Bento mail: the welcome sequence (36459), Studio Mode explanation (47417), tips (47847), team introduction (47848), founder story (31811), and recent product/security updates (75230, 75463, 76365). The private archive contains six sequence templates and 66 broadcasts. Do not put subscriber exports or personalised unsubscribe links in this repository.

## Voice

Start with the complete `capGreeting` property: “Hey Richie,” when a nonblank name is known, otherwise “Hey,”. Keep “Hey,” as the Loops fallback too. Introduce Richie in a welcome email; later emails can get straight to the point. Use contractions, ordinary words and British spelling. Write “reply and let me know”, not “your feedback helps us make better decisions”. An occasional `:)` fits the originals; using one in every email does not.

Use first person for something Richie is asking or offering, and “we” for work the Cap team has done. Keep promises realistic. Do not invent a personal anecdote, say Richie noticed someone's activity, or imply a manually written one-to-one message. Replies go to `richie@cap.so`.

Give each email one reason to exist and one main action. Usually 60–120 words is enough. A question that invites a reply can be the entire action. Keep advice specific: what to record, where to find the workspace, or which paid plan covers the recipient's need. Read the result aloud and cut anything that could appear in any software company's email.

Do not automatically carry forward historical prices, discounts, countdowns, launch dates, team size, platform support or compliance claims. Verify them against the current product and approved offer. No fake `Re:`, invented urgency or claims of guaranteed results. Local recordings are not visible to this sync, so “you haven't recorded yet” is not a supported claim.

## Design

`brand.ts` owns the sender, canonical Cap logo artwork, “Cheers, Richie” signature, footer, background, 16px body type, line height, paragraph spacing and link colour. `mjml.ts` renders these into every upload. Keep bodies as simple paragraphs; an individual email should not duplicate the design. The logo PNG is exported from the canonical Cap component, including its exact vector wordmark. Its white backing preserves contrast on dark backgrounds without substituting a different font. Keep it at its natural aspect ratio, with no extra left inset.

Use one descriptive text link when a click is needed. Feedback emails can have no link. Keep the essential message readable with images blocked. Custom MJML contains exactly one company/address/unsubscribe footer, without the automatic opt-in explanation. Use `{unsubscribe_link}` so Loops supplies the actual link. Body line height is 26px and footer line height is 19px; native LMX uses percentages, not pixels. Check the actual render after upload and wait for images to load.

## Review of the current programme

| Email                    | Main action                         | Editorial decision                                                                                                        |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Free welcome             | Download and make a first recording | Personal introduction, two recording modes, no upgrade pitch.                                                             |
| Free recording help      | Try a short recording               | Conditional advice, no claim that local recording activity is known.                                                      |
| Free sharing help        | Share a useful explanation          | One concrete bug-report example and library link.                                                                         |
| Free plan guidance       | Compare paid plans                  | Explain Desktop versus Pro by use case; no stale price or coupon.                                                         |
| Customer welcome         | Reply with intended use             | Thank the customer, use the actual plan variation, remove a desktop download link that did not fit self-hosted customers. |
| Customer workflow        | Record an answer once               | Practical habit that works with local exports or cloud sharing.                                                           |
| Customer feedback        | Reply with a problem or request     | One short question, no survey or upgrade diversion.                                                                       |
| Teammate welcome         | Find the right organisation         | Practical access help; no promotion.                                                                                      |
| Teammate handoff         | Share context with the team         | One task and an access check; no promotion.                                                                               |
| Former customer feedback | Explain why they left               | Offer help without a coupon, pressure or automatic re-enrolment.                                                          |
| Customer campaign        | Read the changelog or reply         | Honest evergreen invitation; no invented announcement.                                                                    |
| Free-user campaign       | Reconsider Cap for a real task      | Ask what put them off; no claim that a specific missing feature is fixed.                                                 |

The two campaign drafts are reusable evergreen starting points. A feature announcement should replace the subject, preview and body with the specific verified feature and how to use it. Review targeting and content for every campaign; do not repeatedly send the same generic update to the whole imported list.

## Conversion and learning

The sequence first helps the recipient get value, then explains the paid option where appropriate. Customers receive usage and feedback emails. Teammates receive workspace help. Unknown identities receive nothing. Recording/sharing reminders are skipped when the corresponding known cloud milestone is complete.

Measure first recording and first share after onboarding, paid conversion after plan guidance, useful replies, and retained usage for customers. Compare eligible delivered recipients over a defined window; report unsubscribes, complaints and bounces alongside conversions. Open rate alone is not a reliable conversion measure, and historical Bento opens/clicks do not establish which copy causes purchases.

Start with this baseline and change one meaningful variable at a time once there is enough traffic: the plan email's subject, the main action, or timing. Keep audience and consent rules identical across variants. Purchase attribution and these conversion reports still need to be connected to the live enrollment service before claiming a measured uplift.
