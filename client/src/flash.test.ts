import { describe, expect, it } from "vitest";
import { setFlash, takeFlash } from "./flash";

describe("setFlash and takeFlash", () => {
  it("passes one message to the first reader only", () => {
    expect(takeFlash()).toBeNull();
    setFlash("サイトを削除しました");
    expect(takeFlash()).toBe("サイトを削除しました");
    expect(takeFlash()).toBeNull();
  });

  it("keeps the last message only", () => {
    setFlash("a");
    setFlash("b");
    expect(takeFlash()).toBe("b");
    expect(takeFlash()).toBeNull();
  });
});
