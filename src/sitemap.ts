// Reads the sitemap of a site and the pages it lists, for importing articles (POST /api/v1/sites/:id/articles/sitemap
// and /import). Workers has no DOMParser, so the XML and HTML are read with small linear scans and regular
// expressions that only use negated character classes, so that a hostile document cannot make them backtrack.
// Every request goes through the fetcher given by the caller, so that the tests can replace the network.

import { normalizeDisplayName } from "./routes/api";
import { MAX_ARTICLES_PER_SITE, normalizeArticleUrl, TITLE_MAX } from "./records/validate";
import { isValidDate } from "./sync/dates";

const USER_AGENT = "Querune (+https://github.com/i2bskn/querune)";
const SITEMAP_ACCEPT = "application/xml, text/xml;q=0.9, */*;q=0.1";
const PAGE_ACCEPT = "text/html, application/xhtml+xml;q=0.9, */*;q=0.1";

// One fetch, its redirects and the reading of its body each get this long.
const FETCH_TIMEOUT_MS = 10_000;
// Redirects followed by hand, so that each hop is checked against the origin of the site and counted.
const MAX_REDIRECTS = 2;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// The limits of one request. The free plan of Workers allows 50 subrequests per request, and these keep well below
// it. CPU time is not guaranteed on the free plan: a large sitemap may exceed it there.
export const SITEMAP_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_CHILD_SITEMAPS = 10;
export const MAX_SITEMAP_URLS = 5000;
export const SITEMAP_FETCH_BUDGET = 25;
export const SITEMAP_DEADLINE_MS = 25_000;
export const PAGE_MAX_BYTES = 256 * 1024;
export const MAX_IMPORT_URLS = 10;
export const IMPORT_FETCH_BUDGET = 35;
export const IMPORT_DEADLINE_MS = 40_000;
export const IMPORT_CONCURRENCY = 5;
// The bytes of a page where <meta charset> is looked for.
const CHARSET_SNIFF_BYTES = 1024;

export const importMessages = {
  network: "ページを取得できませんでした（応答がありません）",
  notHtml: "HTML のページではありません",
  offsite: "サイトの外へリダイレクトされました",
  redirects: "リダイレクトが多すぎます",
  charset: "UTF-8 以外の文字コードのページは取り込めません",
  limit: `記事は 1 サイトにつき ${MAX_ARTICLES_PER_SITE} 件まで登録できます`,
  budget: "一度に取得できる数を超えました。もう一度取り込んでください",
} as const;

export function pageHttpMessage(status: number): string {
  return `ページを取得できませんでした（HTTP ${status}）`;
}

export const sitemapMessages = {
  network: "サイトマップを取得できませんでした（応答がありません）",
  offsite: importMessages.offsite,
  redirects: importMessages.redirects,
  tooLarge: "サイトマップが大きすぎます（5 MB まで）",
  unreadable: "サイトマップとして読めませんでした。sitemap.xml の URL か確認してください",
} as const;

export function sitemapHttpMessage(status: number): string {
  return `サイトマップを取得できませんでした（HTTP ${status}）`;
}

// The default fetcher looks up the global fetch on each call (not when this module loads), so that a test can
// replace it with vi.spyOn(globalThis, "fetch").
const globalFetcher: typeof fetch = (input, init) => fetch(input, init);

// The fetches left for one request, shared by everything that request fetches. Each hop counts as one.
export type FetchBudget = { remaining: number };

type FetchFailure =
  | { kind: "http"; status: number }
  | { kind: "network" }
  | { kind: "offsite" }
  | { kind: "redirects" }
  | { kind: "budget" };

type Fetched = { ok: true; res: Response; url: string; signal: AbortSignal } | { ok: false; failure: FetchFailure };

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Releases a body that is not read, so that the connection is not held until the request ends.
function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}

// GETs url, following up to 2 redirects within origin. Succeeds with a 2xx response other than 204; anything else is
// a failure, and its body is released. Never throws.
async function fetchWithinOrigin(
  url: string,
  origin: string,
  accept: string,
  budget: FetchBudget,
  fetcher: typeof fetch,
): Promise<Fetched> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (originOf(current) !== origin) return { ok: false, failure: { kind: "offsite" } };
    if (budget.remaining <= 0) return { ok: false, failure: { kind: "budget" } };
    budget.remaining--;
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetcher(current, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        signal,
      });
    } catch {
      return { ok: false, failure: { kind: "network" } };
    }
    // res.url is empty for responses made by hand (the tests); it is then the requested URL.
    const responseUrl = res.url === "" ? current : res.url;
    if (originOf(responseUrl) !== origin) {
      discard(res);
      return { ok: false, failure: { kind: "offsite" } };
    }
    if (res.status >= 200 && res.status < 300 && res.status !== 204) {
      return { ok: true, res, url: responseUrl, signal };
    }
    discard(res);
    const location = res.headers.get("Location");
    if (!REDIRECT_STATUSES.has(res.status) || location === null) {
      return { ok: false, failure: { kind: "http", status: res.status } };
    }
    let next: string;
    try {
      const target = new URL(location, responseUrl);
      // The fragment is never sent, and the URL of an article has none.
      target.hash = "";
      next = target.href;
    } catch {
      return { ok: false, failure: { kind: "http", status: res.status } };
    }
    if (hop >= MAX_REDIRECTS) return { ok: false, failure: { kind: "redirects" } };
    current = next;
  }
}

type ReadBody =
  | { ok: true; bytes: Uint8Array; truncated: boolean }
  // The body went over the limit and overflow was asked for.
  | { ok: false; error: "overflow" }
  // The connection failed or timed out while reading.
  | { ok: false; error: "network" }
  // The gzip stream is broken.
  | { ok: false; error: "decode" };

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Reads at most limit bytes of a stream. Past the limit, the rest is cancelled, and the result is either the first
// limit bytes (truncate) or an overflow. Never throws.
async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onOver: "truncate" | "overflow",
  signal: AbortSignal,
  decodeErrors: boolean,
): Promise<ReadBody> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) {
        reader.cancel().catch(() => {});
        return { ok: false, error: "network" };
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) {
        reader.cancel().catch(() => {});
        if (onOver === "overflow") return { ok: false, error: "overflow" };
        chunks.push(value.subarray(0, limit - size));
        size = limit;
        return { ok: true, bytes: concat(chunks, size), truncated: true };
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    reader.cancel().catch(() => {});
    return { ok: false, error: decodeErrors && !signal.aborted ? "decode" : "network" };
  }
  return { ok: true, bytes: concat(chunks, size), truncated: false };
}

// The body, decompressed when it starts with the gzip magic bytes (a .xml.gz sitemap served as is). The first chunks
// are read to look at the magic bytes and replayed in front of the rest.
async function maybeGunzip(
  body: ReadableStream<Uint8Array>,
): Promise<{ ok: true; stream: ReadableStream<Uint8Array>; gzip: boolean } | { ok: false }> {
  const reader = body.getReader();
  const head: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    while (size < 2) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      head.push(chunk.value);
      size += chunk.value.byteLength;
    }
  } catch {
    reader.cancel().catch(() => {});
    return { ok: false };
  }
  const first = concat(head, size);
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      if (size > 0) controller.enqueue(first);
      if (done) controller.close();
    },
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const gzip = size >= 2 && first[0] === 0x1f && first[1] === 0x8b;
  if (!gzip) return { ok: true, stream: replay, gzip };
  // DecompressionStream is typed as taking any BufferSource; it takes the Uint8Array chunks of the body as they are.
  const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  return { ok: true, stream: replay.pipeThrough(gunzip), gzip };
}

// ---------- XML ----------

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const HTML_ENTITIES: Record<string, string> = { ...XML_ENTITIES, nbsp: " " };

// The character of a numeric reference, or null when it is 0, a surrogate or past U+10FFFF.
function codePointChar(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return null;
  if (value >= 0xd800 && value <= 0xdfff) return null;
  return String.fromCodePoint(value);
}

function decodeEntities(text: string, named: Record<string, string>): string {
  return text.replace(/&(?:#([0-9]+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z]+));/g, (match, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined) return codePointChar(Number.parseInt(dec, 10)) ?? match;
    if (hex !== undefined) return codePointChar(Number.parseInt(hex, 16)) ?? match;
    return (name !== undefined && Object.hasOwn(named, name) ? named[name] : undefined) ?? match;
  });
}

// The text of an element: CDATA sections are kept as they are, the rest has its references decoded. Trimmed.
export function xmlText(raw: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const start = raw.indexOf("<![CDATA[", pos);
    if (start === -1) break;
    const end = raw.indexOf("]]>", start + 9);
    if (end === -1) break;
    out += decodeEntities(raw.slice(pos, start), XML_ENTITIES) + raw.slice(start + 9, end);
    pos = end + 3;
  }
  out += decodeEntities(raw.slice(pos), XML_ENTITIES);
  return out.trim();
}

// The date at the start of value (YYYY-MM-DD, then anything such as a time), or null. Time zones are not converted:
// the written date is used.
export function leadingDate(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const date = value.trim().slice(0, 10);
  return isValidDate(date) ? date : null;
}

// The local name of the root element, after the BOM, white space, processing instructions (<?xml ...?>), comments
// and the DOCTYPE. null when there is no start tag.
export function rootElementName(text: string): string | null {
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (pos < text.length && /\s/.test(text.charAt(pos))) pos++;
    if (text.startsWith("<?", pos)) {
      const end = text.indexOf("?>", pos + 2);
      if (end === -1) return null;
      pos = end + 2;
    } else if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      if (end === -1) return null;
      pos = end + 3;
    } else if (text.startsWith("<!", pos)) {
      // The DOCTYPE, with its internal subset if any.
      const bracket = text.indexOf("[", pos);
      const close = text.indexOf(">", pos);
      if (close === -1) return null;
      if (bracket !== -1 && bracket < close) {
        const subsetEnd = text.indexOf("]", bracket);
        if (subsetEnd === -1) return null;
        const after = text.indexOf(">", subsetEnd);
        if (after === -1) return null;
        pos = after + 1;
      } else {
        pos = close + 1;
      }
    } else {
      break;
    }
  }
  const match = /^<(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/.exec(text.slice(pos, pos + 256));
  return match?.[1] ?? null;
}

export type SitemapEntry = { loc: string | null; lastmod: string | null };

// The <loc> and <lastmod> of each <url> (or <sitemap>) element, in order. Elements outside a container are ignored;
// a namespace prefix on the names is allowed.
export function sitemapEntries(text: string, container: "url" | "sitemap"): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const tag = /<(\/?)(?:[A-Za-z_][\w.-]*:)?(url|sitemap|loc|lastmod)(?=[\s/>])[^>]*>/g;
  let entry: SitemapEntry | null = null;
  let open: { name: "loc" | "lastmod"; start: number } | null = null;
  for (let match = tag.exec(text); match !== null; match = tag.exec(text)) {
    const closing = match[1] === "/";
    const name = match[2] as "url" | "sitemap" | "loc" | "lastmod";
    const selfClosing = match[0].endsWith("/>");
    if (name === "url" || name === "sitemap") {
      if (name !== container) continue;
      if (!closing && !selfClosing) {
        entry = { loc: null, lastmod: null };
      } else if (closing && entry !== null) {
        entries.push(entry);
        entry = null;
      }
      open = null;
      continue;
    }
    if (entry === null || selfClosing) continue;
    if (!closing) {
      open = { name, start: match.index + match[0].length };
    } else if (open !== null && open.name === name) {
      const value = xmlText(text.slice(open.start, match.index));
      if (name === "loc") entry.loc ??= value;
      else entry.lastmod ??= value;
      open = null;
    }
  }
  return entries;
}

// ---------- Sitemap ----------

export type SitemapUrlEntry = { url: string; lastmod: string | null };

export type SitemapResult =
  | {
      ok: true;
      urls: SitemapUrlEntry[];
      truncated: boolean;
      skippedUrls: number;
      skippedSitemaps: number;
    }
  | { ok: false; error: "unavailable"; message: string }
  | { ok: false; error: "unreadable"; message: string };

export type SitemapOptions = { fetcher?: typeof fetch; now?: () => number };

function sitemapFailureMessage(failure: FetchFailure): string {
  switch (failure.kind) {
    case "http":
      return sitemapHttpMessage(failure.status);
    case "network":
    case "budget":
      return sitemapMessages.network;
    case "offsite":
      return sitemapMessages.offsite;
    case "redirects":
      return sitemapMessages.redirects;
  }
}

type SitemapDocument = { ok: true; text: string } | { ok: false; error: "fetch"; failure: FetchFailure } | ReadFailure;
type ReadFailure = { ok: false; error: "overflow" | "network" | "decode" };

// Fetches a sitemap and decodes it as UTF-8, within the bytes left of the 5 MB of the request.
async function fetchSitemap(
  url: string,
  origin: string,
  budget: FetchBudget,
  bytes: { remaining: number },
  fetcher: typeof fetch,
): Promise<SitemapDocument> {
  const fetched = await fetchWithinOrigin(url, origin, SITEMAP_ACCEPT, budget, fetcher);
  if (!fetched.ok) return { ok: false, error: "fetch", failure: fetched.failure };
  const { res, signal } = fetched;
  if (res.body === null) return { ok: true, text: "" };
  const stream = await maybeGunzip(res.body);
  if (!stream.ok) return { ok: false, error: "network" };
  const body = await readLimited(stream.stream, bytes.remaining, "overflow", signal, stream.gzip);
  if (!body.ok) {
    if (body.error === "overflow") bytes.remaining = 0;
    return body;
  }
  bytes.remaining -= body.bytes.byteLength;
  return { ok: true, text: new TextDecoder("utf-8").decode(body.bytes) };
}

// Reads the sitemap (a urlset, or a sitemapindex and up to 10 of its urlsets) and returns the URLs of the site in the
// order they are written: normalized, without duplicates, at most 5000. Never throws.
export async function readSitemap(
  sitemapUrl: string,
  origin: string,
  options: SitemapOptions = {},
): Promise<SitemapResult> {
  const fetcher = options.fetcher ?? globalFetcher;
  const now = options.now ?? Date.now;
  const deadline = now() + SITEMAP_DEADLINE_MS;
  const budget: FetchBudget = { remaining: SITEMAP_FETCH_BUDGET };
  const bytes = { remaining: SITEMAP_MAX_BYTES };

  const top = await fetchSitemap(sitemapUrl, origin, budget, bytes, fetcher);
  if (!top.ok) {
    switch (top.error) {
      case "fetch":
        return { ok: false, error: "unavailable", message: sitemapFailureMessage(top.failure) };
      case "overflow":
        return { ok: false, error: "unavailable", message: sitemapMessages.tooLarge };
      case "network":
        return { ok: false, error: "unavailable", message: sitemapMessages.network };
      case "decode":
        return { ok: false, error: "unreadable", message: sitemapMessages.unreadable };
    }
  }

  const urls: SitemapUrlEntry[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let skippedUrls = 0;
  let skippedSitemaps = 0;

  const addUrls = (text: string) => {
    for (const entry of sitemapEntries(text, "url")) {
      const normalized = entry.loc === null ? null : normalizeArticleUrl(entry.loc);
      if (normalized === null || !normalized.ok || normalized.value === null || originOf(normalized.value) !== origin) {
        skippedUrls++;
        continue;
      }
      const url = normalized.value;
      if (seen.has(url)) continue;
      if (urls.length >= MAX_SITEMAP_URLS) {
        truncated = true;
        continue;
      }
      seen.add(url);
      urls.push({ url, lastmod: leadingDate(entry.lastmod) });
    }
  };

  const root = rootElementName(top.text);
  if (root === "urlset") {
    addUrls(top.text);
  } else if (root === "sitemapindex") {
    const children = sitemapEntries(top.text, "sitemap");
    // Set once the bytes, the fetches or the time run out: the remaining children are skipped.
    let exhausted = false;
    for (const [i, child] of children.entries()) {
      if (urls.length >= MAX_SITEMAP_URLS) {
        // The children not read for this are not skipped: truncated tells it.
        truncated = true;
        break;
      }
      if (i >= MAX_CHILD_SITEMAPS || exhausted || now() >= deadline) {
        skippedSitemaps++;
        continue;
      }
      const loc = child.loc === null ? null : normalizeArticleUrl(child.loc);
      if (loc === null || !loc.ok || loc.value === null || originOf(loc.value) !== origin) {
        skippedSitemaps++;
        continue;
      }
      const document = await fetchSitemap(loc.value, origin, budget, bytes, fetcher);
      if (!document.ok) {
        skippedSitemaps++;
        if (document.error === "overflow" || (document.error === "fetch" && document.failure.kind === "budget")) {
          exhausted = true;
        }
        continue;
      }
      // A nested index or an error page served with 200.
      if (rootElementName(document.text) !== "urlset") {
        skippedSitemaps++;
        continue;
      }
      addUrls(document.text);
    }
  } else {
    return { ok: false, error: "unreadable", message: sitemapMessages.unreadable };
  }
  return { ok: true, urls, truncated, skippedUrls, skippedSitemaps };
}

// ---------- Pages ----------

export type Attributes = Record<string, string>;

// The attributes of a start tag, with lowercase names. Values are not decoded.
function attributesOf(tag: string): Attributes {
  const attributes: Attributes = {};
  const pattern = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/g;
  // Skip the tag name.
  const body = tag.replace(/^<[^\s/>]*/, "");
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const name = (match[1] ?? "").toLowerCase();
    if (!Object.hasOwn(attributes, name)) attributes[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function tagsOf(html: string, name: string): Attributes[] {
  const pattern = new RegExp(`<${name}\\b[^>]*>`, "gi");
  return Array.from(html.matchAll(pattern), (match) => attributesOf(match[0]));
}

function attributeIs(attributes: Attributes, name: string, value: string): boolean {
  return attributes[name]?.trim().toLowerCase() === value;
}

// The charset named by a Content-Type value, lowercased, or null.
function charsetOf(contentType: string): string | null {
  const match = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? null;
}

function isUtf8(charset: string | null): boolean {
  return charset === null || charset === "utf-8" || charset === "utf8";
}

// The charset declared by a <meta> in the head of the page, or null.
function metaCharset(head: string): string | null {
  for (const meta of tagsOf(head, "meta")) {
    const charset = meta.charset;
    if (charset !== undefined) return charset.trim().toLowerCase();
    if (attributeIs(meta, "http-equiv", "content-type") && meta.content !== undefined) {
      const named = charsetOf(meta.content);
      if (named !== null) return named;
    }
  }
  return null;
}

// A candidate of the title: white space (\s, including U+00A0) collapsed, trimmed, cut to 200 code points, then
// checked as a display name. null when it is empty or has control characters.
function titleCandidate(value: string): string | null {
  // 400 UTF-16 units hold at least 200 code points; cutting first keeps a huge title cheap.
  const collapsed = value.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX * 2);
  return normalizeDisplayName([...collapsed].slice(0, TITLE_MAX).join(""), TITLE_MAX);
}

// White space (\s, including U+00A0) collapsed to one space, and trimmed.
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// The longest name of the site after a "|" that is still taken as the name of the site, not part of the title.
const SITE_SUFFIX_MAX = 40;

// The title without the name of the site that pages put after it ("Title | Site"). A part after the last "|" or "｜"
// is removed when it is short. A part after " - ", " – ", " — " or " · " is removed only when it starts with
// og:site_name, since those also separate the words of a title. The title is kept when nothing would be left.
export function withoutSiteSuffix(title: string, siteName: string | null): string {
  const pipe = /^(.*\S)\s*[|｜]\s*([^|｜]+)$/s.exec(title);
  if (pipe?.[1] !== undefined && pipe[2] !== undefined && [...pipe[2].trim()].length <= SITE_SUFFIX_MAX) {
    return pipe[1];
  }
  const name = siteName?.trim() ?? "";
  if (name === "") return title;
  for (const separator of [" - ", " – ", " — ", " · "]) {
    const at = title.lastIndexOf(separator);
    if (at > 0 && title.slice(at + separator.length).trim().startsWith(name)) return title.slice(0, at);
  }
  return title;
}

// og:site_name of the page, or null.
function siteNameOf(metas: Attributes[]): string | null {
  for (const meta of metas) {
    if (attributeIs(meta, "property", "og:site_name") && meta.content !== undefined) {
      return collapse(decodeEntities(meta.content, HTML_ENTITIES));
    }
  }
  return null;
}

// The title of a page: og:title, then <title>, then the last segment of the path, then the host name. The name of the
// site after the title is removed (withoutSiteSuffix).
export function extractTitle(html: string, url: string): string {
  const metas = tagsOf(html, "meta");
  const siteName = siteNameOf(metas);
  for (const meta of metas) {
    if (!attributeIs(meta, "property", "og:title") || meta.content === undefined) continue;
    const title = titleCandidate(withoutSiteSuffix(collapse(decodeEntities(meta.content, HTML_ENTITIES)), siteName));
    if (title !== null) return title;
  }
  const titleTag = /<title\b[^>]*>([^<]*)<\/title\s*>/i.exec(html);
  if (titleTag?.[1] !== undefined) {
    const title = titleCandidate(withoutSiteSuffix(collapse(decodeEntities(titleTag[1], HTML_ENTITIES)), siteName));
    if (title !== null) return title;
  }
  const parsed = new URL(url);
  const segment = parsed.pathname.split("/").filter((part) => part !== "").at(-1);
  if (segment !== undefined) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Kept as it is.
    }
    const title = titleCandidate(decoded);
    if (title !== null) return title;
  }
  return titleCandidate(parsed.hostname) ?? parsed.hostname;
}

// The first "datePublished" of the JSON-LD scripts, or null.
function jsonLdDatePublished(html: string): string | null {
  const open = /<script\b[^>]*>/gi;
  const close = /<\/script/gi;
  for (let match = open.exec(html); match !== null; match = open.exec(html)) {
    const start = match.index + match[0].length;
    close.lastIndex = start;
    const end = close.exec(html);
    const content = html.slice(start, end === null ? html.length : end.index);
    if (end !== null) open.lastIndex = end.index;
    if (!attributeIs(attributesOf(match[0]), "type", "application/ld+json")) continue;
    const date = /"datePublished"\s*:\s*"([^"]*)"/.exec(content);
    if (date?.[1] !== undefined) return date[1];
  }
  return null;
}

// The publication date of a page (YYYY-MM-DD): article:published_time, then the datePublished of JSON-LD, then a
// <meta> or <time> with itemprop="datePublished". null when none is a date.
export function extractPublishedOn(html: string): string | null {
  const metas = tagsOf(html, "meta");
  for (const meta of metas) {
    if (!attributeIs(meta, "property", "article:published_time")) continue;
    const date = leadingDate(meta.content);
    if (date !== null) return date;
  }
  const jsonLd = leadingDate(jsonLdDatePublished(html));
  if (jsonLd !== null) return jsonLd;
  for (const meta of metas) {
    if (!attributeIs(meta, "itemprop", "datepublished")) continue;
    const date = leadingDate(meta.content);
    if (date !== null) return date;
  }
  for (const time of tagsOf(html, "time")) {
    if (!attributeIs(time, "itemprop", "datepublished")) continue;
    const date = leadingDate(time.datetime);
    if (date !== null) return date;
  }
  return null;
}

export type PageResult = { ok: true; url: string; title: string; publishedOn: string | null } | { ok: false; error: string };

function pageFailureMessage(failure: FetchFailure): string {
  switch (failure.kind) {
    case "http":
      return pageHttpMessage(failure.status);
    case "network":
      return importMessages.network;
    case "offsite":
      return importMessages.offsite;
    case "redirects":
      return importMessages.redirects;
    case "budget":
      return importMessages.budget;
  }
}

// Fetches a page of the site and reads its title and publication date from the first 256 KB. url of the result is
// the URL after the redirects, normalized. Never throws.
export async function readPage(
  url: string,
  origin: string,
  budget: FetchBudget,
  fetcher: typeof fetch = globalFetcher,
): Promise<PageResult> {
  const fetched = await fetchWithinOrigin(url, origin, PAGE_ACCEPT, budget, fetcher);
  if (!fetched.ok) return { ok: false, error: pageFailureMessage(fetched.failure) };
  const { res, signal } = fetched;
  const contentType = (res.headers.get("Content-Type") ?? "").trim().toLowerCase();
  if (!contentType.startsWith("text/html") && !contentType.startsWith("application/xhtml+xml")) {
    discard(res);
    return { ok: false, error: importMessages.notHtml };
  }
  if (!isUtf8(charsetOf(contentType))) {
    discard(res);
    return { ok: false, error: importMessages.charset };
  }
  let bytes: Uint8Array = new Uint8Array(0);
  if (res.body !== null) {
    const body = await readLimited(res.body, PAGE_MAX_BYTES, "truncate", signal, false);
    if (!body.ok) return { ok: false, error: importMessages.network };
    bytes = body.bytes;
  }
  const decoder = new TextDecoder("utf-8");
  if (!isUtf8(metaCharset(decoder.decode(bytes.subarray(0, CHARSET_SNIFF_BYTES))))) {
    return { ok: false, error: importMessages.charset };
  }
  const html = decoder.decode(bytes);
  const finalUrl = normalizeArticleUrl(fetched.url);
  const articleUrl = finalUrl.ok && finalUrl.value !== null ? finalUrl.value : url;
  return { ok: true, url: articleUrl, title: extractTitle(html, articleUrl), publishedOn: extractPublishedOn(html) };
}
