// Little-endian payload builders/readers. Adapted from betaflight-configurator
// src/js/msp/mspBytes.ts; reads past the end throw instead of yielding null so a
// short reply from older firmware surfaces as a decode error rather than NaN fields.

export class PayloadWriter {
    private bytes: number[] = [];
    u8(v: number): this {
        this.bytes.push(v & 0xff);
        return this;
    }
    u16(v: number): this {
        return this.u8(v).u8(v >> 8);
    }
    u32(v: number): this {
        return this.u8(v).u8(v >> 8).u8(v >> 16).u8(v >> 24);
    }
    i8(v: number): this {
        return this.u8(v);
    }
    i16(v: number): this {
        return this.u16(v);
    }
    i32(v: number): this {
        return this.u32(v);
    }
    raw(data: ArrayLike<number>): this {
        for (let i = 0; i < data.length; i++) this.bytes.push(data[i] & 0xff);
        return this;
    }
    str(s: string): this {
        return this.raw(Buffer.from(s, "latin1"));
    }
    /** length-prefixed string (u8 length) */
    pstr(s: string): this {
        const b = Buffer.from(s, "latin1");
        return this.u8(b.length).raw(b);
    }
    toArray(): number[] {
        return this.bytes;
    }
    toUint8Array(): Uint8Array {
        return Uint8Array.from(this.bytes);
    }
}

export class PayloadReader {
    offset = 0;
    private view: DataView;
    constructor(private readonly data: Uint8Array) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }
    get length(): number {
        return this.data.length;
    }
    remaining(): number {
        return this.data.length - this.offset;
    }
    has(n = 1): boolean {
        return this.remaining() >= n;
    }
    private need(n: number): void {
        if (this.remaining() < n) throw new RangeError(`payload too short: need ${n} bytes at offset ${this.offset}, have ${this.remaining()}`);
    }
    u8(): number {
        this.need(1);
        return this.view.getUint8(this.offset++);
    }
    i8(): number {
        this.need(1);
        return this.view.getInt8(this.offset++);
    }
    u16(): number {
        this.need(2);
        const v = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return v;
    }
    i16(): number {
        this.need(2);
        const v = this.view.getInt16(this.offset, true);
        this.offset += 2;
        return v;
    }
    u32(): number {
        this.need(4);
        const v = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return v;
    }
    i32(): number {
        this.need(4);
        const v = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return v;
    }
    /** Optional-trailing-field helpers: return `fallback` when older firmware omits the field. */
    u8or<T>(fallback: T): number | T {
        return this.has(1) ? this.u8() : fallback;
    }
    u16or<T>(fallback: T): number | T {
        return this.has(2) ? this.u16() : fallback;
    }
    u32or<T>(fallback: T): number | T {
        return this.has(4) ? this.u32() : fallback;
    }
    bytes(n: number): Uint8Array {
        this.need(n);
        const out = this.data.slice(this.offset, this.offset + n);
        this.offset += n;
        return out;
    }
    rest(): Uint8Array {
        return this.bytes(this.remaining());
    }
    str(n: number): string {
        return Buffer.from(this.bytes(n)).toString("latin1");
    }
    /** u8 length-prefixed string */
    pstr(): string {
        return this.str(this.u8());
    }
    restStr(): string {
        return Buffer.from(this.rest()).toString("latin1");
    }
}
