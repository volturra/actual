// Minimal Intl.NumberFormat stand-in for engines built without Intl (QuickJS,
// Hermes on Linux, Porffor). The workloads only construct it; currencyToAmount
// never calls format(), so behaviour is unchanged where real Intl exists.
if (typeof globalThis.Intl === 'undefined') {
  globalThis.Intl = {
    NumberFormat: function () {
      return {
        format: function (v) {
          return String(v);
        },
      };
    },
  };
}
// UTF-8 TextEncoder for engines without one (murmurhash in the crdt package
// encodes timestamps with it). Byte-for-byte identical to the WHATWG encoder
// for well-formed strings, which is all the workloads produce.
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = function () {};
  globalThis.TextEncoder.prototype.encode = function (s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
        c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000)
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 63),
          0x80 | ((c >> 6) & 63),
          0x80 | (c & 63),
        );
    }
    return new Uint8Array(out);
  };
}
// UTF-8 TextDecoder counterpart (protobuf string fields).
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = function () {};
  globalThis.TextDecoder.prototype.decode = function (bytes) {
    var s = '';
    for (var i = 0; i < bytes.length;) {
      var b = bytes[i++],
        c;
      if (b < 0x80) c = b;
      else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
      else if (b < 0xf0)
        c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      else
        c =
          ((b & 7) << 18) |
          ((bytes[i++] & 63) << 12) |
          ((bytes[i++] & 63) << 6) |
          (bytes[i++] & 63);
      if (c > 0xffff) {
        c -= 0x10000;
        s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023));
      } else s += String.fromCharCode(c);
    }
    return s;
  };
}
