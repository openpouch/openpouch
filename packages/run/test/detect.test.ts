import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyUpload } from "../src/detect.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oprun-detect-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

describe("classifyUpload", () => {
  it("plain files (no package.json) are static", async () => {
    const dir = await fixture({ "index.html": "<h1>hi</h1>" });
    expect(await classifyUpload(dir)).toEqual({ kind: "static" });
  });

  it("a scripts.start makes it dynamic via npm start", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ name: "api", scripts: { start: "node server.js" } }), "server.js": "" });
    const c = await classifyUpload(dir);
    expect(c.kind).toBe("dynamic");
    if (c.kind === "dynamic") {
      expect(c.startCmd).toBe("npm start");
      expect(c.reason).toBe("scripts.start");
    }
  });

  it("a main entry that exists makes it dynamic via node <main>", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ name: "api", main: "app.js" }), "app.js": "" });
    const c = await classifyUpload(dir);
    expect(c.kind).toBe("dynamic");
    if (c.kind === "dynamic") expect(c.startCmd).toBe("node app.js");
  });

  it("surfaces a build command when package.json has a build script (build-on-deploy, L9)", async () => {
    const dir = await fixture({
      "package.json": JSON.stringify({ name: "shop", scripts: { start: "node server.js", build: "vite build" } }),
      "server.js": "",
    });
    const c = await classifyUpload(dir);
    expect(c.kind).toBe("dynamic");
    if (c.kind === "dynamic") expect(c.buildCmd).toBe("npm run build");
  });

  it("omits the build command when there is no build script", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ name: "api", scripts: { start: "node server.js" } }), "server.js": "" });
    const c = await classifyUpload(dir);
    expect(c.kind).toBe("dynamic");
    if (c.kind === "dynamic") expect(c.buildCmd).toBeUndefined();
  });

  it("classifies an unbuilt SPA (build script + dev index.html, no server) as static-build (L9)", async () => {
    const dir = await fixture({
      "package.json": JSON.stringify({ name: "spa", scripts: { build: "vite build" } }),
      "index.html": '<!doctype html><script type="module" src="/src/main.jsx"></script>',
    });
    const c = await classifyUpload(dir);
    expect(c.kind).toBe("static-build");
    if (c.kind === "static-build") {
      expect(c.buildCmd).toBe("npm run build");
      expect(c.outputDirs).toEqual(["dist", "build", "out"]);
    }
  });

  it("a build script + src/ dir (no index.html, no server) is static-build", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ name: "spa", scripts: { build: "tsc" } }) });
    await mkdir(join(dir, "src"), { recursive: true });
    expect((await classifyUpload(dir)).kind).toBe("static-build");
  });

  it("a build script with NO SPA markers stays static (e.g. a prebuilt site)", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ name: "site", scripts: { build: "x" } }), "index.html": "<h1>prebuilt</h1>" });
    expect((await classifyUpload(dir)).kind).toBe("static");
  });

  it("a server entry takes precedence over static-build (dynamic, even with a build script + src/)", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ name: "app", scripts: { start: "node server.js", build: "vite build" } }), "server.js": "" });
    await mkdir(join(dir, "src"), { recursive: true });
    const c = await classifyUpload(dir);
    expect(c.kind).toBe("dynamic"); // has a server → built+run as a container, not static
    if (c.kind === "dynamic") expect(c.buildCmd).toBe("npm run build");
  });

  it("a conventional entry file makes it dynamic when no start/main", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ name: "api" }), "server.js": "" });
    const c = await classifyUpload(dir);
    expect(c.kind).toBe("dynamic");
    if (c.kind === "dynamic") expect(c.startCmd).toBe("node server.js");
  });

  it("package.json with no start/main/entry is static (e.g. a built site)", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ name: "site", dependencies: { react: "*" } }), "index.html": "<h1>x</h1>" });
    expect(await classifyUpload(dir)).toEqual({ kind: "static" });
  });

  it("ignores a main that points outside the upload", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ name: "x", main: "../../etc/passwd" }) });
    expect(await classifyUpload(dir)).toEqual({ kind: "static" });
  });

  it("malformed package.json is treated as static (fail-safe)", async () => {
    const dir = await fixture({ "package.json": "{ not json", "server.js": "" });
    expect(await classifyUpload(dir)).toEqual({ kind: "static" });
  });

  it("reports a lockfile when present (npm ci is usable)", async () => {
    const withLock = await fixture({ "package.json": JSON.stringify({ scripts: { start: "node ." } }), "package-lock.json": "{}" });
    const a = await classifyUpload(withLock);
    expect(a.kind === "dynamic" && a.hasLockfile).toBe(true);

    const noLock = await fixture({ "package.json": JSON.stringify({ scripts: { start: "node ." } }) });
    const b = await classifyUpload(noLock);
    expect(b.kind === "dynamic" && b.hasLockfile).toBe(false);
  });
});
