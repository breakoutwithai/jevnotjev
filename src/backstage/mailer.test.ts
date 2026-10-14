import { expect, test } from "bun:test";
import { isValidEmail, mailConfigured, sendSignInLink, type MailConfig, type MailMessage } from "./mailer.ts";

const LINK = "https://jevnotjev.example/api/auth/link?t=abc";
function recorder(fail = false) {
  const sent: MailMessage[] = [];
  const config: MailConfig = { smtpUser: "hub@example.com", smtpPass: "app-password", from: "Jev!Jev <jev@example.com>", send: async (message) => { sent.push(message); if (fail) throw new Error("smtp down"); } };
  return { sent, config };
}

test("[unit] mail M1 configured send carries from, to, subject and the link", async () => {
  const x = recorder();
  expect(await sendSignInLink(x.config, "lead@example.com", LINK)).toBe(true);
  expect(x.sent).toEqual([{ from: "Jev!Jev <jev@example.com>", to: "lead@example.com", subject: "Your Jev!Jev Backstage sign-in link", text: `Use this sign-in link within 15 minutes. It works once.\n\n${LINK}\n\nIf you did not request it, ignore this email.` }]);
});

test("[unit] mail M2 not configured returns false without sending", async () => {
  for (const missing of ["smtpUser", "smtpPass", "from"] as const) {
    const x = recorder();
    const config: MailConfig = { ...x.config, [missing]: undefined };
    expect(mailConfigured(config)).toBe(false);
    expect(await sendSignInLink(config, "lead@example.com", LINK)).toBe(false);
    expect(x.sent).toHaveLength(0);
  }
  expect(mailConfigured(recorder().config)).toBe(true);
});

test("[unit] mail M3 CR LF recipient or from returns false without sending", async () => {
  const x = recorder();
  for (const email of ["lead@example.com\r\nBcc: evil@example.com", "lead@example.com\nBcc: evil@example.com", "a@example.com, b@example.com", "Lead <lead@example.com>"]) expect(await sendSignInLink(x.config, email, LINK)).toBe(false);
  expect(await sendSignInLink({ ...x.config, from: "Jev <jev@example.com>\r\nBcc: evil@example.com" }, "lead@example.com", LINK)).toBe(false);
  expect(x.sent).toHaveLength(0);
});

test("[unit] mail M4 transport throw returns false", async () => {
  const x = recorder(true);
  expect(await sendSignInLink(x.config, "lead@example.com", LINK)).toBe(false);
  expect(x.sent).toHaveLength(1);
});

test("[unit] mail M5 email validation accepts one plain mailbox only", () => {
  for (const ok of ["lead@example.com", "ok.name+tag@mail-server.co.uk", "o'connor@example.com"]) expect(isValidEmail(ok)).toBe(true);
  for (const bad of ["", "lead", "lead@example", "a@b@example.com", "lead @example.com", "lead@example.com\u0000", "a@example.com;b@example.com", '"q"@example.com']) expect(isValidEmail(bad)).toBe(false);
});
