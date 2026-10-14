import { createTransport } from "nodemailer";

export interface MailMessage { readonly from: string; readonly to: string; readonly subject: string; readonly text: string }
/** Transport seam: production sends over Gmail SMTP; tests pass a recorder. */
export type MailSend = (message: MailMessage) => Promise<void>;

export interface MailConfig {
  readonly smtpUser?: string | undefined;
  readonly smtpPass?: string | undefined;
  readonly from?: string | undefined;
  readonly dailyLimit?: number | undefined;
  readonly domainDailyLimit?: number | undefined;
  readonly send?: MailSend;
}

/** Mail is ready only when the Gmail account, its app password and the From address are all set. */
export function mailConfigured(config: MailConfig | undefined): boolean { return Boolean(config?.smtpUser && config.smtpPass && config.from); }

/** One plain mailbox, no control characters, separators or display name. nodemailer does not reject a CR LF injected recipient, so this runs before it. */
export function isValidEmail(value: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(value) || /[\s,;<>()[\]\\"]/.test(value)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(value);
}

/** Gmail SMTP over implicit TLS on 465, authenticated with an app password. From must be the account or a verified send-as alias. */
export function gmailSend(user: string, pass: string): MailSend {
  const transporter = createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 });
  return async (message) => { await transporter.sendMail(message); };
}

/** Plain-text Gmail SMTP delivery. The caller owns token lifecycle and handles provider failure; this never throws. */
export async function sendSignInLink(config: MailConfig, email: string, link: string): Promise<boolean> {
  if (!config.smtpUser || !config.smtpPass || !config.from) return false;
  const subject = "Your Jev!Jev Backstage sign-in link";
  if (!isValidEmail(email) || /[\r\n]/.test(subject) || /[\r\n]/.test(config.from)) return false;
  try {
    await (config.send ?? gmailSend(config.smtpUser, config.smtpPass))({ from: config.from, to: email, subject, text: `Use this sign-in link within 15 minutes. It works once.\n\n${link}\n\nIf you did not request it, ignore this email.` });
    return true;
  } catch { return false; }
}
