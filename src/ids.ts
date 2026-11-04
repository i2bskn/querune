// Identifiers: prefixed ULIDs for rows, and hashing helpers.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

// ULID: 26 Crockford base32 characters.
export const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH));
  // 256 is a multiple of 32, so the low 5 bits are uniform.
  return Array.from(bytes, (b) => b & 31);
}

// Increments a base32 number in place. Returns false on overflow.
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = digits[i] ?? 0;
    if (digit < 31) {
      digits[i] = digit + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

// A ULID for the time now (UNIX ms). Monotonic within this isolate: IDs made in the same millisecond, or
// with a clock that went back, keep increasing.
export function newUlid(now: number): string {
  let time = Math.max(0, Math.floor(now));
  if (time <= lastTime) {
    time = lastTime;
    if (!increment(lastRandom)) {
      time += 1;
      lastRandom = randomDigits();
    }
  } else {
    lastRandom = randomDigits();
  }
  lastTime = time;
  let encodedTime = "";
  for (let i = 0; i < TIME_LENGTH; i++) {
    encodedTime = CROCKFORD[time % 32] + encodedTime;
    time = Math.floor(time / 32);
  }
  return encodedTime + lastRandom.map((d) => CROCKFORD[d]).join("");
}

export const SITE_ID_PATTERN = new RegExp(`^site_${ULID_PATTERN}$`);

export function newSiteId(now: number): string {
  return `site_${newUlid(now)}`;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  // Workers have no SharedArrayBuffer, so every view is backed by an ArrayBuffer.
  const bytes = (typeof data === "string" ? new TextEncoder().encode(data) : data) as Uint8Array<ArrayBuffer>;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
