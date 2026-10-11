# E-mail and SMS alerts: how they work and how to set them up

## Who gets the message, and where that is set

**Recipients are typed into each alert rule. The platform has no other list.** It does not read addresses or phone numbers from user profiles, departments or cameras.

- Open **Events > Rules > New rule** (or edit one). Under "Tell people":
  - tick **Send an e-mail** and enter up to 5 addresses, comma separated (`chief@police.example, duty@police.example`);
  - tick **Send an SMS** and enter up to 5 phone numbers in international form with the plus sign (`+919876543210`);
  - and/or tick **Send to a web address (webhook)**, or **Keep the recording around the event**.
- The alert always also appears in the Alerts list. A rule with several channels uses all of them; one failing channel does not stop the others.
- A rule fires for the events it matches (types, severity, tags, plates, department, schedule), at most once per "fold repeats" window per thing (e.g. per plate).
- **Incidents** use the same rules: a new incident becomes an `incident.opened` event, so a department writes one rule ("type: incident opened, e-mail the control room") and is told when an incident reaches its cameras.
- The **Send test** button on a rule sends a test event through that rule's channels and shows the result or the error. It never places a real recording hold.

The two channels are greyed out, with the reason, when the server has not been given a provider (below).

## Setting up e-mail (SMTP)

The server sends mail through any SMTP account. Set, in the server's environment (`scale.local` or the host's settings, **not** in the browser), then restart:

| Setting | Meaning |
|---|---|
| `SMTP_URL` | `smtps://USER:PASSWORD@HOST:465` (TLS from the start) or `smtp://USER:PASSWORD@HOST:587` (STARTTLS). Percent-encode special characters in the user and password (`@` is `%40`). |
| `ALERT_EMAIL_FROM` | The sender shown, e.g. `OmniSee Alerts <alerts@yourdomain.gov.in>`. Most providers require it to be an address or domain you have verified with them. |
| `ALERT_EMAIL_DOMAINS` | Optional. `police.gov.in,municipal.gov.in`: a rule can then only mail those domains (stops a rule being used to mail outsiders). |
| `ALERT_EMAIL_MAX_PER_HOUR` | Optional, default 60. A rule that fires in a loop cannot mail without end; the alert says "limit for this hour reached". |

**Getting the SMTP details** (any one provider will do):
- **Your organisation's mail server**: ask the mail administrator for host, port, a service account and password (best for a government deployment: the mail stays inside).
- **Gmail / Google Workspace**: `smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465`. Needs 2-step verification on and an **App password** (Google Account > Security > App passwords); the normal password does not work.
- **Microsoft 365**: host `smtp.office365.com`, port 587; SMTP AUTH must be enabled for the account by the administrator.
- **SendGrid**: host `smtp.sendgrid.net`, port 587, user `apikey`, password = an API key with "Mail Send" permission.
- **Amazon SES / Brevo / others**: the provider's SMTP settings page gives host, port and credentials.

Mail goes out as plain text: the severity and title as the subject, then camera, department, time (UTC), what happened, the rule, and the alert id.

## Setting up SMS

The platform sends SMS through an **HTTPS gateway** with this exact shape, one call per number:

```
POST <SMS_GATEWAY_URL>
Authorization: Bearer <SMS_GATEWAY_TOKEN>
Content-Type: application/json
{ "to": "+919876543210", "from": "OMNISEE", "message": "[CRITICAL] Watchlist plate GJ05AB1234 seen - Gate 7, 09:58 UTC" }
```

Any 2xx is success; anything else is reported against the number (shortened). The text is one short message.

| Setting | Meaning |
|---|---|
| `SMS_GATEWAY_URL` | The gateway endpoint; must be `https://` (a gateway on this same machine may be `http://localhost`, for the sandbox). |
| `SMS_GATEWAY_TOKEN` | The bearer token the gateway expects. |
| `SMS_FROM` | Optional sender id. |
| `ALERT_SMS_MAX_PER_HOUR` | Optional, default 30. |

**Getting a gateway.** This is the part that needs your decision. SMS providers do not share one API:
- A provider whose API is exactly the shape above (or an internal state gateway) works directly: ask them for the endpoint and a token.
- **Most commercial providers (Twilio, MSG91, Fast2SMS, Textlocal and similar) use their own request formats**, so they need a small adapter in front that accepts the call above and forwards it in their format. Writing one for the provider you choose is a few dozen lines; tell us the provider and we will add it.
- **In India, commercial SMS must follow TRAI DLT rules**: the sender id and the message template have to be registered with the provider first. The alert text is fixed by the platform, so register a template that matches it, or ask for a template-based adapter.
- Real SMS costs money per message and the account usually needs verification before it can send to arbitrary numbers.

## Trying it without any account (sandbox)

```
npm run alert-sandbox
```

starts a fake SMTP server (port 2525) and a fake SMS gateway (port 8099) on this computer, prints the settings to use, and prints every message it receives. Put the printed `SMTP_URL`, `ALERT_EMAIL_FROM`, `SMS_GATEWAY_URL`, `SMS_GATEWAY_TOKEN` in the environment, restart the server, create a rule with an e-mail and an SMS recipient, and press **Send test**. The messages appear in the sandbox window. Nothing leaves the computer.

This proves the platform's side: rules, recipients, delivery, message text, limits. It does not prove a real provider's account, sender approval or delivery to a phone.

## What is verified

`tests/alertChannels.test.ts` (11 tests): the rule validation, domain list, hourly limits, message text, a refusal by the mail server, one failing channel not stopping others, incident announcements, and the real transports: **real nodemailer over a real socket** to a fake SMTP server (sender, recipients, subject and an uncorrupted body arrive) and **real HTTP** to a fake SMS gateway (bearer token, one message per number, a wrong token reported as `HTTP 401`).

**Not verified:** any real mail provider (Gmail, Microsoft 365, SES, the department's server) or real SMS gateway; STARTTLS and login on a real server (the sandbox has neither); delivery to a real inbox or phone; DLT registration.
