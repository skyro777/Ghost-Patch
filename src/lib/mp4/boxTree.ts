/**
 * GhostPatch MP4 engine — ISOBMFF box tree parsing + mutable rebuild machinery.
 *
 * Parsing rules (strict, tree-walk only — we NEVER scan raw bytes for box
 * names, since e.g. "moov" can legitimately occur inside mdat payload bytes):
 *  - size == 1  → 64-bit largesize follows the type field (headerSize 16).
 *  - size == 0  → box extends to the end of the walked region (slice callers
 *                 resolve the real end themselves).
 *  - A box whose declared size exceeds the walked region is still emitted
 *                 (with dataEnd beyond the region) so slice scanners can see
 *                 e.g. a truncated mdat header; iteration stops after it and
 *                 it is never recursed into.
 *  - Only known container boxes are recursed into. `meta` may carry a 4-byte
 *                 version/flags prefix before its children; we detect it by
 *                 probing (children-parse at +4 first, then at +0), matching
 *                 what the reference implementations do.
 */

import type { BoxNode } from './types';

/** Boxes we treat as containers and recurse into. Everything else is opaque. */
const CONTAINER_TYPES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'dinf',
  'mvex', 'moof', 'traf', 'meta', 'ilst', '\u00A9too',
]);

const MAX_DEPTH = 12;

function readU64(buf: Buffer, off: number): number {
  return Number(buf.readBigUInt64BE(off));
}

/** Does a syntactically valid first box start at `p` within [p, end)? */
function plausibleFirstChild(buf: Buffer, p: number, end: number): boolean {
  if (p + 8 > end) return false;
  const size = buf.readUInt32BE(p);
  if (size === 1) {
    if (p + 16 > end) return false;
    const large = readU64(buf, p + 8);
    return large >= 16 && p + large <= end;
  }
  if (size === 0) return false; // "to end of region" makes no sense inside meta
  return size >= 8 && p + size <= end;
}

/**
 * Walk boxes in buf[start, end). `baseOffset` is added to every emitted
 * offset, so a buffer that is a slice of a larger file reports ABSOLUTE
 * file offsets. Pass 0 when the buffer is the whole file.
 */
export function parseBoxes(
  buf: Buffer,
  start: number,
  end: number,
  baseOffset: number,
  depth = 0,
): BoxNode[] {
  const nodes: BoxNode[] = [];
  if (depth > MAX_DEPTH) return nodes;
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    let headerSize = 8;
    let zeroSize = false;
    if (size === 1) {
      if (pos + 16 > end) break; // cannot even read the largesize
      size = readU64(buf, pos + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos; // extends to the end of the region we know about
      zeroSize = true;
    }
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size < headerSize) break; // malformed; stop walking
    if (pos + size > end) {
      // Declared size spills past the region (e.g. mdat truncated by a
      // slice). Emit the node so callers can see its header, then stop.
      nodes.push({
        type,
        start: baseOffset + pos,
        size,
        headerSize,
        dataStart: baseOffset + pos + headerSize,
        dataEnd: baseOffset + pos + size,
      });
      break;
    }
    const node: BoxNode = {
      type,
      start: baseOffset + pos,
      size,
      headerSize,
      dataStart: baseOffset + pos + headerSize,
      dataEnd: baseOffset + pos + size,
      zeroSize,
    };
    if (CONTAINER_TYPES.has(type)) {
      let childStart = pos + headerSize;
      let childEnd = pos + size;
      if (type === 'meta') {
        // meta may be a full box (4-byte version/flags before children).
        const withPrefix = plausibleFirstChild(buf, childStart + 4, childEnd);
        const bare = plausibleFirstChild(buf, childStart, childEnd);
        if (withPrefix) childStart += 4;
        else if (!bare) childEnd = childStart; // opaque meta → no children
      }
      if (childEnd > childStart) {
        node.children = parseBoxes(buf, childStart, childEnd, baseOffset, depth + 1);
      }
    }
    nodes.push(node);
    pos += size;
  }
  return nodes;
}

/**
 * Find the first box matching a dotted path like 'moov.trak.mdia.mdhd'.
 * Matches FIRST occurrence at every level (iterate children yourself when a
 * file has multiple tracks).
 */
export function findBox(nodes: BoxNode[], path: string): BoxNode | null {
  const parts = path.split('.');
  let current: BoxNode[] = nodes;
  let found: BoxNode | null = null;
  for (const part of parts) {
    found = current.find((n) => n.type === part) ?? null;
    if (!found) return null;
    current = found.children ?? [];
  }
  return found;
}

// ---------------------------------------------------------------------------
// Mutable tree — the patcher rebuilds the moov with targeted edits.
//
// A parsed BoxNode tree is a read-only view over a buffer. To patch, we
// convert the moov into MutNodes: containers become editable node lists and
// leaves own their payload bytes. Serializing recomputes every size field,
// so any insertion/removal inside the tree "just works".
// ---------------------------------------------------------------------------

export interface MutLeaf {
  kind: 'leaf';
  type: Buffer; // 4 bytes
  raw: Buffer; // payload (header NOT included)
}

export interface MutBox {
  kind: 'box';
  type: Buffer; // 4 bytes
  prefix: Buffer; // bytes between container payload start and first child (meta: version/flags)
  children: MutNode[];
}

export type MutNode = MutLeaf | MutBox;

/** Encode a 4-character code as raw bytes (latin1, so '\xA9too' works). */
export function type4cc(type: string): Buffer {
  const b = Buffer.from(type, 'latin1');
  if (b.length !== 4) throw new Error(`BAD_4CC: ${JSON.stringify(type)} (need exactly 4 chars)`);
  return b;
}

export function ccs4(type: Buffer): string {
  return type.toString('latin1');
}

export function makeLeaf(type: string, raw: Buffer): MutLeaf {
  return { kind: 'leaf', type: type4cc(type), raw };
}

export function makeBox(type: string, children: MutNode[] = [], prefix: Buffer = Buffer.alloc(0)): MutBox {
  return { kind: 'box', type: type4cc(type), prefix, children };
}

/**
 * Convert parsed BoxNodes (whose offsets index into `buf`) into a mutable
 * tree. `buf` must be the SAME buffer the nodes were parsed from, with
 * baseOffset 0 (offsets relative to buf) — the patcher parses the moov buffer
 * that way before calling this.
 */
export function mutTreeFromParsed(buf: Buffer, nodes: BoxNode[]): MutNode[] {
  return nodes.map((n): MutNode => {
    if (n.children && n.children.length > 0) {
      const childStart = n.children[0].start; // absolute == buf index here
      const prefix = buf.subarray(n.dataStart, childStart);
      return { kind: 'box', type: buf.subarray(n.start + 4, n.start + 8), prefix, children: mutTreeFromParsed(buf, n.children) };
    }
    if (n.children) {
      // Container that yielded no children (e.g. opaque meta) — keep any
      // conventional prefix bytes inside the payload as prefix, rest as leaf.
      const isMeta = n.type === 'meta';
      const prefixLen = isMeta ? Math.min(4, n.dataEnd - n.dataStart) : 0;
      const prefix = buf.subarray(n.dataStart, n.dataStart + prefixLen);
      const raw = buf.subarray(n.dataStart + prefixLen, n.dataEnd);
      if (raw.length === 0) {
        return { kind: 'box', type: buf.subarray(n.start + 4, n.start + 8), prefix, children: [] };
      }
      // Non-empty opaque payload: model as a box whose "prefix" holds it all.
      return { kind: 'box', type: buf.subarray(n.start + 4, n.start + 8), prefix: Buffer.concat([prefix, raw]), children: [] };
    }
    return { kind: 'leaf', type: buf.subarray(n.start + 4, n.start + 8), raw: buf.subarray(n.dataStart, n.dataEnd) };
  });
}

/** Direct children of a mutable box with the given 4cc type. */
export function mutChildrenOf(node: MutBox, type: string): MutNode[] {
  const t = type4cc(type);
  return node.children.filter((c) => c.type.equals(t));
}

export function mutChildOf(node: MutBox, type: string): MutBox | MutLeaf | undefined {
  const t = type4cc(type);
  return node.children.find((c) => c.type.equals(t));
}

/** Deep, pre-order search for nodes of a given type across the whole tree. */
export function mutFindAll(nodes: MutNode[], type: string): MutNode[] {
  const t = type4cc(type);
  const out: MutNode[] = [];
  const walk = (list: MutNode[]): void => {
    for (const n of list) {
      if (n.type.equals(t)) out.push(n);
      if (n.kind === 'box') walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function mutIsBox(n: MutNode | undefined): n is MutBox {
  return !!n && n.kind === 'box';
}

export function mutIsLeaf(n: MutNode | undefined): n is MutLeaf {
  return !!n && n.kind === 'leaf';
}

/** Serialize a mutable tree back into box bytes (sizes recomputed top-down). */
export function serializeMutTree(nodes: MutNode[]): Buffer {
  const parts: Buffer[] = [];
  for (const n of nodes) parts.push(serializeMutNode(n));
  return Buffer.concat(parts);
}

function serializeMutNode(node: MutNode): Buffer {
  let payload: Buffer;
  if (node.kind === 'box') {
    const kids = serializeMutTree(node.children);
    payload = node.prefix.length ? Buffer.concat([node.prefix, kids]) : kids;
  } else {
    payload = node.raw;
  }
  const total = 8 + payload.length;
  const header = Buffer.alloc(total >= 0x100000000 ? 16 : 8);
  if (total >= 0x100000000) {
    header.writeUInt32BE(1, 0);
    node.type.copy(header, 4);
    header.writeBigUInt64BE(BigInt(total), 8);
  } else {
    header.writeUInt32BE(total, 0);
    node.type.copy(header, 4);
  }
  return Buffer.concat([header, payload]);
}
