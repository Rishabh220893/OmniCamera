/**
 * A local stand-in for the e-mail and SMS providers, so the e-mail and SMS alert channels can be tried end to end without an account or a bill.
 *
 *   npm run alert-sandbox
 *
 * It starts a fake SMTP server (port 2525) and a fake SMS gateway (port 8099) on this machine, prints the settings to put in the server's
 * environment, and prints every message it receives. Nothing leaves the computer. It proves the platform's side (rules, recipients, delivery,
 * message text); it does not prove a real provider's account, sender approval or delivery to a phone.
 */
import { startFakeSmtp, startFakeSmsGateway } from '../tests/lab/fakeMessaging.ts';

const smtp = await startFakeSmtp(Number(process.env.SANDBOX_SMTP_PORT) || 2525);
const sms = await startFakeSmsGateway('sandbox-token', Number(process.env.SANDBOX_SMS_PORT) || 8099);

console.log(`Alert sandbox running.

Put these in the server's environment (scale.local or the shell), then restart the server:

  SMTP_URL=smtp://127.0.0.1:${smtp.port}
  ALERT_EMAIL_FROM=OmniSee Alerts <alerts@omnisee.local>
  SMS_GATEWAY_URL=${sms.url}
  SMS_GATEWAY_TOKEN=sandbox-token

Then: Events > Rules > New rule > tick "Send an e-mail" and/or "Send an SMS", enter any address (chief@example.com) and any number
(+919876543210), create the rule, and press its Send (test) button, or push an event that matches it. The messages appear below.
Press Ctrl+C to stop.
`);

let seenMail = 0, seenSms = 0;
setInterval(() => {
  for (; seenMail < smtp.mails.length; seenMail++) {
    const m = smtp.mails[seenMail];
    console.log(`\n--- E-MAIL ${seenMail + 1} -------------------------------------\nFrom:    ${m.from}\nTo:      ${m.to.join(', ')}\nSubject: ${m.subject}\n\n${m.text}\n`);
  }
  for (; seenSms < sms.messages.length; seenSms++) {
    const m = sms.messages[seenSms];
    console.log(`\n--- SMS ${seenSms + 1} -------------------------------------\nTo:      ${m.to}${m.from ? `\nFrom:    ${m.from}` : ''}\nMessage: ${m.message}\n`);
  }
}, 300);
process.on('SIGINT', async () => { await smtp.close(); await sms.close(); process.exit(0); });
