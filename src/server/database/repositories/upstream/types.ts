import type { InferSelectModel } from 'drizzle-orm';
import z from 'zod';
import type { upstreamServer } from './schema';

export type UpstreamServerType = InferSelectModel<typeof upstreamServer>;

export type CreateUpstreamType = Omit<
  UpstreamServerType,
  'id' | 'createdAt' | 'updatedAt' | 'interfaceName'
>;

export type UpdateUpstreamType = Partial<
  Omit<CreateUpstreamType, 'privateKey' | 'publicKey'>
>;

const name = z
  .string({ message: t('zod.upstream.name') })
  .min(1, t('zod.upstream.name'))
  .pipe(safeStringRefine);

const endpoint = z
  .string({ message: t('zod.upstream.endpoint') })
  .regex(/^[^:]+:\d+$/, t('zod.upstream.endpointFormat'))
  .pipe(safeStringRefine);

const publicKey = z
  .string({ message: t('zod.upstream.publicKey') })
  .length(44, t('zod.upstream.keyLength'));

const privateKey = z
  .string({ message: t('zod.upstream.privateKey') })
  .length(44, t('zod.upstream.keyLength'));

const presharedKey = z
  .string({ message: t('zod.upstream.presharedKey') })
  .length(44, t('zod.upstream.keyLength'))
  .optional();

const allowedIps = z
  .array(AddressSchema, { message: t('zod.upstream.allowedIps') })
  .min(1, t('zod.upstream.allowedIpsMin'));

export const UpstreamCreateSchema = z.object({
  name: name,
  endpoint: endpoint,
  publicKey: publicKey,
  privateKey: privateKey,
  presharedKey: presharedKey,
  allowedIps: allowedIps,
  persistentKeepalive: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(25),
  mtu: MtuSchema.default(1360),
  enabled: EnabledSchema.default(true),
});

export const UpstreamUpdateSchema = z.object({
  name: name.optional(),
  endpoint: endpoint.optional(),
  publicKey: publicKey.optional(),
  presharedKey: presharedKey.optional(),
  allowedIps: allowedIps.optional(),
  persistentKeepalive: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .optional(),
  mtu: MtuSchema.optional(),
  enabled: EnabledSchema.optional(),
});

const upstreamId = z.coerce.number({ message: t('zod.upstream.id') });

export const UpstreamGetSchema = z.object({
  upstreamId: upstreamId,
});
