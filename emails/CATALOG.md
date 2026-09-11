# Cap email catalogue

Generated from the email library with `bun run emails:catalog`. Edit the source files, then regenerate. [Editing guide](README.md).

## Lifecycle flows

These are the locally configured draft journeys. This document is not a live status check. Imports remain held; production enrollment is not deployed. Run `bun run emails:check-loops` to verify the actual Loops drafts.

| Flow | Audience | Schedule after entry | Emails |
| --- | --- | --- | --- |
| [Independent free-user onboarding](https://app.loops.so/workflows/cmtvpih6201fp0jznodf8fpwz) | free | Day 0, Day 2, Day 5, Day 9 | 4 |
| [Customer onboarding](https://app.loops.so/workflows/cmtvpilm601f40jzwx3474cko) | customer | Day 0, Day 3, Day 7 | 3 |
| [Teammate onboarding](https://app.loops.so/workflows/cmtvpm0ag01it0j37w02o6wav) | teammate | Day 0, Day 3 | 2 |
| [Former customer follow-up](https://app.loops.so/workflows/cmtvpm8zm01ii0j01cz7d15qr) | former | Day 14 | 1 |

All journeys require global subscription, positive Cap consent, the exact audience, lifecycle enabled and onboarding eligible. These filters continue to apply downstream. Free/former promotional flows additionally exclude teammates and require promotional eligibility. Customer and teammate flows still require marketing consent.

Teammate history takes priority over paid/free classification. Ambiguous contacts receive no journey. [Audience classification and consent](../scripts/loops/README.md#audience-rules).

### Independent free-user onboarding

Entry: capLifecycleStage changes into free. Re-entry is disabled. Delays below are relative to the previous step; day numbers are cumulative from entry.

Downstream conditions: subscribed isTrue; capConsent equals subscribed; capAudience equals free; capTeammate isFalse; capPromotionalEligible isTrue; capLifecycleEnabled isTrue; capOnboardingEligible isTrue.

```mermaid
flowchart TD
  entry["Stage becomes free"] --> guard["Consent and audience guards"]
  guard --> email0["Day 0: welcome"]
  email0 --> wait1["Wait 2 days"]
  wait1 --> branch1{"capHasVideo is false?"}
  branch1 -->|Yes| email1["Day 2: record"]
  branch1 -->|No: skip| next1((Continue))
  email1 --> next1
  next1 --> wait2["Wait 3 days"]
  wait2 --> branch2{"capHasSharedVideo is false?"}
  branch2 -->|Yes| email2["Day 5: share"]
  branch2 -->|No: skip| next2((Continue))
  email2 --> next2
  next2 --> wait3["Wait 4 days"]
  wait3 --> email3["Day 9: plans"]
  email3 --> exit["End"]
```

| Day | Subject and source | Send condition |
| --- | --- | --- |
| 0 | [Welcome to Cap](../emails/marketing/free-welcome.ts) | Journey guards |
| 2 | [A quick way to try Cap](../emails/marketing/free-record.ts) | `capHasVideo=false` |
| 5 | [Send your next explanation as a Cap](../emails/marketing/free-share.ts) | `capHasSharedVideo=false` |
| 9 | [Using Cap for work?](../emails/marketing/free-plans.ts) | Journey guards |

### Customer onboarding

Entry: capLifecycleStage changes into customer. Re-entry is disabled. Delays below are relative to the previous step; day numbers are cumulative from entry.

Downstream conditions: subscribed isTrue; capConsent equals subscribed; capAudience equals customer; capLifecycleEnabled isTrue; capOnboardingEligible isTrue.

```mermaid
flowchart TD
  entry["Stage becomes customer"] --> guard["Consent and audience guards"]
  guard --> email0["Day 0: welcome"]
  email0 --> wait1["Wait 3 days"]
  wait1 --> email1["Day 3: workflow"]
  email1 --> wait2["Wait 4 days"]
  wait2 --> email2["Day 7: feedback"]
  email2 --> exit["End"]
```

| Day | Subject and source | Send condition |
| --- | --- | --- |
| 0 | [Thanks for choosing {contact.capPlanName}](../emails/marketing/customer-welcome.ts) | Journey guards |
| 3 | [One less thing to explain twice](../emails/marketing/customer-workflow.ts) | Journey guards |
| 7 | [How is Cap working for you?](../emails/marketing/customer-feedback.ts) | Journey guards |

### Teammate onboarding

Entry: capLifecycleStage changes into teammate. Re-entry is disabled. Delays below are relative to the previous step; day numbers are cumulative from entry.

Downstream conditions: subscribed isTrue; capConsent equals subscribed; capAudience equals teammate; capLifecycleEnabled isTrue; capOnboardingEligible isTrue.

```mermaid
flowchart TD
  entry["Stage becomes teammate"] --> guard["Consent and audience guards"]
  guard --> email0["Day 0: welcome"]
  email0 --> wait1["Wait 3 days"]
  wait1 --> email1["Day 3: handoff"]
  email1 --> exit["End"]
```

| Day | Subject and source | Send condition |
| --- | --- | --- |
| 0 | [Welcome to your team in Cap](../emails/marketing/teammate-welcome.ts) | Journey guards |
| 3 | [Make your next handoff easier](../emails/marketing/teammate-handoff.ts) | Journey guards |

### Former customer follow-up

Entry: capLifecycleStage changes into former. Re-entry is disabled. Delays below are relative to the previous step; day numbers are cumulative from entry.

Downstream conditions: subscribed isTrue; capConsent equals subscribed; capAudience equals former; capTeammate isFalse; capPromotionalEligible isTrue; capLifecycleEnabled isTrue; capOnboardingEligible isTrue.

```mermaid
flowchart TD
  entry["Stage becomes former"] --> guard["Consent and audience guards"]
  guard --> wait0["Wait 14 days"]
  wait0 --> email0["Day 14: feedback"]
  email0 --> exit["End"]
```

| Day | Subject and source | Send condition |
| --- | --- | --- |
| 14 | [Could I ask about your time with Cap?](../emails/marketing/former-feedback.ts) | Journey guards |

## Campaign templates

Campaigns are manually scheduled product updates, with no automatic enrollment. Both require subscription, positive consent and their exact audience. The free template also requires promotional eligibility and excludes teammates.

| Campaign | Audience | Subject and source | Loops ID |
| --- | --- | --- | --- |
| Customer product update template | customer | [Keeping up with Cap](../emails/marketing/customer-update.ts) | `cmtvpmfxc01ls0j0nnlffombv` |
| Noncustomer product update template | free | [Take another look at Cap](../emails/marketing/free-update.ts) | `cmtvpmjej01kr0j18cxoz2n0y` |

## Branding and personalization

Shared design, logo, signature, footer, sender and fallbacks: [emails/brand.ts](../emails/brand.ts). Custom MJML delivery is generated by [emails/mjml.ts](../emails/mjml.ts).

Sender: Richie from Cap; local part `richie` on the Loops sending domain. Reply-to: richie@cap.so.

The shared header uses the canonical Cap icon and vector wordmark, with white backing for contrast on dark backgrounds. The complete greeting is `capGreeting`, with `Hey,` as its fallback. One compact footer contains the company, address and unsubscribe link.

Customer welcome variations come from [customer-copy.ts](customer-copy.ts); eligibility is resolved from account and license state in the profile sync.

| Plan | Welcome variation |
| --- | --- |
| Cap Pro | With Cap Pro, you can share recordings with a link and work on them with your team. Your plan also includes the desktop commercial license, so you can use Cap for client work too. |
| Cap Self-hosted | For your self-hosted setup, start with the instructions supplied with your purchase. If you get stuck anywhere, reply with what you're seeing and I'll help you sort it. |
| Cap Desktop | Your desktop license lets you use Cap's recorder and editor for commercial work. You can activate it in the app with the license details from your purchase email. |
| Cap | If you need a hand getting set up, just reply and I'll help you sort it. |

## Marketing email copy

The excerpts below show content, not an email-client render. Branding and required Loops footer content are composed separately.

### free-welcome

Help an independent free user make their first recording.

**Subject:** Welcome to Cap

**Preview:** Richie here. Great to have you with us :)

**Variables:** `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/free-welcome.ts](../emails/marketing/free-welcome.ts)

{contact.capGreeting}

Richie here, founder of Cap. Thanks for giving it a go :)

The easiest way to start is to record something you'd normally type out. A quick explanation or a bit of feedback is plenty.

Use Instant Mode when you want a shareable link, or Studio Mode to edit your recording and export it locally.

Download Cap here.

If you have any questions, just reply to this email. I'd love to help.

### free-record

Offer recording help when no cloud video is known.

**Subject:** A quick way to try Cap

**Preview:** You don't need a script or a perfect take.

**Variables:** `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/free-record.ts](../emails/marketing/free-record.ts)

{contact.capGreeting}

If you're still finding your feet with Cap, try this: open something on your screen and spend 30 seconds explaining it out loud.

No script or perfect take needed. In Studio Mode, you can trim it afterwards and keep the recording on your own device.

Need the app? You can download Cap here.

If something's stopping you from recording, reply and let me know what happened. I'll help you sort it.

### free-share

Offer sharing guidance when no shared cloud video is known.

**Subject:** Send your next explanation as a Cap

**Preview:** A short recording and one sentence are enough.

**Variables:** `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/free-share.ts](../emails/marketing/free-share.ts)

{contact.capGreeting}

Next time you're typing a long explanation, try showing it in Cap instead.

Record the bit that's hard to explain, then send the link with a sentence about what you need. Something like: “Here's the bug I mentioned. Can you see the same thing?”

It doesn't have to be polished to be useful.

Open your Cap library.

### free-plans

Explain current plan options to eligible independent noncustomers.

**Subject:** Using Cap for work?

**Preview:** Here's how the Desktop License and Cap Pro compare.

**Variables:** `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/free-plans.ts](../emails/marketing/free-plans.ts)

{contact.capGreeting}

If you're thinking about using Cap for work, there are two options.

A Desktop License covers commercial use of the recorder and editor. It's a good fit if you mainly edit and export videos yourself.

Cap Pro adds cloud sharing and collaboration, and includes the desktop commercial license. That's the one to look at if you're sharing recordings with clients or your team.

Compare the plans here.

Not sure which you need? Reply with what you're using Cap for and I'll point you in the right direction.

### customer-welcome

Welcome a paying customer with copy matching their paid plan.

**Subject:** Thanks for choosing {contact.capPlanName}

**Preview:** Thanks for backing what we're building.

**Variables:** `contact.capCustomerWelcome` (fallback: If you need a hand getting set up, just reply and I'll help you sort it.); `contact.capPlanName` (fallback: Cap); `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/customer-welcome.ts](../emails/marketing/customer-welcome.ts)

{contact.capGreeting}

Richie here, founder of Cap. Thanks so much for supporting what we're building. It means a lot.

{contact.capCustomerWelcome}

What are you planning to use Cap for? Just reply and let me know. I'd love to hear.

### customer-workflow

Help a customer build a repeatable recording habit.

**Subject:** One less thing to explain twice

**Preview:** A recording you can keep coming back to.

**Variables:** `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/customer-workflow.ts](../emails/marketing/customer-workflow.ts)

{contact.capGreeting}

A quick idea for your next recording: pick a question you keep answering and record the walkthrough once.

It could be how to set something up, where to find a setting, or how you want a piece of work done. Give it a title you'll recognise later, then save or share it wherever you normally answer that question.

The next time someone asks, you've already got it ready.

Anything making that harder than it should be? Reply and tell me.

### customer-feedback

Ask a customer what is useful and what needs improvement.

**Subject:** How is Cap working for you?

**Preview:** I'd love to hear what's working and what isn't.

**Variables:** `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/customer-feedback.ts](../emails/marketing/customer-feedback.ts)

{contact.capGreeting}

How are you getting on with Cap?

I'd love to know if there's anything you wish worked differently, or something that's getting in your way.

Just reply here. I read every reply, and hearing how people actually use Cap helps me decide what we should work on next.

Thanks again for backing us :)

### teammate-welcome

Help an invited teammate find their workspace without promoting upgrades.

**Subject:** Welcome to your team in Cap

**Preview:** Here's where to find your team's recordings.

**Variables:** `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/teammate-welcome.ts](../emails/marketing/teammate-welcome.ts)

{contact.capGreeting}

Richie here, founder of Cap. Great to have you with us :)

Open your dashboard and select your team's organisation. You'll find the recordings they've shared with you there.

If you can't see the right organisation, check with the person who invited you. They can confirm which email address they used and your access.

You can also reply here if you need a hand.

### teammate-handoff

Help a teammate share useful context with their organization.

**Subject:** Make your next handoff easier

**Preview:** Show your teammate the bit that's hard to put into words.

**Variables:** `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/teammate-handoff.ts](../emails/marketing/teammate-handoff.ts)

{contact.capGreeting}

Next time you hand something over to a teammate, try recording the part that's tricky to explain in a message.

Show what changed and what you need them to look at. Even a short recording can save a lot of back and forth.

Open your team workspace. Before sending a recording, check its sharing settings so the right people can watch it.

If anything about sharing with your team feels awkward, reply and let me know.

### former-feedback

Ask an eligible former cloud customer for feedback after paid access ends.

**Subject:** Could I ask about your time with Cap?

**Preview:** I'd appreciate your honest feedback.

**Variables:** `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/former-feedback.ts](../emails/marketing/former-feedback.ts)

{contact.capGreeting}

Could I ask what made you decide to stop using your paid Cap plan?

Was something missing, did something not work properly, or did you just not need it anymore?

If you've got a moment to reply, I'd really appreciate it. And if there was a problem I can help with, I'd like to try.

Thanks for giving Cap a go.

### customer-update

Evergreen changelog invitation for customers; review before each campaign.

**Subject:** Keeping up with Cap

**Preview:** The changes we've shipped, all in one place.

**Variables:** `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/customer-update.ts](../emails/marketing/customer-update.ts)

{contact.capGreeting}

Just a quick one from me. If you're wondering what's changed in Cap, we keep the features and fixes together in our changelog.

Here's what we've shipped.

Is there something you're still waiting for us to build or fix? Reply and let me know. Hearing what's missing is just as useful as hearing what's working.

### free-update

Evergreen reactivation invitation for eligible independent noncustomers; review before each campaign.

**Subject:** Take another look at Cap

**Preview:** Was something missing when you tried it?

**Variables:** `contact.capGreeting` (fallback: Hey,)

**Edit:** [emails/marketing/free-update.ts](../emails/marketing/free-update.ts)

{contact.capGreeting}

If it's been a while since you tried Cap, I'd love for you to take another look.

You can see what's changed here. Next time you need to explain something on screen, give it a go.

If something put you off last time, just reply and tell me. I'd like to know, especially if it was something we could have done better.

## Application emails

These are repository send paths and retained templates, not confirmation of production delivery. They continue through Resend and keep their existing React Email layouts. Loops audience filters do not control them. Shared marketing branding does not automatically restyle these templates.

| Email | Trigger | Recipients | Template |
| --- | --- | --- | --- |
| Login verification code | Web or mobile email authentication request | The person signing in | [otp-email](../packages/database/emails/otp-email.tsx) |
| Organization invitation | An organization invitation is issued through the web action or public API | The invited teammate | [organization-invite](../packages/database/emails/organization-invite.tsx) |
| Requested download links | The person requests download links by email | The requesting email address | [download-link](../packages/database/emails/download-link.tsx) |
| First shareable recording | Desktop API creates the first eligible shareable recording | The recording owner | [first-shareable-link](../packages/database/emails/first-shareable-link.tsx) |
| New comment notification | An eligible comment notification is created | The notification recipient | [new-comment](../packages/database/emails/new-comment.tsx) |
| First view notification | An eligible recording receives its first view | The recording owner | [first-view](../packages/database/emails/first-view.tsx) |
| Payment failed / final retry | Stripe invoice payment fails | The billing account user | [payment-failed](../packages/database/emails/payment-failed.tsx) |
| Signed BAA delivery | A business associate agreement is signed | The signer, with the configured notice recipients copied | [signed-baa](../packages/database/emails/signed-baa.tsx) |
| Desktop feedback notification | Legacy desktop feedback handler | Cap support, with the user copied | [feedback](../packages/database/emails/feedback.tsx) |
| Messenger support notification | An eligible support conversation requests an email notification | Cap support; replies go to the user | [messenger-support-email](../packages/database/emails/messenger-support-email.tsx) |
| Account deletion request notification | An account deletion request is submitted | Cap support; replies go to the requester | [messenger-support-email](../packages/database/emails/messenger-support-email.tsx) |
| Mobile content report notification | A mobile content report is submitted | Cap support; replies go to the reporter | [messenger-support-email](../packages/database/emails/messenger-support-email.tsx) |
| Legacy login link template | No current send call found in this checkout | None configured | [login-link](../packages/database/emails/login-link.tsx) |

### Login verification code

OTP authentication; does not subscribe the recipient to marketing.

Send source: [packages/database/auth/auth-options.ts](../packages/database/auth/auth-options.ts), [apps/web/app/api/mobile/[...route]/route.ts](../apps/web/app/api/mobile/%5B...route%5D/route.ts).

### Organization invitation

An invitation is not permission to send promotions.

Send source: [apps/web/actions/organization/send-invites.ts](../apps/web/actions/organization/send-invites.ts), [apps/web/app/api/v1/[...route]/route.ts](../apps/web/app/api/v1/%5B...route%5D/route.ts).

### Requested download links

Uses the existing Resend marketing sender flag; Loops audience filters do not govern this send.

Send source: [apps/web/actions/send-download-link.ts](../apps/web/actions/send-download-link.ts).

### First shareable recording

Scheduled in Resend for five minutes later; uses the existing marketing sender flag. Check overlap before activating Loops recording reminders.

Send source: [apps/web/app/api/desktop/[...route]/video.ts](../apps/web/app/api/desktop/%5B...route%5D/video.ts).

### New comment notification

Notification preferences and exclusions are applied by Notification.ts.

Send source: [apps/web/lib/Notification.ts](../apps/web/lib/Notification.ts).

### First view notification

Notification preferences and first-view checks are applied by Notification.ts.

Send source: [apps/web/lib/Notification.ts](../apps/web/lib/Notification.ts).

### Payment failed / final retry

Different subject and content for the final attempt; deduplicated by invoice and attempt.

Send source: [apps/web/app/api/webhooks/stripe/route.ts](../apps/web/app/api/webhooks/stripe/route.ts).

### Signed BAA delivery

Includes the signed PDF and tracks delivery state; preserve attachment and CC behavior.

Send source: [apps/web/actions/organization/signed-baa.ts](../apps/web/actions/organization/signed-baa.ts).

### Desktop feedback notification

Source-defined handler; inspect route reachability before relying on it.

Send source: [apps/web/app/api/desktop/[...route]/root.ts](../apps/web/app/api/desktop/%5B...route%5D/root.ts).

### Messenger support notification

The support service reserves notification state before sending.

Send source: [apps/web/lib/messenger/support-email.ts](../apps/web/lib/messenger/support-email.ts).

### Account deletion request notification

Deduplicated by deletion request ID.

Send source: [apps/web/lib/account-deletion-request.ts](../apps/web/lib/account-deletion-request.ts).

### Mobile content report notification

Deduplicated by report ID.

Send source: [apps/web/lib/account-deletion-request.ts](../apps/web/lib/account-deletion-request.ts).

### Legacy login link template

Retained source template; current email login uses verification codes.

Send source: No current call site.
