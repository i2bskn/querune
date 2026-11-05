// The normalization of the properties of a site, as the server does it (normalizeGscProperty and
// normalizeGa4PropertyId in src/routes/sites.ts). undefined: the input is invalid, and the server rejects it.

const SC_DOMAIN_PREFIX = "sc-domain:";
const DOMAIN_MAX_LENGTH = 253;
const URL_MAX_LENGTH = 2048;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const GA4_PROPERTY_ID_PATTERN = /^[0-9]{1,20}$/;

export function normalizeGscPropertyInput(value: string): string | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.slice(0, SC_DOMAIN_PREFIX.length).toLowerCase() === SC_DOMAIN_PREFIX) {
    const domain = trimmed.slice(SC_DOMAIN_PREFIX.length).toLowerCase();
    if (domain.length > DOMAIN_MAX_LENGTH || !DOMAIN_PATTERN.test(domain)) return undefined;
    return `${SC_DOMAIN_PREFIX}${domain}`;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "" || !url.pathname.endsWith("/")) return undefined;
  if (url.href.length > URL_MAX_LENGTH) return undefined;
  return url.href;
}

export function normalizeGa4PropertyIdInput(value: string): string | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return GA4_PROPERTY_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

// Whether saving the inputs changes a property of the site. Inputs that cannot be normalized are not compared.
export function changesProperty(
  saved: { gsc_property: string | null; ga4_property_id: string | null },
  input: { gscProperty: string; ga4PropertyId: string },
): boolean {
  const gsc = normalizeGscPropertyInput(input.gscProperty);
  const ga4 = normalizeGa4PropertyIdInput(input.ga4PropertyId);
  return (gsc !== undefined && gsc !== saved.gsc_property) || (ga4 !== undefined && ga4 !== saved.ga4_property_id);
}
