/**
 * Host-environment shims for bare JavaScriptCore. The Swift host injects
 * `__mosaicRandomBytes(length): number[]` (SecRandomCopyBytes) before the
 * bundle loads; randomness fails closed without it. Everything else is pure
 * JS. No shim here may ever grant the context network access — the crypto
 * context stays networkless by construction.
 */

type HostRandom = (length: number) => number[];

declare global {
  // eslint-disable-next-line no-var
  var __mosaicRandomBytes: HostRandom | undefined;
}

const globalObject = globalThis as Record<string, unknown> & typeof globalThis;

if (typeof globalObject.crypto === 'undefined' || typeof globalObject.crypto.getRandomValues !== 'function') {
  const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (!array) return array;
    const host = globalObject.__mosaicRandomBytes;
    if (typeof host !== 'function') {
      throw new Error('mosaic-bridge: host randomness (__mosaicRandomBytes) is not installed');
    }
    const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const bytes = host(view.length);
    if (!Array.isArray(bytes) || bytes.length !== view.length) {
      throw new Error('mosaic-bridge: host randomness returned wrong length');
    }
    view.set(bytes);
    return array;
  };
  Object.defineProperty(globalObject, 'crypto', {
    value: { getRandomValues },
    configurable: true,
  });
}

/** Minimal UTF-8 TextEncoder/TextDecoder for bare JSC. */
class BridgeTextEncoder {
  readonly encoding = 'utf-8';

  encode(input = ''): Uint8Array {
    const bytes: number[] = [];
    for (const char of input) {
      let code = char.codePointAt(0)!;
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }
    return Uint8Array.from(bytes);
  }
}

class BridgeTextDecoder {
  readonly encoding: string;

  constructor(label = 'utf-8') {
    const normalized = label.toLowerCase();
    if (normalized !== 'utf-8' && normalized !== 'utf8') {
      throw new Error(`mosaic-bridge: unsupported TextDecoder encoding ${label}`);
    }
    this.encoding = 'utf-8';
  }

  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (!input) return '';
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    let out = '';
    let i = 0;
    while (i < bytes.length) {
      const byte = bytes[i]!;
      let code: number;
      let extra: number;
      if (byte < 0x80) {
        code = byte;
        extra = 0;
      } else if ((byte & 0xe0) === 0xc0) {
        code = byte & 0x1f;
        extra = 1;
      } else if ((byte & 0xf0) === 0xe0) {
        code = byte & 0x0f;
        extra = 2;
      } else if ((byte & 0xf8) === 0xf0) {
        code = byte & 0x07;
        extra = 3;
      } else {
        code = 0xfffd;
        extra = 0;
      }
      for (let j = 0; j < extra; j++) {
        i += 1;
        code = (code << 6) | (bytes[i]! & 0x3f);
      }
      out += String.fromCodePoint(code);
      i += 1;
    }
    return out;
  }
}

if (typeof globalObject.TextEncoder === 'undefined') {
  globalObject.TextEncoder = BridgeTextEncoder as unknown as typeof TextEncoder;
}
if (typeof globalObject.TextDecoder === 'undefined') {
  globalObject.TextDecoder = BridgeTextDecoder as unknown as typeof TextDecoder;
}

if (typeof globalObject.console === 'undefined') {
  const noop = () => {};
  globalObject.console = { log: noop, warn: noop, error: noop, info: noop, debug: noop } as Console;
}

export {};
