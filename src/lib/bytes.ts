/**
 * Worker-compatible byte helpers (no Node `Buffer`).
 *
 * Cloudflare Workers lack Node's `Buffer` global, so base64/hex encoding and
 * decoding are implemented from Uint8Array. These mirror the small subset of
 * Buffer behavior used across the provider adapters.
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_LOOKUP: Record<string, number> = (() => {
  const t: Record<string, number> = {};
  for (let i = 0; i < 64; i += 1) t[B64_ALPHABET[i]] = i;
  return t;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64_ALPHABET[(n >> 18) & 63] +
      B64_ALPHABET[(n >> 12) & 63] +
      B64_ALPHABET[(n >> 6) & 63] +
      B64_ALPHABET[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + '==';
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + B64_ALPHABET[(n >> 6) & 63] + '=';
  }
  return out;
}

export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  const len = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(len);
  let out = 0;
  for (let i = 0; i + 3 < clean.length; i += 4) {
    const n =
      (B64_LOOKUP[clean[i]] << 18) |
      (B64_LOOKUP[clean[i + 1]] << 12) |
      (B64_LOOKUP[clean[i + 2]] << 6) |
      B64_LOOKUP[clean[i + 3]];
    bytes[out++] = (n >> 16) & 255;
    bytes[out++] = (n >> 8) & 255;
    bytes[out++] = n & 255;
  }
  return bytes;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
