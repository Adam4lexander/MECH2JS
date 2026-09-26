/**
 * Unpacks MW2.EXE (a DOS/4GW LE executable) into the flat, fully relocated
 * memory image the game ran from, so the port can read the tables that live
 * in the executable - weapons, AI rules, behaviours, control channels,
 * gamepiece classes - at their original addresses.
 *
 * A line-for-line port of decompiled/tools/le_unpack.py; the golden test
 * checks the result is byte-identical to decompiled/mw2/build/image.bin.
 *
 * @portOnly executable loader (DOS/4GW's job in the original)
 */

const SRC_BYTE = 0, SRC_SEL16 = 2, SRC_PTR32 = 3, SRC_OFF16 = 5, SRC_PTR48 = 6, SRC_OFF32 = 7, SRC_REL32 = 8;
const SRC_MASK = 0x0f, SRC_LIST = 0x20;
const TGT_TYPE_MASK = 0x03, TGT_INTERNAL = 0x00;
const TGT_ADDITIVE = 0x04, TGT_OFF32 = 0x10, TGT_ADD32 = 0x20, TGT_OBJ16 = 0x40;

export interface LeObject {
  index: number;
  virtualSize: number;
  base: number;
  flags: number;
  firstPage: number;
  pageCount: number;
  readable: boolean;
  writable: boolean;
  executable: boolean;
}

export interface FixupStats {
  off32: number;
  rel32: number;
  off16: number;
  byte: number;
  selector: number;
  unknownSrc: number;
  outOfRange: number;
  badObject: number;
  skippedNonintern: number;
}

export interface UnpackedImage {
  low: number;
  high: number;
  bytes: Uint8Array;
  objects: LeObject[];
  entryPoint: number;
  initialEsp: number;
  fixups: FixupStats;
  pagesLoaded: number;
  pagesZeroFilled: number;
}

export function unpackLe(data: Uint8Array): UnpackedImage {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u8 = (o: number) => data[o]!;
  const u16 = (o: number) => dv.getUint16(o, true);
  const i16 = (o: number) => dv.getInt16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);

  if (!((u8(0) === 0x4d && u8(1) === 0x5a) || (u8(0) === 0x5a && u8(1) === 0x4d))) throw new Error('not an MZ executable');
  let base = u32(0x3c);
  if (!(u8(base) === 0x4c && u8(base + 1) === 0x45)) {
    base = -1;
    for (let i = 0; i + 3 < data.length; i++) {
      if (data[i] === 0x4c && data[i + 1] === 0x45 && data[i + 2] === 0 && data[i + 3] === 0) {
        base = i;
        break;
      }
    }
    if (base < 0) throw new Error('no LE header found');
  }
  const H = (rel: number) => u32(base + rel);
  const pageCount = H(0x14);
  const eipObject = H(0x18);
  const eipOffset = H(0x1c);
  const espObject = H(0x20);
  const espOffset = H(0x24);
  const pageSize = H(0x28);
  const lastPageSize = H(0x2c);
  const objectTable = base + H(0x40);
  const objectCount = H(0x44);
  const pageMap = base + H(0x48);
  const fixupPageTable = base + H(0x68);
  const fixupRecordTable = base + H(0x6c);
  const dataPages = H(0x80); // relative to the file start, unlike the others

  const objects: LeObject[] = [];
  for (let i = 0; i < objectCount; i++) {
    const o = objectTable + i * 24;
    const flags = u32(o + 8);
    objects.push({
      index: i + 1,
      virtualSize: u32(o),
      base: u32(o + 4),
      flags,
      firstPage: u32(o + 12),
      pageCount: u32(o + 16),
      readable: (flags & 1) !== 0,
      writable: (flags & 2) !== 0,
      executable: (flags & 4) !== 0,
    });
  }

  const low = Math.min(...objects.map((o) => o.base));
  let high = Math.max(...objects.map((o) => o.base + o.virtualSize));
  high = (high + 0xfff) & ~0xfff;
  const buf = new Uint8Array(high - low);
  const bdv = new DataView(buf.buffer);
  const contains = (addr: number, len: number) => low <= addr && addr + len <= high;

  const pageFileOffset = (pageIndex: number): number | null => {
    const e = pageMap + (pageIndex - 1) * 4;
    const physical = (u8(e) << 16) | (u8(e + 1) << 8) | u8(e + 2);
    if (u8(e + 3) !== 0) return null;
    return dataPages + (physical - 1) * pageSize;
  };

  let pagesLoaded = 0;
  let pagesZeroFilled = 0;
  for (const obj of objects) {
    for (let n = 0; n < obj.pageCount; n++) {
      const pageIndex = obj.firstPage + n;
      const addr = obj.base + n * pageSize;
      const off = pageFileOffset(pageIndex);
      if (off === null) {
        pagesZeroFilled++;
        continue;
      }
      let size = pageSize;
      if (pageIndex === pageCount && lastPageSize) size = lastPageSize;
      const blob = data.subarray(off, Math.min(off + size, data.length));
      buf.set(blob.subarray(0, Math.min(blob.length, buf.length - (addr - low))), addr - low);
      pagesLoaded++;
    }
  }

  const stats: FixupStats = { off32: 0, rel32: 0, off16: 0, byte: 0, selector: 0, unknownSrc: 0, outOfRange: 0, badObject: 0, skippedNonintern: 0 };

  const applyPage = (pageIndex: number, pageBase: number) => {
    const start = u32(fixupPageTable + (pageIndex - 1) * 4);
    const end = u32(fixupPageTable + pageIndex * 4);
    let pos = fixupRecordTable + start;
    const stop = fixupRecordTable + end;
    while (pos < stop) {
      const src = u8(pos);
      const flags = u8(pos + 1);
      pos += 2;
      const srcType = src & SRC_MASK;
      let count = 1;
      let offsets: number[] | null = null;
      if (src & SRC_LIST) {
        count = u8(pos);
        pos += 1;
      } else {
        offsets = [i16(pos)];
        pos += 2;
      }
      const targetType = flags & TGT_TYPE_MASK;
      if (targetType !== TGT_INTERNAL) {
        stats.skippedNonintern++;
        pos += flags & TGT_OBJ16 ? 2 : 1;
        if (targetType === 1 || targetType === 2) pos += flags & TGT_OFF32 ? 4 : 2;
        if (flags & TGT_ADDITIVE) pos += flags & TGT_ADD32 ? 4 : 2;
        if (src & SRC_LIST) pos += count * 2;
        continue;
      }
      let objNum: number;
      if (flags & TGT_OBJ16) {
        objNum = u16(pos);
        pos += 2;
      } else {
        objNum = u8(pos);
        pos += 1;
      }
      let targetOffset = 0;
      if (srcType !== SRC_SEL16) {
        if (flags & TGT_OFF32) {
          targetOffset = u32(pos);
          pos += 4;
        } else {
          targetOffset = u16(pos);
          pos += 2;
        }
      }
      let additive = 0;
      if (flags & TGT_ADDITIVE) {
        if (flags & TGT_ADD32) {
          additive = u32(pos);
          pos += 4;
        } else {
          additive = u16(pos);
          pos += 2;
        }
      }
      if (offsets === null) {
        offsets = [];
        for (let k = 0; k < count; k++) offsets.push(i16(pos + k * 2));
        pos += count * 2;
      }
      if (!(objNum > 0 && objNum <= objects.length)) {
        stats.badObject++;
        continue;
      }
      const target = objects[objNum - 1]!.base + targetOffset + additive;
      for (const so of offsets) {
        const addr = pageBase + so;
        if (srcType === SRC_OFF32 || srcType === SRC_PTR32 || srcType === SRC_PTR48) {
          if (!contains(addr, srcType === SRC_PTR48 ? 6 : 4)) {
            stats.outOfRange++;
            continue;
          }
          bdv.setUint32(addr - low, target >>> 0, true);
          stats.off32++;
        } else if (srcType === SRC_REL32) {
          if (!contains(addr, 4)) {
            stats.outOfRange++;
            continue;
          }
          bdv.setUint32(addr - low, (target - (addr + 4)) >>> 0, true);
          stats.rel32++;
        } else if (srcType === SRC_OFF16) {
          if (!contains(addr, 2)) {
            stats.outOfRange++;
            continue;
          }
          bdv.setUint16(addr - low, target & 0xffff, true);
          stats.off16++;
        } else if (srcType === SRC_SEL16) {
          stats.selector++;
        } else if (srcType === SRC_BYTE) {
          stats.byte++;
        } else {
          stats.unknownSrc++;
        }
      }
    }
  };

  for (const obj of objects) {
    for (let n = 0; n < obj.pageCount; n++) applyPage(obj.firstPage + n, obj.base + n * pageSize);
  }

  return {
    low,
    high,
    bytes: buf,
    objects,
    entryPoint: objects[eipObject - 1]!.base + eipOffset,
    initialEsp: objects[espObject - 1]!.base + espOffset,
    fixups: stats,
    pagesLoaded,
    pagesZeroFilled,
  };
}
