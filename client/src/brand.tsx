import { BRAND_NAME } from "../../src/brand";

// The wordmark for the header: the brand name set in text. Decorative: the link around it is named by its
// screen-reader text.
export function BrandLogo() {
  return (
    <span className="brand-logo" aria-hidden="true">
      {BRAND_NAME}
    </span>
  );
}
