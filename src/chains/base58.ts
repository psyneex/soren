const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decodes a base58 string (Solana-style addresses) into raw bytes. */
export function base58Decode(input: string): Uint8Array {
  let value = 0n;
  let leadingZeros = 0;
  for (let i = 0; i < input.length && input[i] === '1'; i += 1) leadingZeros += 1;

  for (const char of input) {
    const digit = ALPHABET.indexOf(char);
    if (digit === -1) throw new Error(`Invalid base58 character: ${char}`);
    value = value * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 255n));
    value >>= 8n;
  }
  for (let i = 0; i < leadingZeros; i += 1) bytes.unshift(0);
  return Uint8Array.from(bytes);
}

export function base64FromBase58(input: string): string {
  return Buffer.from(base58Decode(input)).toString('base64');
}