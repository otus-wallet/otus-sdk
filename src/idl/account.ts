// An account read by its program's IDL: the account it declares by `name`, when the data starts with that account's
// discriminator, decoded field by field. Anything that doesn't fit is no such account.
import { getNodeCodecVisitor, getValueNodeVisitor } from '@codama/dynamic-codecs';
import { isNode, VALUE_NODE_KINDS, type AccountNode } from '@codama/nodes';
import { NodeStack, visit } from '@codama/visitors-core';
import type { ReadonlyUint8Array } from '@solana/kit';

import { linkablesOf } from './explain.ts';
import type { Idl } from './read.ts';

/** `data` as the account `name` of `idl`, its fields by their names; null when it is not one. Never throws. */
export function accountByIdl(idl: Idl, name: string, data: ReadonlyUint8Array): Record<string, unknown> | null {
    try {
        const { root } = idl;
        const account = (root.program.accounts ?? []).find((a) => a.name === name);
        if (!account || !account.discriminators?.length) return null;
        const linkables = linkablesOf(root);
        const stack = new NodeStack([root, root.program]);
        if (!starts(account, data, getNodeCodecVisitor(linkables, { stack }), getValueNodeVisitor(linkables, { stack }))) return null;
        // What follows its fields is room left for it to grow, never read.
        const [decoded] = visit(account, getNodeCodecVisitor(linkables, { stack })).read(data, 0);
        return decoded as Record<string, unknown>;
    } catch {
        return null;
    }
}

// Whether the data starts as the account's discriminators say: a field's default value at its offset, or a size.
function starts(account: AccountNode, data: ReadonlyUint8Array, codecs: ReturnType<typeof getNodeCodecVisitor>, values: ReturnType<typeof getValueNodeVisitor>): boolean {
    const fields = (account.data.kind === 'structTypeNode' ? account.data.fields : undefined) ?? [];
    return (account.discriminators ?? []).every((d) => {
        if (d.kind === 'sizeDiscriminatorNode') return data.length === d.size;
        if (d.kind !== 'fieldDiscriminatorNode') return false;
        const field = fields.find((f) => f.name === d.name);
        if (!field || !isNode(field.defaultValue, VALUE_NODE_KINDS)) return false;
        const bytes = visit(field.type, codecs).encode(visit(field.defaultValue, values));
        return d.offset + bytes.length <= data.length && bytes.every((b, i) => data[d.offset + i] === b);
    });
}
