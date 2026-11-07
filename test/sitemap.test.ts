import { describe, expect, it } from "vitest";
import {
  extractPublishedOn,
  extractTitle,
  importMessages,
  MAX_SITEMAP_URLS,
  readPage,
  readSitemap,
  rootElementName,
  SITEMAP_MAX_BYTES,
  sitemapEntries,
  withoutSiteSuffix,
  xmlText,
} from "../src/sitemap";

const ORIGIN = "https://example.com";

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

// A fetcher that answers from a table of URLs (404 for the others) and records the requested URLs.
function fakeFetcher(routes: Record<string, Handler>): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const handler = routes[url];
    return handler ? handler(init) : new Response("not found", { status: 404 });
  };
  return { fetcher, calls };
}

function xml(body: string, headers: Record<string, string> = {}): Handler {
  return () => new Response(body, { headers: { "Content-Type": "application/xml", ...headers } });
}

function html(body: string, contentType = "text/html; charset=utf-8"): Handler {
  return () => new Response(body, { headers: { "Content-Type": contentType } });
}

function redirect(location: string, status = 301): Handler {
  return () => new Response(null, { status, headers: { Location: location } });
}

function urlset(...entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join("\n")}</urlset>`;
}

function url(loc: string, lastmod?: string): string {
  return `<url><loc>${loc}</loc>${lastmod === undefined ? "" : `<lastmod>${lastmod}</lastmod>`}</url>`;
}

function sitemapIndex(...locs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
    .join("")}</sitemapindex>`;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("xml helpers", () => {
  it("decodes CDATA, references and keeps out-of-range numeric references", () => {
    expect(xmlText("  <![CDATA[https://example.com/a?x=1&y=2]]>  ")).toBe("https://example.com/a?x=1&y=2");
    expect(xmlText("https://example.com/a?x=1&amp;y=&lt;&gt;&quot;&apos;&#65;&#x42;")).toBe(
      "https://example.com/a?x=1&y=<>\"'AB",
    );
    expect(xmlText("&#0;&#x110000;&#xD800;&#99999999999999999999;&unknown;")).toBe(
      "&#0;&#x110000;&#xD800;&#99999999999999999999;&unknown;",
    );
  });

  it("finds the root element after stylesheets, comments and the DOCTYPE", () => {
    const text = `﻿<?xml version="1.0"?>
<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>
<!-- generated -->
<!DOCTYPE urlset [ <!ENTITY a "b"> ]>
<ns:urlset xmlns:ns="http://www.sitemaps.org/schemas/sitemap/0.9"></ns:urlset>`;
    expect(rootElementName(text)).toBe("urlset");
    expect(rootElementName("<html><body></body></html>")).toBe("html");
    expect(rootElementName("not xml")).toBeNull();
    expect(rootElementName("<!-- unterminated")).toBeNull();
  });

  it("reads prefixed names and ignores <loc> outside <url>", () => {
    const text = `<s:urlset><loc>https://example.com/outside</loc>
<s:url><s:loc>https://example.com/a</s:loc><s:lastmod>2026-10-01</s:lastmod></s:url>
<url><loc>https://example.com/b</loc><image:image><image:loc>https://example.com/b.png</image:loc></image:image></url>
</s:urlset>`;
    expect(sitemapEntries(text, "url")).toEqual([
      { loc: "https://example.com/a", lastmod: "2026-10-01" },
      { loc: "https://example.com/b", lastmod: null },
    ]);
  });
});

describe("readSitemap", () => {
  it("reads loc and lastmod of a urlset in order", async () => {
    const { fetcher } = fakeFetcher({
      [`${ORIGIN}/sitemap.xml`]: xml(
        urlset(
          url(`${ORIGIN}/a`, "2026-10-01"),
          url(`${ORIGIN}/b`, "2026-10-02T09:00:00+09:00"),
          url(`${ORIGIN}/c`, "2026-02-30"),
          url(`<![CDATA[${ORIGIN}/d?x=1&y=2]]>`, " 2026-10-04 "),
          url(`${ORIGIN}/e?x=1&amp;y=2#top`),
          url(`${ORIGIN}/a`, "2026-12-31"),
          url("https://other.example.com/x"),
          url("not a url"),
          "<url><lastmod>2026-10-01</lastmod></url>",
        ),
      ),
    });
    expect(await readSitemap(`${ORIGIN}/sitemap.xml`, ORIGIN, { fetcher })).toEqual({
      ok: true,
      urls: [
        { url: `${ORIGIN}/a`, lastmod: "2026-10-01" },
        { url: `${ORIGIN}/b`, lastmod: "2026-10-02" },
        { url: `${ORIGIN}/c`, lastmod: null },
        { url: `${ORIGIN}/d?x=1&y=2`, lastmod: "2026-10-04" },
        { url: `${ORIGIN}/e?x=1&y=2`, lastmod: null },
      ],
      truncated: false,
      skippedUrls: 3,
      skippedSitemaps: 0,
    });
  });

  it("returns an empty list for an empty urlset", async () => {
    const { fetcher } = fakeFetcher({ [`${ORIGIN}/sitemap.xml`]: xml(urlset()) });
    expect(await readSitemap(`${ORIGIN}/sitemap.xml`, ORIGIN, { fetcher })).toMatchObject({ ok: true, urls: [] });
  });

  it("keeps the first 5000 URLs", async () => {
    const entries = Array.from({ length: MAX_SITEMAP_URLS + 1 }, (_, i) => url(`${ORIGIN}/p/${i}`));
    const { fetcher } = fakeFetcher({ [`${ORIGIN}/sitemap.xml`]: xml(urlset(...entries)) });
    const result = await readSitemap(`${ORIGIN}/sitemap.xml`, ORIGIN, { fetcher });
    if (!result.ok) throw new Error("expected ok");
    expect(result.urls).toHaveLength(MAX_SITEMAP_URLS);
    expect(result.urls.at(-1)?.url).toBe(`${ORIGIN}/p/4999`);
    expect(result.truncated).toBe(true);
  });

  it("reads the children of a sitemapindex and counts the skipped ones", async () => {
    const { fetcher, calls } = fakeFetcher({
      [`${ORIGIN}/sitemap.xml`]: xml(
        sitemapIndex(
          `${ORIGIN}/posts.xml`,
          "https://other.example.com/posts.xml",
          `${ORIGIN}/missing.xml`,
          `${ORIGIN}/nested.xml`,
          `${ORIGIN}/error.xml`,
          `${ORIGIN}/pages.xml`,
        ),
      ),
      [`${ORIGIN}/posts.xml`]: xml(urlset(url(`${ORIGIN}/posts/1`, "2026-10-01"))),
      [`${ORIGIN}/nested.xml`]: xml(sitemapIndex(`${ORIGIN}/posts.xml`)),
      [`${ORIGIN}/error.xml`]: html("<html><body>error</body></html>"),
      [`${ORIGIN}/pages.xml`]: xml(urlset(url(`${ORIGIN}/about`), url(`${ORIGIN}/posts/1`))),
    });
    expect(await readSitemap(`${ORIGIN}/sitemap.xml`, ORIGIN, { fetcher })).toEqual({
      ok: true,
      urls: [
        { url: `${ORIGIN}/posts/1`, lastmod: "2026-10-01" },
        { url: `${ORIGIN}/about`, lastmod: null },
      ],
      truncated: false,
      skippedUrls: 0,
      skippedSitemaps: 4,
    });
    expect(calls).not.toContain("https://other.example.com/posts.xml");
  });

  it("reads at most 10 children and skips the rest", async () => {
    const routes: Record<string, Handler> = {};
    const locs = Array.from({ length: 12 }, (_, i) => `${ORIGIN}/s${i}.xml`);
    routes[`${ORIGIN}/sitemap.xml`] = xml(sitemapIndex(...locs));
    for (const [i, loc] of locs.entries()) routes[loc] = xml(urlset(url(`${ORIGIN}/p/${i}`)));
    const { fetcher, calls } = fakeFetcher(routes);
    const result = await readSitemap(`${ORIGIN}/sitemap.xml`, ORIGIN, { fetcher });
    if (!result.ok) throw new Error("expected ok");
    expect(result.urls).toHaveLength(10);
    expect(result.skippedSitemaps).toBe(2);
    expect(calls).toHaveLength(11);
  });

  it("stops reading children once 5000 URLs are found, without counting them as skipped", async () => {
    const big = Array.from({ length: MAX_SITEMAP_URLS }, (_, i) => url(`${ORIGIN}/p/${i}`));
    const { fetcher, calls } = fakeFetcher({
      [`${ORIGIN}/sitemap.xml`]: xml(sitemapIndex(`${ORIGIN}/a.xml`, `${ORIGIN}/b.xml`)),
      [`${ORIGIN}/a.xml`]: xml(urlset(...big)),
      [`${ORIGIN}/b.xml`]: xml(urlset(url(`${ORIGIN}/b`))),
    });
    const result = await readSitemap(`${ORIGIN}/sitemap.xml`, ORIGIN, { fetcher });
    expect(result).toMatchObject({ ok: true, truncated: true, skippedSitemaps: 0 });
    expect(calls).not.toContain(`${ORIGIN}/b.xml`);
  });

  it("reads a gzip sitemap", async () => {
    const body = await gzip(urlset(url(`${ORIGIN}/a`, "2026-10-01")));
    const { fetcher } = fakeFetcher({ [`${ORIGIN}/sitemap.xml.gz`]: () => new Response(body) });
    expect(await readSitemap(`${ORIGIN}/sitemap.xml.gz`, ORIGIN, { fetcher })).toMatchObject({
      ok: true,
      urls: [{ url: `${ORIGIN}/a`, lastmod: "2026-10-01" }],
    });
  });

  it("reports a broken gzip stream as unreadable", async () => {
    // The gzip magic bytes and header, then a deflate stream that is not valid.
    const broken = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 0xff, 0xff, 0xff, 0xff]);
    const { fetcher } = fakeFetcher({ [`${ORIGIN}/sitemap.xml.gz`]: () => new Response(broken) });
    expect(await readSitemap(`${ORIGIN}/sitemap.xml.gz`, ORIGIN, { fetcher })).toMatchObject({
      ok: false,
      error: "unreadable",
    });
  });

  it("fails over 5 MB in total", async () => {
    const huge = urlset(url(`${ORIGIN}/a`), `<!--${"x".repeat(SITEMAP_MAX_BYTES)}-->`);
    const { fetcher } = fakeFetcher({ [`${ORIGIN}/sitemap.xml`]: xml(huge) });
    expect(await readSitemap(`${ORIGIN}/sitemap.xml`, ORIGIN, { fetcher })).toEqual({
      ok: false,
      error: "unavailable",
      message: "サイトマップが大きすぎます（5 MB まで）",
    });

    // In an index, the child that goes over is skipped, and so are the children after it.
    const half = `<!--${"x".repeat(SITEMAP_MAX_BYTES / 2)}-->`;
    const index = fakeFetcher({
      [`${ORIGIN}/sitemap.xml`]: xml(sitemapIndex(`${ORIGIN}/a.xml`, `${ORIGIN}/b.xml`, `${ORIGIN}/c.xml`)),
      [`${ORIGIN}/a.xml`]: xml(urlset(url(`${ORIGIN}/a`), half)),
      [`${ORIGIN}/b.xml`]: xml(urlset(url(`${ORIGIN}/b`), half)),
      [`${ORIGIN}/c.xml`]: xml(urlset(url(`${ORIGIN}/c`))),
    });
    expect(await readSitemap(`${ORIGIN}/sitemap.xml`, ORIGIN, { fetcher: index.fetcher })).toMatchObject({
      ok: true,
      urls: [{ url: `${ORIGIN}/a` }],
      skippedSitemaps: 2,
    });
    expect(index.calls).not.toContain(`${ORIGIN}/c.xml`);
  });

  it("fails on HTTP errors, no response and redirects out of the site", async () => {
    const { fetcher } = fakeFetcher({
      [`${ORIGIN}/offsite.xml`]: redirect("https://other.example.com/sitemap.xml"),
      [`${ORIGIN}/down.xml`]: () => {
        throw new TypeError("network");
      },
    });
    expect(await readSitemap(`${ORIGIN}/sitemap.xml`, ORIGIN, { fetcher })).toEqual({
      ok: false,
      error: "unavailable",
      message: "サイトマップを取得できませんでした（HTTP 404）",
    });
    expect(await readSitemap(`${ORIGIN}/offsite.xml`, ORIGIN, { fetcher })).toEqual({
      ok: false,
      error: "unavailable",
      message: "サイトの外へリダイレクトされました",
    });
    expect(await readSitemap(`${ORIGIN}/down.xml`, ORIGIN, { fetcher })).toEqual({
      ok: false,
      error: "unavailable",
      message: "サイトマップを取得できませんでした（応答がありません）",
    });
  });

  it("reports a document that is not a sitemap as unreadable", async () => {
    const { fetcher } = fakeFetcher({ [`${ORIGIN}/sitemap.xml`]: html("<!DOCTYPE html><html></html>") });
    expect(await readSitemap(`${ORIGIN}/sitemap.xml`, ORIGIN, { fetcher })).toEqual({
      ok: false,
      error: "unreadable",
      message: "サイトマップとして読めませんでした。sitemap.xml の URL か確認してください",
    });
  });

  it("sends the user agent and the accept header without following redirects automatically", async () => {
    let seen: RequestInit | undefined;
    const { fetcher } = fakeFetcher({
      [`${ORIGIN}/sitemap.xml`]: (init) => {
        seen = init;
        return new Response(urlset());
      },
    });
    await readSitemap(`${ORIGIN}/sitemap.xml`, ORIGIN, { fetcher });
    expect(seen?.redirect).toBe("manual");
    expect(new Headers(seen?.headers).get("User-Agent")).toBe("Querune (+https://github.com/i2bskn/querune)");
    expect(new Headers(seen?.headers).get("Accept")).toBe("application/xml, text/xml;q=0.9, */*;q=0.1");
  });
});

describe("extractTitle", () => {
  const page = `${ORIGIN}/posts/hello-world`;

  it("prefers og:title over <title>", () => {
    expect(
      extractTitle(`<title>Site title</title><meta content="OG &amp; title" property="og:title">`, page),
    ).toBe("OG & title");
    expect(extractTitle(`<meta property='og:title' content='Single quoted'>`, page)).toBe("Single quoted");
  });

  it("reads <title>, decodes references and collapses white space", () => {
    expect(extractTitle(`<title>\n  A&nbsp;&lt;b&gt; &#39;c&#39;\t &#x263A; </title>`, page)).toBe("A <b> 'c' ☺");
  });

  it("skips an empty og:title", () => {
    expect(extractTitle(`<meta property="og:title" content="  "><title>Fallback</title>`, page)).toBe("Fallback");
  });

  it("cuts a long title to 200 code points", () => {
    const title = extractTitle(`<title>${"😀".repeat(250)}</title>`, page);
    expect([...title]).toHaveLength(200);
  });

  it("falls back to the last segment of the path, then the host name", () => {
    expect(extractTitle("<html></html>", page)).toBe("hello-world");
    expect(extractTitle("<html></html>", `${ORIGIN}/posts/%E6%97%A5%E6%9C%AC/`)).toBe("日本");
    expect(extractTitle("<html></html>", `${ORIGIN}/posts/%E6%97%A5%E6`)).toBe("%E6%97%A5%E6");
    expect(extractTitle("<html></html>", `${ORIGIN}/`)).toBe("example.com");
  });

  it("removes the name of the site after the title", () => {
    expect(extractTitle(`<meta property="og:title" content="記事の題 | cyfr（サイファー）">`, page)).toBe("記事の題");
    expect(extractTitle(`<title>AI | ブログ ｜ Example</title>`, page)).toBe("AI | ブログ");
    expect(
      extractTitle(`<meta property="og:site_name" content="Example"><title>Next.js - App Router - Example Blog</title>`, page),
    ).toBe("Next.js - App Router");
  });

  it("keeps the title when the part after the separator is long or is not the name of the site", () => {
    expect(extractTitle(`<title>Next.js - App Router</title>`, page)).toBe("Next.js - App Router");
    const long = `Short | ${"a".repeat(41)}`;
    expect(extractTitle(`<title>${long}</title>`, page)).toBe(long);
    expect(extractTitle(`<title>| Example</title>`, page)).toBe("| Example");
  });
});

describe("withoutSiteSuffix", () => {
  it("removes only the last part after a pipe", () => {
    expect(withoutSiteSuffix("A | B | Site", null)).toBe("A | B");
    expect(withoutSiteSuffix("A - Site", "Other")).toBe("A - Site");
    expect(withoutSiteSuffix("A — Site Blog", "Site")).toBe("A");
  });
});

describe("extractPublishedOn", () => {
  it("reads article:published_time first", () => {
    expect(
      extractPublishedOn(`<meta property="article:published_time" content="2026-10-01T09:00:00+09:00">
<script type="application/ld+json">{"datePublished": "2025-01-01"}</script>`),
    ).toBe("2026-10-01");
    expect(extractPublishedOn(`<meta content='2026-10-02' property='article:published_time'>`)).toBe("2026-10-02");
  });

  it("reads datePublished of JSON-LD", () => {
    expect(
      extractPublishedOn(`<script>var x = {"datePublished": "2020-01-01"}</script>
<script type="application/ld+json">{"@type": "BlogPosting", "datePublished" : "2026-10-03T00:00:00Z"}</script>`),
    ).toBe("2026-10-03");
  });

  it("reads itemprop on <meta> and <time>", () => {
    expect(extractPublishedOn(`<meta itemprop="datePublished" content="2026-10-04">`)).toBe("2026-10-04");
    expect(extractPublishedOn(`<time datetime='2026-10-05T10:00' class="x" itemprop='datePublished'>Oct 5</time>`)).toBe(
      "2026-10-05",
    );
  });

  it("returns null without a date", () => {
    expect(extractPublishedOn(`<meta property="article:published_time" content="yesterday"><time>today</time>`)).toBeNull();
  });
});

describe("readPage", () => {
  const page = `${ORIGIN}/posts/a`;

  it("reads the title and the date of a page", async () => {
    const { fetcher } = fakeFetcher({
      [page]: html(`<html><head><title>A post</title><meta property="article:published_time" content="2026-10-01"></head></html>`),
    });
    expect(await readPage(page, ORIGIN, { remaining: 5 }, fetcher)).toEqual({
      ok: true,
      url: page,
      title: "A post",
      publishedOn: "2026-10-01",
    });
  });

  it("follows redirects within the site and returns the final URL", async () => {
    const { fetcher } = fakeFetcher({
      [page]: redirect("/posts/b", 301),
      [`${ORIGIN}/posts/b`]: redirect(`${ORIGIN}/posts/c#x`, 308),
      [`${ORIGIN}/posts/c`]: html("<title>C</title>"),
    });
    expect(await readPage(page, ORIGIN, { remaining: 5 }, fetcher)).toMatchObject({
      ok: true,
      url: `${ORIGIN}/posts/c`,
      title: "C",
    });
  });

  it("fails on a third redirect, a redirect out of the site and an HTTP error", async () => {
    const { fetcher } = fakeFetcher({
      [`${ORIGIN}/r1`]: redirect(`${ORIGIN}/r2`),
      [`${ORIGIN}/r2`]: redirect(`${ORIGIN}/r3`),
      [`${ORIGIN}/r3`]: redirect(`${ORIGIN}/r4`),
      [`${ORIGIN}/r4`]: html("<title>R4</title>"),
      [`${ORIGIN}/out`]: redirect("http://example.com/out"),
      [`${ORIGIN}/gone`]: () => new Response("gone", { status: 410 }),
      [`${ORIGIN}/no-location`]: () => new Response(null, { status: 302 }),
      [`${ORIGIN}/empty`]: () => new Response(null, { status: 204 }),
    });
    expect(await readPage(`${ORIGIN}/r1`, ORIGIN, { remaining: 10 }, fetcher)).toEqual({
      ok: false,
      error: "リダイレクトが多すぎます",
    });
    expect(await readPage(`${ORIGIN}/out`, ORIGIN, { remaining: 10 }, fetcher)).toEqual({
      ok: false,
      error: "サイトの外へリダイレクトされました",
    });
    expect(await readPage(`${ORIGIN}/gone`, ORIGIN, { remaining: 10 }, fetcher)).toEqual({
      ok: false,
      error: "ページを取得できませんでした（HTTP 410）",
    });
    expect(await readPage(`${ORIGIN}/no-location`, ORIGIN, { remaining: 10 }, fetcher)).toEqual({
      ok: false,
      error: "ページを取得できませんでした（HTTP 302）",
    });
    expect(await readPage(`${ORIGIN}/empty`, ORIGIN, { remaining: 10 }, fetcher)).toEqual({
      ok: false,
      error: "ページを取得できませんでした（HTTP 204）",
    });
  });

  it("fails when the fetches run out", async () => {
    const { fetcher, calls } = fakeFetcher({ [page]: redirect(`${ORIGIN}/posts/b`) });
    expect(await readPage(page, ORIGIN, { remaining: 1 }, fetcher)).toEqual({ ok: false, error: importMessages.budget });
    expect(calls).toEqual([page]);
  });

  it("fails on a page that is not HTML", async () => {
    const { fetcher } = fakeFetcher({ [page]: html("{}", "application/json") });
    expect(await readPage(page, ORIGIN, { remaining: 5 }, fetcher)).toEqual({ ok: false, error: "HTML のページではありません" });
  });

  it("fails on a charset other than UTF-8", async () => {
    const header = fakeFetcher({ [page]: html("<title>x</title>", "text/html; charset=Shift_JIS") });
    expect(await readPage(page, ORIGIN, { remaining: 5 }, header.fetcher)).toEqual({
      ok: false,
      error: "UTF-8 以外の文字コードのページは取り込めません",
    });
    const meta = fakeFetcher({ [page]: html(`<meta charset="shift_jis"><title>x</title>`, "text/html") });
    expect(await readPage(page, ORIGIN, { remaining: 5 }, meta.fetcher)).toMatchObject({ ok: false });
    const equiv = fakeFetcher({
      [page]: html(`<meta http-equiv="Content-Type" content="text/html; charset=EUC-JP"><title>x</title>`, "text/html"),
    });
    expect(await readPage(page, ORIGIN, { remaining: 5 }, equiv.fetcher)).toMatchObject({ ok: false });
    const utf8 = fakeFetcher({ [page]: html(`<meta charset="UTF-8"><title>ok</title>`, "text/html") });
    expect(await readPage(page, ORIGIN, { remaining: 5 }, utf8.fetcher)).toMatchObject({ ok: true, title: "ok" });
  });

  it("reads only the first 256 KB", async () => {
    const body = `<html><head>${" ".repeat(256 * 1024)}<title>Too late</title></head></html>`;
    const { fetcher } = fakeFetcher({ [page]: html(body) });
    expect(await readPage(page, ORIGIN, { remaining: 5 }, fetcher)).toMatchObject({ ok: true, title: "a" });
  });
});
