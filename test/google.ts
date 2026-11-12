// Helpers for the tests that talk to the Google APIs: a service account key made in the test, and a fetch that
// answers the token endpoint and the APIs without reaching the network.

export const SERVICE_ACCOUNT_EMAIL = "querune@test-project.iam.gserviceaccount.com";

export type TestServiceAccount = { key: string; publicKey: CryptoKey; pem: string };

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// A new RSA key pair, and the JSON of a service account key with its private key.
export async function createServiceAccount(extra: Record<string, unknown> = {}): Promise<TestServiceAccount> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const body = toBase64(pkcs8).replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
  const key = JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    private_key_id: "0123456789abcdef",
    private_key: pem,
    client_email: SERVICE_ACCOUNT_EMAIL,
    token_uri: "https://oauth2.googleapis.com/token",
    ...extra,
  });
  return { key, publicKey: pair.publicKey, pem };
}

let shared: Promise<TestServiceAccount> | null = null;

// One key for every test of a file: generating RSA keys takes time.
export function sharedServiceAccount(): Promise<TestServiceAccount> {
  shared ??= createServiceAccount();
  return shared;
}

export type GoogleCall = { url: string; body: unknown; authorization: string | null };

export type FakeGoogle = {
  fetcher: typeof fetch;
  calls: GoogleCall[];
  tokenCalls: number;
  // Answers the token endpoint. Defaults to a token valid for an hour.
  token: () => Response | Promise<Response>;
  // Answers the Search Console and GA4 APIs.
  api: (call: GoogleCall) => Response | Promise<Response>;
};

export function fakeGoogle(): FakeGoogle {
  const google: FakeGoogle = {
    calls: [],
    tokenCalls: 0,
    token: () => Response.json({ access_token: "test-access-token", expires_in: 3600, token_type: "Bearer" }),
    api: () => Response.json({}),
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      if (request.url === "https://oauth2.googleapis.com/token") {
        google.tokenCalls++;
        return google.token();
      }
      if (
        request.url.startsWith("https://www.googleapis.com/webmasters/v3/") ||
        request.url.startsWith("https://analyticsdata.googleapis.com/")
      ) {
        const call = {
          url: request.url,
          body: JSON.parse(await request.text()) as unknown,
          authorization: request.headers.get("Authorization"),
        };
        google.calls.push(call);
        return google.api(call);
      }
      throw new Error(`unexpected fetch: ${request.url}`);
    },
  };
  return google;
}

// The rows of a Search Analytics response grouped by date first: keys and the metrics.
export function gscRows(count: number, dataset: "gsc_pages" | "gsc_queries", date: string, from = 0) {
  return Array.from({ length: count }, (_, i) => ({
    keys:
      dataset === "gsc_pages"
        ? [date, `https://example.com/p/${from + i}`]
        : [date, `https://example.com/p/${Math.floor((from + i) / 10)}`, `query ${from + i}`],
    clicks: (from + i) % 7,
    impressions: 10 + ((from + i) % 13),
    ctr: 0.1,
    position: 1 + ((from + i) % 20) / 2,
  }));
}

// The rows of a runReport response.
export function ga4Rows(count: number, date: string, from = 0) {
  const compact = date.replace(/-/g, "");
  return Array.from({ length: count }, (_, i) => ({
    dimensionValues: [{ value: compact }, { value: `/p/${from + i}` }, { value: (from + i) % 2 === 0 ? "Organic Search" : "Direct" }],
    metricValues: [{ value: String(5 + ((from + i) % 3)) }, { value: String(2 + ((from + i) % 2)) }, { value: "1.5" }],
  }));
}

// The rows of a runReport response of ga4_pages: hostName, pagePath, screenPageViews and userEngagementDuration.
export function ga4PageRows(count: number, date: string, from = 0) {
  const compact = date.replace(/-/g, "");
  return Array.from({ length: count }, (_, i) => ({
    dimensionValues: [{ value: compact }, { value: "example.com" }, { value: `/p/${from + i}` }],
    metricValues: [{ value: String(3 + ((from + i) % 4)) }, { value: "12.5" }],
  }));
}
