import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Mailer seam (B3). The email-signup path needs to deliver a verification link.
 * Two implementations ship:
 *   - OutboxMailer  — default; spools messages to disk (no provider needed).
 *   - SmtpMailer    — real delivery over SMTP, dependency-free (node:net/node:tls),
 *                     so @openpouch/run stays zero-dependency. Works with any SMTP
 *                     provider (Resend, Postmark, SES, Mailgun, Gmail, …) — no lock-in.
 * `createMailer` picks SmtpMailer when an SMTP host is configured, else OutboxMailer.
 * Tests pass a capturing fake via the server's `deps.mailer`.
 */

export interface VerificationMail {
  to: string;
  /** The link that activates the account (carries the one-time token). */
  verifyUrl: string;
  accountId: string;
}

/** T-7 heads-up before an account-owned app expires for inactivity (D25). */
export interface InactivityWarningMail {
  to: string;
  slug: string;
  /** Public URL of the app — any visit resets the clock. */
  appUrl: string;
  /** When the app will expire if it stays unvisited (ISO). */
  expiresAt: string;
}

/** One-time link that ties an existing preview to an EXISTING account (claim page path). */
export interface BindConfirmMail {
  to: string;
  slug: string;
  appUrl: string;
  /** Single-use confirm link (24h). */
  confirmUrl: string;
}

export interface Mailer {
  sendVerification(mail: VerificationMail): Promise<void>;
  sendInactivityWarning(mail: InactivityWarningMail): Promise<void>;
  sendBindConfirm(mail: BindConfirmMail): Promise<void>;
}

/**
 * Placeholder mailer: appends each message to <dataDir>/mail.outbox.jsonl (the
 * local mail spool — equivalent to the email that would be sent), instead of
 * delivering real email. Lives in the protected data dir. The default until an
 * SMTP host is configured (see SmtpMailer / createMailer).
 */
export class OutboxMailer implements Mailer {
  constructor(private readonly dataDir: string) {}
  private async spool(entry: Record<string, unknown>): Promise<void> {
    await appendFile(join(this.dataDir, "mail.outbox.jsonl"), `${JSON.stringify(entry)}\n`, "utf8").catch(() => {});
  }
  async sendVerification(mail: VerificationMail): Promise<void> {
    await this.spool({ at: new Date().toISOString(), type: "verification", to: mail.to, accountId: mail.accountId, verifyUrl: mail.verifyUrl });
  }
  async sendInactivityWarning(mail: InactivityWarningMail): Promise<void> {
    await this.spool({ at: new Date().toISOString(), type: "inactivity-warning", to: mail.to, slug: mail.slug, appUrl: mail.appUrl, expiresAt: mail.expiresAt });
  }
  async sendBindConfirm(mail: BindConfirmMail): Promise<void> {
    await this.spool({ at: new Date().toISOString(), type: "bind-confirm", to: mail.to, slug: mail.slug, appUrl: mail.appUrl, confirmUrl: mail.confirmUrl });
  }
}

/** SMTP connection settings. Secrets (user/pass) come from env, never the repo. */
export interface SmtpConfig {
  /** SMTP host. Empty string → mailer is dormant (createMailer falls back to OutboxMailer). */
  host: string;
  /** Port. 465 = implicit TLS (set secure); 587/25 = plain + STARTTLS upgrade. */
  port: number;
  user: string;
  pass: string;
  /** Envelope + From header, e.g. `openpouch <noreply@openpouch.sh>`. */
  from: string;
  /** Implicit TLS from the first byte (port 465). Otherwise plain then STARTTLS. */
  secure: boolean;
  /**
   * Escape hatch for tests / trusted local relays: permit AUTH and delivery over
   * a connection that never reached TLS. Default false — we refuse to send
   * credentials in the clear.
   */
  allowInsecure?: boolean;
  /** Whole-operation timeout. Default 15s. */
  timeoutMs?: number;
}

/** Extract the bare address from `Name <addr@host>` (or pass through a bare addr). */
function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim();
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** SMTP dot-stuffing: a line starting with '.' must be escaped to '..'. */
function dotStuff(message: string): string {
  return message
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

/** Find the end index of the first complete SMTP response in `buffer`, or -1. */
function completeResponseEnd(buffer: string): number {
  let from = 0;
  for (;;) {
    const nl = buffer.indexOf("\r\n", from);
    if (nl < 0) return -1;
    const line = buffer.slice(from, nl);
    if (/^\d{3} /.test(line)) return nl + 2; // final line: code then a space
    from = nl + 2; // a `code-` continuation line; keep scanning
  }
}

function parseResponse(raw: string): { code: number; text: string } {
  const lines = raw.split("\r\n").filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? "000 ";
  return { code: Number(last.slice(0, 3)), text: lines.map((l) => l.slice(4)).join(" ") };
}

function buildMessage(from: string, to: string, subject: string, bodyLines: string[]): string {
  const domain = addressOf(from).split("@")[1] ?? "openpouch.sh";
  const messageId = `<${randomBytes(12).toString("hex")}@${domain}>`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${bodyLines.join("\r\n")}`;
}

function buildVerificationMessage(from: string, mail: VerificationMail): string {
  return buildMessage(from, mail.to, "Verify your openpouch account", [
    "Welcome to openpouch.",
    "",
    "Confirm this email to activate your account and get your API key:",
    "",
    mail.verifyUrl,
    "",
    "If you didn't request this, you can safely ignore this email.",
  ]);
}

function buildInactivityWarningMessage(from: string, mail: InactivityWarningMail): string {
  const when = new Date(mail.expiresAt);
  const whenText = Number.isFinite(when.getTime()) ? when.toUTCString() : mail.expiresAt;
  return buildMessage(from, mail.to, `Your app ${mail.slug} expires in about 7 days unless it's visited`, [
    "Your openpouch app hasn't received a single request in a long while:",
    "",
    `  ${mail.appUrl}`,
    "",
    `Without a visit it will expire on ${whenText}.`,
    "",
    "Any request to the URL keeps it live — the clock resets automatically.",
    `No longer need it? No action required; it will clean itself up. To remove it right away: openpouch delete ${mail.slug}`,
  ]);
}

function buildBindConfirmMessage(from: string, mail: BindConfirmMail): string {
  return buildMessage(from, mail.to, `Tie ${mail.slug} to your openpouch account`, [
    "Someone — probably you — asked to tie this preview to your openpouch account:",
    "",
    `  ${mail.appUrl}`,
    "",
    "Confirm to keep it live while it's used (instead of expiring on a timer):",
    "",
    `  ${mail.confirmUrl}`,
    "",
    "The link works once and expires in 24 hours. If this wasn't you, ignore this email — nothing changes.",
  ]);
}

/** Deliver one message over SMTP. Resolves on a 250 for the body, rejects otherwise. */
function smtpDeliver(config: SmtpConfig, to: string, message: string): Promise<void> {
  const timeoutMs = config.timeoutMs ?? 15_000;
  return new Promise<void>((resolve, reject) => {
    let socket: Socket;
    let buffer = "";
    let waiter: ((r: { code: number; text: string }) => void) | null = null;
    let settled = false;
    let tlsActive = config.secure;

    const cleanup = () => {
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
    };
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`smtp: ${msg}`));
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs);

    const pump = () => {
      const end = completeResponseEnd(buffer);
      if (end < 0 || !waiter) return;
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end);
      const w = waiter;
      waiter = null;
      w(parseResponse(raw));
    };
    const attach = (s: Socket) => {
      s.on("data", (d: Buffer) => {
        buffer += d.toString("utf8");
        pump();
      });
      s.on("error", (e: Error) => fail(e.message));
      s.on("close", () => fail("connection closed by server"));
    };
    const read = () =>
      new Promise<{ code: number; text: string }>((res) => {
        waiter = res;
        pump();
      });
    const send = (line: string) => socket.write(`${line}\r\n`);
    const expect = async (want: number, ctx: string) => {
      const r = await read();
      if (r.code !== want) throw new Error(`${ctx}: expected ${want}, got ${r.code} ${r.text}`.trim());
      return r;
    };
    const ehlo = async () => {
      send(`EHLO ${hostname() || "localhost"}`);
      const r = await read();
      if (r.code !== 250) throw new Error(`ehlo: ${r.code} ${r.text}`.trim());
      return r.text.toUpperCase();
    };
    const upgrade = (plain: Socket): Promise<Socket> =>
      new Promise((res, rej) => {
        plain.removeAllListeners("data");
        plain.removeAllListeners("error");
        plain.removeAllListeners("close");
        const secured = tlsConnect({ socket: plain, servername: config.host }, () => res(secured));
        secured.on("error", (e) => rej(e));
      });

    (async () => {
      try {
        socket = config.secure
          ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
          : netConnect({ host: config.host, port: config.port });
        attach(socket);
        await expect(220, "greeting");
        let caps = await ehlo();
        if (!tlsActive && caps.includes("STARTTLS")) {
          send("STARTTLS");
          await expect(220, "starttls");
          buffer = "";
          socket = await upgrade(socket);
          tlsActive = true;
          attach(socket);
          caps = await ehlo();
        }
        if (config.user) {
          if (!tlsActive && !config.allowInsecure) {
            throw new Error("refusing to AUTH over an unencrypted connection — use port 465 (secure) or a STARTTLS server");
          }
          send("AUTH LOGIN");
          await expect(334, "auth");
          send(b64(config.user));
          await expect(334, "auth-user");
          send(b64(config.pass));
          await expect(235, "auth-pass");
        }
        send(`MAIL FROM:<${addressOf(config.from)}>`);
        await expect(250, "mail-from");
        send(`RCPT TO:<${to}>`);
        const rcpt = await read();
        if (rcpt.code !== 250 && rcpt.code !== 251) throw new Error(`rcpt-to: ${rcpt.code} ${rcpt.text}`.trim());
        send("DATA");
        await expect(354, "data");
        socket.write(`${dotStuff(message)}\r\n.\r\n`);
        await expect(250, "message-accepted");
        send("QUIT");
        done();
      } catch (e) {
        fail((e as Error).message);
      }
    })();
  });
}

/** Real mailer: delivers account/lifecycle mails over SMTP (dependency-free). */
export class SmtpMailer implements Mailer {
  constructor(private readonly config: SmtpConfig) {}
  async sendVerification(mail: VerificationMail): Promise<void> {
    await smtpDeliver(this.config, mail.to, buildVerificationMessage(this.config.from, mail));
  }
  async sendInactivityWarning(mail: InactivityWarningMail): Promise<void> {
    await smtpDeliver(this.config, mail.to, buildInactivityWarningMessage(this.config.from, mail));
  }
  async sendBindConfirm(mail: BindConfirmMail): Promise<void> {
    await smtpDeliver(this.config, mail.to, buildBindConfirmMessage(this.config.from, mail));
  }
}

/**
 * Pick the mailer from config: a configured SMTP host → real SmtpMailer,
 * otherwise the OutboxMailer spool (default-safe — no provider needed).
 */
export function createMailer(opts: { smtp: SmtpConfig; dataDir: string }): Mailer {
  return opts.smtp.host.trim() !== "" ? new SmtpMailer(opts.smtp) : new OutboxMailer(opts.dataDir);
}
