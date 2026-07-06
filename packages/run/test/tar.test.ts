import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countFiles, extractTarball } from "../src/tar.js";

function tarballOf(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-czf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    tar.stdout.on("data", (c: Buffer) => chunks.push(c));
    tar.on("error", reject);
    tar.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar ${code}`))));
  });
}

describe("tar extraction", () => {
  it("extracts a well-formed tarball and counts files", async () => {
    const src = await mkdtemp(join(tmpdir(), "tar-src-"));
    await writeFile(join(src, "index.html"), "<h1>hi</h1>");
    await mkdir(join(src, "assets"), { recursive: true });
    await writeFile(join(src, "assets", "app.js"), "console.log(1)");

    const buffer = await tarballOf(src);
    const target = await mkdtemp(join(tmpdir(), "tar-out-"));
    await extractTarball(buffer, target);

    expect(await countFiles(target)).toBe(2);
    expect(await readFile(join(target, "index.html"), "utf8")).toBe("<h1>hi</h1>");
  });

  it("normalizes restrictive (umask 077) permissions to world-readable", async () => {
    // Reproduce the 410 bug: a client with umask 077 ships 700 dirs / 600 files.
    // After extraction run-d must make them traversable + readable by the
    // static file server (a different OS user) — otherwise the server 410s.
    const src = await mkdtemp(join(tmpdir(), "tar-perm-"));
    await mkdir(join(src, "sub"), { recursive: true });
    await writeFile(join(src, "index.html"), "<h1>hi</h1>");
    await writeFile(join(src, "sub", "page.html"), "<h1>x</h1>");
    await chmod(join(src, "sub", "page.html"), 0o600);
    await chmod(join(src, "sub"), 0o700);

    const buffer = await tarballOf(src);
    const target = await mkdtemp(join(tmpdir(), "tar-perm-out-"));
    await extractTarball(buffer, target);

    const dirMode = (await stat(join(target, "sub"))).mode & 0o777;
    const fileMode = (await stat(join(target, "sub", "page.html"))).mode & 0o777;
    // "other" must be able to traverse the dir (r+x) and read the file (r).
    expect(dirMode & 0o005).toBe(0o005);
    expect(fileMode & 0o004).toBe(0o004);
  });

  it("rejects a tarball with an absolute-path member", async () => {
    // Build an archive whose member name is absolute; -P preserves the leading slash.
    const src = await mkdtemp(join(tmpdir(), "tar-abs-"));
    await writeFile(join(src, "evil"), "x");
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const tar = spawn("tar", ["-czf", "-", "-P", "-C", src, join(src, "evil")], { stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      tar.stdout.on("data", (c: Buffer) => chunks.push(c));
      tar.on("error", reject);
      tar.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar ${code}`))));
    });
    const target = await mkdtemp(join(tmpdir(), "tar-out2-"));
    await expect(extractTarball(buffer, target)).rejects.toThrow(/unsafe path/);
  });

  it("rejects a tarball containing a symlink that escapes the tree", async () => {
    // The attack: a benignly NAMED symlink whose target points at the on-disk
    // registry (claim/mgmt tokens) two levels up. `tar -tzf` lists only names,
    // so a name-only guard passes it; extraction must still refuse it.
    const src = await mkdtemp(join(tmpdir(), "tar-link-"));
    await writeFile(join(src, "index.html"), "<h1>hi</h1>"); // ≥1 real file
    await symlink("../../registry.json", join(src, "data")); // escaping symlink
    const buffer = await tarballOf(src);

    const target = await mkdtemp(join(tmpdir(), "tar-link-out-"));
    await expect(extractTarball(buffer, target)).rejects.toThrow(/symlink not allowed/);
  });

  it("rejects a decompression bomb before extracting (uncompressed size over the limit)", async () => {
    // A highly compressible payload: 8 MB of zeros gzips tiny but would expand
    // past a small limit. The guard must refuse it before `tar -xzf` writes.
    const src = await mkdtemp(join(tmpdir(), "tar-bomb-"));
    await writeFile(join(src, "big.bin"), Buffer.alloc(8 * 1024 * 1024, 0));
    const buffer = await tarballOf(src);

    const target = await mkdtemp(join(tmpdir(), "tar-bomb-out-"));
    await expect(extractTarball(buffer, target, { maxUnpackedBytes: 1024 * 1024 })).rejects.toThrow(/uncompressed size exceeds/);
    // Nothing was written to the target (the guard runs before extraction).
    expect(await countFiles(target)).toBe(0);
  });

  it("allows a normal archive when under the unpacked-size limit (and when the guard is disabled)", async () => {
    const src = await mkdtemp(join(tmpdir(), "tar-ok-"));
    await writeFile(join(src, "index.html"), "<h1>hi</h1>");
    const buffer = await tarballOf(src);

    const generous = await mkdtemp(join(tmpdir(), "tar-ok-a-"));
    await extractTarball(buffer, generous, { maxUnpackedBytes: 64 * 1024 * 1024 });
    expect(await countFiles(generous)).toBe(1);

    const disabled = await mkdtemp(join(tmpdir(), "tar-ok-b-"));
    await extractTarball(buffer, disabled, { maxUnpackedBytes: 0 }); // 0 = guard off
    expect(await countFiles(disabled)).toBe(1);
  });

  it("rejects an inner-directory symlink too (recursive check)", async () => {
    const src = await mkdtemp(join(tmpdir(), "tar-link2-"));
    await mkdir(join(src, "assets"), { recursive: true });
    await writeFile(join(src, "assets", "app.js"), "1");
    await symlink("/etc/hostname", join(src, "assets", "leak")); // absolute target
    const buffer = await tarballOf(src);

    const target = await mkdtemp(join(tmpdir(), "tar-link2-out-"));
    await expect(extractTarball(buffer, target)).rejects.toThrow(/symlink not allowed/);
  });
});
