/**
 * Contract event decoder.
 * Converts raw event calldata bytes into human-readable decoded objects.
 */

type DecodedEvent = Record<string, string | number | boolean | null>;

function addr(buf: Uint8Array, offset: number): string {
    return '0x' + Buffer.from(buf.slice(offset, offset + 32)).toString('hex');
}

function uint256(buf: Uint8Array, offset: number): string {
    return BigInt('0x' + Buffer.from(buf.slice(offset, offset + 32)).toString('hex')).toString();
}

export function decodeEvent(eventType: string, hexData: string): DecodedEvent | null {
    if (!hexData) return null;
    const buf = Buffer.from(hexData.replace(/^0x/, ''), 'hex');
    if (buf.length === 0) return null;

    try {
        switch (eventType) {
            case 'Transferred':
                if (buf.length < 96) return null;
                return { from: addr(buf, 0), to: addr(buf, 32), amount: uint256(buf, 64) };

            case 'Mint':
                if (buf.length < 64) return null;
                return { to: addr(buf, 0), amount: uint256(buf, 32) };

            case 'Burn':
                if (buf.length < 64) return null;
                return { from: addr(buf, 0), amount: uint256(buf, 32) };

            case 'Approval':
                if (buf.length < 96) return null;
                return { owner: addr(buf, 0), spender: addr(buf, 32), amount: uint256(buf, 64) };

            case 'OwnershipTransferred':
                if (buf.length < 64) return null;
                return { previous_owner: addr(buf, 0), new_owner: addr(buf, 32) };

            case 'SwapExecuted':
            case 'Swap':
                if (buf.length < 128) return null;
                return { sender: addr(buf, 0), amount_in: uint256(buf, 32), amount_out: uint256(buf, 64), to: addr(buf, 96) };

            case 'LiquidityAdded':
                if (buf.length < 96) return null;
                return { provider: addr(buf, 0), amount0: uint256(buf, 32), amount1: uint256(buf, 64) };

            case 'LiquidityRemoved':
                if (buf.length < 96) return null;
                return { provider: addr(buf, 0), amount0: uint256(buf, 32), amount1: uint256(buf, 64) };

            case 'PresalePurchase':
                if (buf.length < 128) return null;
                return { buyer: addr(buf, 0), payment_token: addr(buf, 32), amount_paid: uint256(buf, 64), tokens_minted: uint256(buf, 96) };

            case 'AirdropClaimed':
                if (buf.length < 64) return null;
                return { recipient: addr(buf, 0), amount: uint256(buf, 32) };

            case 'BetPlaced':
                if (buf.length < 128) return null;
                return { bettor: addr(buf, 0), bet_id: uint256(buf, 32), bet_type: uint256(buf, 64), amount: uint256(buf, 96) };

            case 'BetResolved':
                if (buf.length < 128) return null;
                return { bet_id: uint256(buf, 0), winner: addr(buf, 32), won: buf[63] !== 0, payout: uint256(buf, 64) };

            default:
                return { bytes: buf.length };
        }
    } catch {
        return null;
    }
}
