// Sync wire format: encode/decode SyncRequest/SyncResponse protobufs the way
// every sync round trip does (@bufbuild/protobuf, generated sync_pb.ts).
import {
  create,
  fromBinary,
  MessageEnvelopeSchema,
  MessageSchema,
  SyncRequestSchema,
  toBinary,
} from '../../../packages/crdt/src';

import { mix, rng } from './common';

export function bench(n: number): number {
  const r = rng(8);
  let h = 2166136261;
  for (let round = 0; round < n; round++) {
    const envelopes = [];
    for (let i = 0; i < 100; i++) {
      const msg = create(MessageSchema, {
        dataset: 'transactions',
        row: 'row-' + Math.floor(r() * 1e9).toString(16),
        column: i % 2 ? 'amount' : 'notes',
        value:
          i % 2
            ? 'N:' + Math.floor(r() * 100000)
            : 'S:Grocery run ' + i + ' ünïcødé',
      });
      envelopes.push(
        create(MessageEnvelopeSchema, {
          timestamp:
            '2025-01-01T00:00:00.000Z-' +
            ('0000' + i.toString(16)).slice(-4).toUpperCase() +
            '-0123456789abcdef',
          isEncrypted: false,
          content: toBinary(MessageSchema, msg),
        }),
      );
    }
    const req = create(SyncRequestSchema, {
      messages: envelopes,
      fileId: 'file',
      groupId: 'group',
      keyId: '',
      since: '2025-01-01T00:00:00.000Z-0000-0123456789abcdef',
    });
    const bytes = toBinary(SyncRequestSchema, req);
    h = mix(h, bytes.length);
    const back = fromBinary(SyncRequestSchema, bytes);
    for (const env of back.messages) {
      const m = fromBinary(MessageSchema, env.content);
      h = mix(h, m.row);
      h = mix(h, m.value);
    }
  }
  return h;
}
