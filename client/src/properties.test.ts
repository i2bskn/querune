import { describe, expect, it } from "vitest";
import { changesProperty, normalizeGa4PropertyIdInput, normalizeGscPropertyInput } from "./properties";

describe("normalizeGscPropertyInput", () => {
  it("normalizes as the server does", () => {
    expect(normalizeGscPropertyInput("  ")).toBeNull();
    expect(normalizeGscPropertyInput(" SC-DOMAIN:Example.COM ")).toBe("sc-domain:example.com");
    expect(normalizeGscPropertyInput("https://Example.com")).toBe("https://example.com/");
    expect(normalizeGscPropertyInput("sc-domain:bad_domain")).toBeUndefined();
    expect(normalizeGscPropertyInput("https://example.com/a")).toBeUndefined();
    expect(normalizeGscPropertyInput("ftp://example.com/")).toBeUndefined();
  });
});

describe("normalizeGa4PropertyIdInput", () => {
  it("normalizes as the server does", () => {
    expect(normalizeGa4PropertyIdInput("")).toBeNull();
    expect(normalizeGa4PropertyIdInput(" 123 ")).toBe("123");
    expect(normalizeGa4PropertyIdInput("12a")).toBeUndefined();
  });
});

describe("changesProperty", () => {
  const saved = { gsc_property: "sc-domain:example.com", ga4_property_id: "123" };

  it("is true only when a normalized property differs from the saved one", () => {
    expect(changesProperty(saved, { gscProperty: "SC-DOMAIN:example.com", ga4PropertyId: " 123" })).toBe(false);
    expect(changesProperty(saved, { gscProperty: "sc-domain:other.com", ga4PropertyId: "123" })).toBe(true);
    expect(changesProperty(saved, { gscProperty: "sc-domain:example.com", ga4PropertyId: "" })).toBe(true);
    // Inputs that cannot be normalized are not compared.
    expect(changesProperty(saved, { gscProperty: "sc-domain:", ga4PropertyId: "12x" })).toBe(false);
  });
});
