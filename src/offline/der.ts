/**
 * The few DER shapes the offline fixtures need, and a reader for them.
 *
 * Written here rather than taken from a library because the shapes are four - SEQUENCE,
 * INTEGER, ENUMERATED, OCTET STRING - and the only ASN.1 libraries on this tree are the
 * transitive dependencies of @peculiar/x509, which package.json does not name. A fixture that
 * imported one would build on a dependency that can leave with the next @peculiar release.
 */

export function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function derTlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

export const derSequence = (...items: Buffer[]): Buffer => derTlv(0x30, Buffer.concat(items));
export const derOctetString = (value: Buffer): Buffer => derTlv(0x04, value);
export const derEnumerated = (value: number): Buffer => derTlv(0x0a, Buffer.from([value]));
/** Context-specific, constructed: `[n] EXPLICIT`. */
export const derExplicit = (n: number, value: Buffer): Buffer => derTlv(0xa0 | n, value);

/** A non-negative INTEGER, minimal two's-complement octets. */
export function derInteger(value: number): Buffer {
  const bytes: number[] = [];
  for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  if (bytes.length === 0) bytes.push(0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return derTlv(0x02, Buffer.from(bytes));
}

export interface Tlv {
  tag: number;
  value: Buffer;
  end: number;
}

/** One TLV at `offset`: single-octet tags only, definite lengths only, as DER requires. */
export function readTlv(buf: Buffer, offset: number): Tlv {
  if (offset + 2 > buf.length) throw new Error('DER: truncated TLV');
  const tag = buf[offset];
  let length = buf[offset + 1];
  let pos = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error('DER: unsupported length form');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[pos + i];
    pos += count;
  }
  if (pos + length > buf.length) throw new Error('DER: length past the end');
  return { tag, value: buf.subarray(pos, pos + length), end: pos + length };
}

/** The elements of the SEQUENCE `buf` holds. */
export function readSequence(buf: Buffer): Tlv[] {
  const outer = readTlv(buf, 0);
  if (outer.tag !== 0x30) throw new Error(`DER: expected a SEQUENCE, got tag 0x${outer.tag.toString(16)}`);
  const items: Tlv[] = [];
  for (let pos = 0; pos < outer.value.length; ) {
    const item = readTlv(outer.value, pos);
    items.push(item);
    pos = item.end;
  }
  return items;
}
