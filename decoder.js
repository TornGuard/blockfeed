/**
 * OPNet event raw_data decoder.
 * All fields in OPNet events are 32-byte big-endian chunks (Base64-encoded).
 *
 * Known layouts (from OIP-0020):
 *   Transferred  128 bytes: operator(32) + from(32) + to(32) + amount(32)
 *   Minted        64 bytes: to(32) + amount(32)
 *   Burned        64 bytes: from(32) + amount(32)
 *   SwapCreated  variable: parsed as generic named chunks
 */

function addr(buf, offset) {
  return '0x' + buf.subarray(offset, offset + 32).toString('hex');
}

function uint256(buf, offset) {
  return BigInt('0x' + buf.subarray(offset, offset + 32).toString('hex')).toString();
}

export function decodeEvent(eventType, rawDataB64) {
  if (!rawDataB64) return null;
  try {
    const buf = Buffer.from(rawDataB64, 'base64');

    switch (eventType) {
      case 'Transferred':
        if (buf.length < 128) return null;
        return {
          operator: addr(buf, 0),
          from:     addr(buf, 32),
          to:       addr(buf, 64),
          amount:   uint256(buf, 96),
        };

      case 'Minted':
        if (buf.length < 64) return null;
        return {
          to:     addr(buf, 0),
          amount: uint256(buf, 32),
        };

      case 'Burned':
        if (buf.length < 64) return null;
        return {
          from:   addr(buf, 0),
          amount: uint256(buf, 32),
        };

      default:
        // For unknown event types store byte length so callers know something is there
        return { bytes: buf.length };
    }
  } catch {
    return null;
  }
}
