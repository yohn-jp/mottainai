import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { BootstrapError } from "./errors.js";

/**
 * Resolves and verifies the exact Mottainai source tree a
 * mottainai.managed-package-manifest.v1 manifest entry (#624) names, for
 * handoff to Issue #625's build interface as `mottainaiSource`. This is the
 * boundary #625 explicitly refused to own ("manifest + already-resolved
 * exact source -> Nix generation" only) and #626 exists to fill: no repo
 * checkout, no PATH lookup, no npm global install — only a pinned,
 * verified fetch of the exact tagged release the manifest requests.
 *
 * Modeled on src/local-runtime/artifacts.ts's download/verify/extract
 * patterns (HTTPS-only, host allowlist, streaming size-capped download,
 * tar safety checks), adapted for a source-tree fetch: `sourceSha256` is
 * verified against the NAR hash of the *extracted tree content*, not the
 * archive bytes — GitHub's auto-generated tag archives are not guaranteed
 * byte-stable across gzip implementation changes, only their tree content
 * is, and that also matches how #624/#625 define sourceSha256 (the NAR
 * hash of the resolved build source Nix itself would compute).
 */

export const BOOTSTRAP_TRUSTED_SOURCE_ORIGIN = "https://github.com/yohn-jp/mottainai/archive/refs/tags/" as const;
export const BOOTSTRAP_TRUSTED_REDIRECT_HOSTS = ["github.com", "codeload.github.com"] as const;

const MAX_SOURCE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[-.\w]+)?$/u;

export interface ResolveMottainaiSourceOptions {
  readonly requestedVersion: string;
  readonly expectedSourceSha256: string;
  readonly destinationDirectory: string;
  readonly fetcher?: (url: string) => Promise<ReadableStream<Uint8Array>>;
  readonly narHashOfTree?: (treePath: string) => string;
}

export interface ResolvedMottainaiSource {
  readonly sourcePath: string;
  readonly resolvedTag: string;
  readonly narHashSha256: string;
}

function defaultNarHashOfTree(treePath: string): string {
  const sri = execFileSync("nix", ["hash", "path", "--sri", "--type", "sha256", treePath], { encoding: "utf8" }).trim();
  return execFileSync("nix", [
    "eval",
    "--raw",
    "--expr",
    `builtins.convertHash { hash = ${JSON.stringify(sri)}; hashAlgo = "sha256"; toHashFormat = "base16"; }`,
  ])
    .toString("utf8")
    .trim()
    .toLowerCase();
}

/**
 * Validates a URL (HTTPS-only, host-allowlisted) before handing it to
 * `fetcher`, which is the low-level "give me bytes for this exact URL"
 * injection seam (see `ResolveMottainaiSourceOptions.fetcher`). This
 * function does not itself follow HTTP redirects — that loop lives in
 * `defaultFetcher` below, which drives the actual `fetch()` call with
 * `redirect: "manual"` and re-validates every hop against the same
 * allowlist before following it. Wrapping `fetcher` here still matters even
 * though `defaultFetcher` re-checks each hop internally: it's what makes
 * the initial URL check apply uniformly to injected test fetchers too.
 */
async function fetchWithRedirects(
  url: string,
  fetcher: (url: string) => Promise<ReadableStream<Uint8Array>>,
): Promise<ReadableStream<Uint8Array>> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") {
    throw new BootstrapError("source_resolution_failure", `non-HTTPS redirect not allowed: ${url}`);
  }
  if (!BOOTSTRAP_TRUSTED_REDIRECT_HOSTS.includes(parsedUrl.hostname as (typeof BOOTSTRAP_TRUSTED_REDIRECT_HOSTS)[number])) {
    throw new BootstrapError("source_resolution_failure", `redirect to untrusted host: ${parsedUrl.hostname}`);
  }
  try {
    return await fetcher(url);
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError(
      "source_resolution_failure",
      `Mottainai source download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The raw, single-hop HTTP transport `defaultFetcher`'s manual-redirect
 * loop drives. Defaults to Node's real `fetch` with `redirect: "manual"`
 * (production behavior — never follows a redirect transparently). Tests
 * substitute this with a transport backed by a real `node:http` server so
 * the redirect-following/host-validation *loop itself* runs unmodified
 * against real HTTP status/location-header semantics, without needing a
 * TLS certificate for github.com/codeload.github.com in a hermetic test.
 */
export type RawHttpTransport = (url: string) => Promise<{
  readonly status: number;
  readonly ok: boolean;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly location: string | null;
}>;

async function defaultRawHttpTransport(url: string): ReturnType<RawHttpTransport> {
  const response = await fetch(url, { redirect: "manual" });
  return { status: response.status, ok: response.ok, body: response.body, location: response.headers.get("location") };
}

/**
 * Production fetcher: follows redirect hops in a loop via `transport`
 * (defaults to a real, non-auto-following `fetch`), validating each
 * resolved hop's protocol (HTTPS-only) and host
 * (`BOOTSTRAP_TRUSTED_REDIRECT_HOSTS`) before following it, bounded by
 * `MAX_REDIRECTS`. This is load-bearing: `fetch(url, { redirect: "follow"
 * })` would follow redirects transparently inside the fetch call itself,
 * before this module's allowlist check ever saw the final destination
 * host — exactly the gap this function closes. Mirrors
 * src/local-runtime/artifacts.ts's `fetchWithRedirects`.
 */
export async function defaultFetcher(
  url: string,
  transport: RawHttpTransport = defaultRawHttpTransport,
): Promise<ReadableStream<Uint8Array>> {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount < MAX_REDIRECTS; redirectCount++) {
    const parsedUrl = new URL(currentUrl);
    if (parsedUrl.protocol !== "https:") {
      throw new Error(`non-HTTPS redirect not allowed: ${currentUrl}`);
    }
    if (!BOOTSTRAP_TRUSTED_REDIRECT_HOSTS.includes(parsedUrl.hostname as (typeof BOOTSTRAP_TRUSTED_REDIRECT_HOSTS)[number])) {
      throw new Error(`redirect to untrusted host: ${parsedUrl.hostname}`);
    }
    const response = await transport(currentUrl);
    if (response.status >= 300 && response.status < 400) {
      if (response.location === null) {
        throw new Error(`redirect response missing location header`);
      }
      currentUrl = new URL(response.location, currentUrl).href;
      continue;
    }
    if (!response.ok || response.body === null) {
      throw new Error(`HTTP ${response.status} from ${currentUrl}`);
    }
    return response.body;
  }
  throw new Error(`exceeded maximum redirect count (${MAX_REDIRECTS})`);
}

async function downloadToFile(
  url: string,
  destination: string,
  fetcher: (url: string) => Promise<ReadableStream<Uint8Array>>,
): Promise<void> {
  const body = await fetchWithRedirects(url, fetcher);
  const temporary = `${destination}.download-${process.pid}`;
  let size = 0;
  try {
    await pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.byteLength;
          if (size > MAX_SOURCE_ARCHIVE_BYTES) {
            callback(new Error(`Mottainai source archive exceeds maximum size ${MAX_SOURCE_ARCHIVE_BYTES}`));
            return;
          }
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(temporary, { mode: 0o600 }),
    );
    fs.renameSync(temporary, destination);
  } catch (error) {
    throw new BootstrapError(
      "source_resolution_failure",
      `Mottainai source archive download is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function isSafeArchiveEntry(entry: string): boolean {
  if (entry.length === 0 || entry.length > 512) return false;
  if (!/^[A-Za-z0-9._+/-]+$/u.test(entry)) return false;
  const normalized = path.posix.normalize(entry);
  return normalized === entry && !path.posix.isAbsolute(normalized) && normalized !== ".." && !normalized.startsWith("../");
}

/**
 * Enumerates and type-checks archive entries before extracting (rejects
 * symlinks/special files and unsafe paths), mirroring
 * src/local-runtime/artifacts.ts's extractDownloadedArchive. `--strip-components=1`
 * drops GitHub's auto-generated `<repo>-<tag>/` wrapper directory — the
 * same idiom nix/mottainai.nix's own installPhase already uses for its
 * `pnpm pack` tarball.
 */
function extractSourceArchive(archive: string, destination: string): void {
  let listing: string;
  let typeListing: string;
  try {
    listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    typeListing = execFileSync("tar", ["-tzvf", archive], { encoding: "utf8" });
  } catch (error) {
    throw new BootstrapError(
      "source_resolution_failure",
      `Mottainai source archive cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries = listing.split(/\r?\n/u).filter((entry) => entry.length > 0);
  const typedEntries = typeListing.split(/\r?\n/u).filter((entry) => entry.trim().length > 0);
  if (entries.length !== typedEntries.length) {
    throw new BootstrapError("source_resolution_failure", "Mottainai source archive entries cannot be type-checked");
  }
  for (const [index, rawEntry] of entries.entries()) {
    const mode = typedEntries[index]?.trimStart().charAt(0);
    if (mode !== "-" && mode !== "d") {
      throw new BootstrapError("source_resolution_failure", "Mottainai source archive contains a link or special file");
    }
    const entry = rawEntry.replace(/\r$/u, "").replace(/^\.\/+/, "").replace(/\/+$/u, "");
    if (entry.length === 0) continue;
    if (!isSafeArchiveEntry(entry)) {
      throw new BootstrapError("source_resolution_failure", "Mottainai source archive contains an unsafe path");
    }
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  try {
    execFileSync("tar", ["-xzf", archive, "-C", destination, "--strip-components=1", "--no-same-owner", "--no-same-permissions"], {
      stdio: "pipe",
    });
  } catch (error) {
    throw new BootstrapError(
      "source_resolution_failure",
      `Mottainai source archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readPackageVersion(sourceTreePath: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(sourceTreePath, "package.json"), "utf8");
  } catch (error) {
    throw new BootstrapError(
      "source_resolution_failure",
      `resolved Mottainai source has no readable package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BootstrapError(
      "source_resolution_failure",
      `resolved Mottainai source package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new BootstrapError("source_resolution_failure", "resolved Mottainai source package.json has no version field");
  }
  return version;
}

/**
 * Resolves `options.requestedVersion` to a GitHub tag source archive,
 * downloads it (HTTPS-only, host-allowlisted, size-capped, no fallback on
 * failure), extracts it with tar-safety checks, verifies the extracted
 * tree's package.json version matches the request, and verifies the
 * tree's NAR hash matches `options.expectedSourceSha256`. Throws
 * `BootstrapError` with a deterministic code on any failure — never falls
 * back to PATH, npm-global install, or any other unmanaged source.
 */
export async function resolveMottainaiSource(options: ResolveMottainaiSourceOptions): Promise<ResolvedMottainaiSource> {
  if (!VERSION_PATTERN.test(options.requestedVersion)) {
    throw new BootstrapError(
      "source_resolution_failure",
      `requested Mottainai version is not a valid semantic version: ${options.requestedVersion}`,
    );
  }

  const tag = `v${options.requestedVersion}`;
  const url = `${BOOTSTRAP_TRUSTED_SOURCE_ORIGIN}${tag}.tar.gz`;
  const fetcher = options.fetcher ?? defaultFetcher;
  const narHashOfTree = options.narHashOfTree ?? defaultNarHashOfTree;

  fs.mkdirSync(options.destinationDirectory, { recursive: true, mode: 0o700 });
  const archivePath = path.join(options.destinationDirectory, `.mottainai-source-${process.pid}.tar.gz`);
  const extractedPath = path.join(options.destinationDirectory, `mottainai-source-${tag}`);

  try {
    await downloadToFile(url, archivePath, fetcher);
    extractSourceArchive(archivePath, extractedPath);

    const resolvedVersion = readPackageVersion(extractedPath);
    if (resolvedVersion !== options.requestedVersion) {
      throw new BootstrapError(
        "requested_resolved_version_mismatch",
        `resolved Mottainai source tag ${tag} has package.json version ${resolvedVersion}, but manifest requests ${options.requestedVersion}`,
        { requestedVersion: options.requestedVersion, resolvedVersion },
      );
    }

    const narHashSha256 = narHashOfTree(extractedPath).toLowerCase();
    if (narHashSha256 !== options.expectedSourceSha256.toLowerCase()) {
      throw new BootstrapError(
        "source_integrity_mismatch",
        `resolved Mottainai source tree for ${tag} hashes to ${narHashSha256}, but manifest declares sourceSha256=${options.expectedSourceSha256}`,
        { expected: options.expectedSourceSha256, actual: narHashSha256 },
      );
    }

    return { sourcePath: extractedPath, resolvedTag: tag, narHashSha256 };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}
