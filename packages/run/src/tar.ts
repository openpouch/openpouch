import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";

/**
 * Extract a gzipped tarball (buffer) into an already-isolated target dir.
 *
 * Safety is portable (no reliance on version-specific GNU flags): we first
 * LIST the archive and reject any member with an absolute path or a ".."
 * segment, then extract, then reject any symlink that reached disk. The caller
 * hands us a fresh per-slug directory, so even a benign archive can't collide
 * with another deployment. No user code runs — files are only unpacked and
 * served statically (M1 threat model: minimal foreign-execution surface).
 *
 * SYMLINKS ARE REJECTED. The static file server (Caddy `file_server`) follows
 * symlinks out of the site root by default, and the on-disk registry
 * (claim/mgmt tokens) plus other tenants' sites live above that root. A member
 * name like `x` carrying a symlink target of `../../registry.json` passes a
 * name-only check (the listing shows only names, never link targets) and would,
 * once served, leak platform-wide capabilities. A static upload never needs a
 * symlink, so we reject the whole deploy if one is present rather than trying to
 * decide which targets are "safe" (targets are attacker-controlled + racy).
 */

function runTar(args: string[], input: Buffer, capture: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", args, { stdio: ["pipe", capture ? "pipe" : "ignore", "pipe"] });
    let stdout = "";
    let stderr = "";
    if (capture && tar.stdout) tar.stdout.on("data", (c) => (stdout += String(c)));
    tar.stderr?.on("data", (c) => (stderr += String(c)));
    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`tar exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
    tar.stdin?.write(input);
    tar.stdin?.end();
  });
}

function isUnsafeMember(name: string): boolean {
  if (name.startsWith("/")) return true;
  return name.split("/").some((seg) => seg === "..");
}

/**
 * Reject a gzip "bomb" BEFORE it can touch disk. run-d caps the COMPRESSED
 * upload (`readBody`), but gzip's ratio is unbounded — a ~25 MB upload can
 * expand to many GB and fill the shared volume during `tar -xzf` (the disk
 * watchdog only warns at 85 %), a DoS for every tenant from one anonymous
 * request. We stream-decompress the buffer counting output bytes and abort the
 * moment the uncompressed size crosses `limit` — O(1) memory, and the failure
 * happens before extraction writes anything. (`tar -tzf`/`-xzf` themselves
 * decompress the whole stream to walk headers, so this also short-circuits that
 * work.) `limit <= 0` disables the guard.
 */
function assertUnpackedSizeWithinLimit(buffer: Buffer, limit: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!(limit > 0)) return resolve();
    const gunzip = createGunzip();
    let total = 0;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      gunzip.destroy(); // stop decompressing immediately; any resulting error is ignored below
      err ? reject(err) : resolve();
    };
    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) finish(new Error(`archive too large: uncompressed size exceeds ${limit} bytes`));
    });
    gunzip.on("end", () => finish());
    gunzip.on("error", (e: Error) => finish(e));
    gunzip.end(buffer);
  });
}

export async function extractTarball(buffer: Buffer, targetDir: string, opts?: { maxUnpackedBytes?: number }): Promise<void> {
  // Pass 0: reject a decompression bomb before any tar work / disk write.
  await assertUnpackedSizeWithinLimit(buffer, opts?.maxUnpackedBytes ?? 0);
  // Pass 1: list and validate every member path.
  const listing = await runTar(["-tzf", "-"], buffer, true);
  for (const raw of listing.split("\n")) {
    const name = raw.trim();
    if (name.length === 0) continue;
    if (isUnsafeMember(name)) throw new Error(`unsafe path in archive: ${name}`);
  }
  // Pass 2: extract into the isolated target dir.
  await runTar(["-xzf", "-", "-C", targetDir, "--no-same-owner"], buffer, false);
  // Pass 3: reject symlinks. Portable + robust — we don't parse tar's
  // version-specific verbose type column; we lstat what actually landed. Any
  // symlink (however benign its name) is a capability-escape vector once the
  // tree is served statically, so the whole deploy is refused. The caller
  // removes the temp dir on throw, so nothing symlinked ever reaches a served
  // path.
  const link = await firstSymlink(targetDir);
  if (link) throw new Error(`symlink not allowed in archive: ${link}`);
  // Pass 4: normalize permissions to world-readable. The tarball carries the
  // client's local mode bits; a client with a restrictive umask (077 on many
  // Linux/CI hosts) ships 700 directories. run-d unpacks as `oprun`, but the
  // static file server runs as a different user (e.g. `caddy`) and then cannot
  // traverse a 700 dir -> every request 410s ("preview is gone") even though
  // the deploy reported success. a+rX = read for all, execute (traverse) only
  // on directories; no write bits are granted.
  await makeWorldReadable(targetDir);
}

/**
 * Normalize a directory tree to world-readable (`chmod -R a+rX`): read for all,
 * traverse only on directories, no write bits. The static file server runs as a
 * different user than run-d, so served files MUST be world-readable or every
 * request 410s. Exported so build-on-deploy output (which the build container
 * writes, bypassing the tar extraction's pass 3) gets the same treatment.
 */
export function makeWorldReadable(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("chmod", ["-R", "a+rX", dir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr?.on("data", (c) => (stderr += String(c)));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`chmod exited ${code}: ${stderr.trim().slice(0, 200)}`)),
    );
  });
}

/**
 * Return the path (relative to `root`) of the first symbolic link found under
 * `dir`, or undefined if the tree contains none. Uses `readdir` withFileTypes,
 * whose `isSymbolicLink()` reports the entry itself without following it, so a
 * symlink pointing outside the tree is detected rather than traversed.
 */
async function firstSymlink(dir: string, root: string = dir): Promise<string | undefined> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) return full.startsWith(root + "/") ? full.slice(root.length + 1) : e.name;
    if (e.isDirectory()) {
      const nested = await firstSymlink(full, root);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Count regular files under a directory (recursive). */
export async function countFiles(dir: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) total += await countFiles(join(dir, e.name));
    else if (e.isFile()) total += 1;
  }
  return total;
}
