import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { SmtpMailer, OutboxMailer, createMailer, type SmtpConfig } from "../src/mailer.js";

interface Fake {
  port: number;
  lines: string[];
  body: () => string;
  creds: () => { user: string; pass: string };
  close: () => Promise<void>;
}

/** A minimal fake SMTP server (plain socket) that records the dialog. */
function startFakeSmtp(opts: { rejectRcpt?: boolean } = {}): Promise<Fake> {
  const lines: string[] = [];
  let body = "";
  let user = "";
  let pass = "";
  const server = createServer((sock) => {
    let inData = false;
    let authStage = 0; // 0 idle, 1 awaiting b64 user, 2 awaiting b64 pass
    let buf = "";
    sock.on("error", () => {});
    sock.write("220 fake ESMTP ready\r\n");
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            sock.write("250 2.0.0 queued\r\n");
          } else {
            body += `${line}\n`;
          }
          continue;
        }
        if (authStage === 1) {
          user = Buffer.from(line, "base64").toString("utf8");
          authStage = 2;
          sock.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (authStage === 2) {
          pass = Buffer.from(line, "base64").toString("utf8");
          authStage = 0;
          sock.write("235 2.7.0 authenticated\r\n");
          continue;
        }
        lines.push(line);
        const u = line.toUpperCase();
        if (u.startsWith("EHLO")) sock.write("250-fake greets you\r\n250-AUTH LOGIN\r\n250 SIZE 10485760\r\n");
        else if (u.startsWith("AUTH LOGIN")) {
          authStage = 1;
          sock.write("334 VXNlcm5hbWU6\r\n");
        } else if (u.startsWith("MAIL FROM")) sock.write("250 2.1.0 ok\r\n");
        else if (u.startsWith("RCPT TO")) sock.write(opts.rejectRcpt ? "550 5.1.1 no such user\r\n" : "250 2.1.5 ok\r\n");
        else if (u === "DATA") {
          inData = true;
          sock.write("354 end data with <CRLF>.<CRLF>\r\n");
        } else if (u === "QUIT") {
          sock.write("221 2.0.0 bye\r\n");
          sock.end();
        } else sock.write("250 ok\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        lines,
        body: () => body,
        creds: () => ({ user, pass }),
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

const cfg = (port: number, over: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: "127.0.0.1",
  port,
  user: "",
  pass: "",
  from: "openpouch <noreply@openpouch.sh>",
  secure: false,
  allowInsecure: true,
  timeoutMs: 5000,
  ...over,
});

describe("SmtpMailer", () => {
  it("runs the full SMTP dialog and delivers the verification link", async () => {
    const fake = await startFakeSmtp();
    const mailer = new SmtpMailer(cfg(fake.port));
    await mailer.sendVerification({ to: "user@example.com", verifyUrl: "https://openpouch.sh/verify?token=abc", accountId: "acct_1" });
    await fake.close();
    expect(fake.lines.some((l) => l.startsWith("EHLO"))).toBe(true);
    expect(fake.lines).toContain("MAIL FROM:<noreply@openpouch.sh>");
    expect(fake.lines).toContain("RCPT TO:<user@example.com>");
    expect(fake.lines).toContain("DATA");
    const body = fake.body();
    expect(body).toContain("To: user@example.com");
    expect(body).toContain("Subject: Verify your openpouch account");
    expect(body).toContain("https://openpouch.sh/verify?token=abc");
  });

  it("authenticates with AUTH LOGIN, sending base64 user + pass", async () => {
    const fake = await startFakeSmtp();
    const mailer = new SmtpMailer(cfg(fake.port, { user: "apikey", pass: "s3cret-token" }));
    await mailer.sendVerification({ to: "x@example.com", verifyUrl: "https://openpouch.sh/v?t=1", accountId: "a" });
    await fake.close();
    expect(fake.lines).toContain("AUTH LOGIN");
    expect(fake.creds()).toEqual({ user: "apikey", pass: "s3cret-token" });
  });

  it("rejects when the server refuses the recipient", async () => {
    const fake = await startFakeSmtp({ rejectRcpt: true });
    const mailer = new SmtpMailer(cfg(fake.port));
    await expect(
      mailer.sendVerification({ to: "nope@example.com", verifyUrl: "https://openpouch.sh/v", accountId: "a" }),
    ).rejects.toThrow(/rcpt/i);
    await fake.close();
  });

  it("refuses to send credentials over an unencrypted connection by default", async () => {
    const fake = await startFakeSmtp();
    const mailer = new SmtpMailer(cfg(fake.port, { user: "me", pass: "pw", allowInsecure: false }));
    await expect(
      mailer.sendVerification({ to: "x@example.com", verifyUrl: "https://openpouch.sh/v", accountId: "a" }),
    ).rejects.toThrow(/unencrypted/i);
    await fake.close();
  });

  it("times out instead of hanging when nothing answers", async () => {
    // a dead port (the fake never started here) → connection error/timeout, not a hang
    const mailer = new SmtpMailer(cfg(1, { timeoutMs: 300 }));
    await expect(
      mailer.sendVerification({ to: "x@example.com", verifyUrl: "https://openpouch.sh/v", accountId: "a" }),
    ).rejects.toThrow(/smtp/i);
  });
});

describe("createMailer", () => {
  it("picks the OutboxMailer spool when no SMTP host is configured (default-safe)", () => {
    expect(createMailer({ smtp: cfg(0, { host: "" }), dataDir: "/tmp" })).toBeInstanceOf(OutboxMailer);
  });
  it("picks the SmtpMailer when an SMTP host is configured", () => {
    expect(createMailer({ smtp: cfg(25, { host: "smtp.example.com" }), dataDir: "/tmp" })).toBeInstanceOf(SmtpMailer);
  });
});
