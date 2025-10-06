import type { InferSelectModel } from 'drizzle-orm';
import z from 'zod';

import type { client } from './schema';
import {
  createDefaultSplitTunnelConfig,
  createDefaultUpstreamConfig,
  normalizeSplitTunnelConfig,
  normalizeUpstreamConfig,
} from '#shared/client-routing';
import type {
  ClientSplitTunnelConfig,
  ClientUpstreamConfig,
} from '#shared/client-routing';

type ClientRow = InferSelectModel<typeof client>;

export type ClientType = Omit<ClientRow, 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
  upstream: ClientUpstreamConfig | null;
  splitTunnel: ClientSplitTunnelConfig | null;
};

export type ClientNextIpType = Pick<ClientRow, 'ipv4Address' | 'ipv6Address'>;

export type CreateClientType = Omit<
  ClientRow,
  'createdAt' | 'updatedAt' | 'id'
>;

export type UpdateClientType = Omit<
  CreateClientType,
  'privateKey' | 'publicKey' | 'preSharedKey' | 'userId' | 'interfaceId'
>;

const name = z
  .string({ message: t('zod.client.name') })
  .min(1, t('zod.client.name'))
  .pipe(safeStringRefine);

// TODO?: validate iso string
const expiresAt = z
  .string({ message: t('zod.client.expiresAt') })
  .min(1, t('zod.client.expiresAt'))
  .pipe(safeStringRefine)
  .nullable();

const address4 = z
  .string({ message: t('zod.client.address4') })
  .min(1, { message: t('zod.client.address4') })
  .pipe(safeStringRefine);

const address6 = z
  .string({ message: t('zod.client.address6') })
  .min(1, { message: t('zod.client.address6') })
  .pipe(safeStringRefine);

const serverAllowedIps = z.array(AddressSchema, {
  message: t('zod.client.serverAllowedIps'),
});

const upstreamSchema = schemaForType<ClientUpstreamConfig>()(
  z
    .object({
      enabled: EnabledSchema,
      endpointHost: z
        .string({ message: t('zod.client.upstreamHost') })
        .min(1, { message: t('zod.client.upstreamHost') })
        .pipe(safeStringRefine)
        .nullable(),
      endpointPort: PortSchema.nullable(),
      publicKey: z
        .string({ message: t('zod.client.upstreamPublicKey') })
        .min(1, { message: t('zod.client.upstreamPublicKey') })
        .pipe(safeStringRefine)
        .nullable(),
      preSharedKey: z
        .string({ message: t('zod.client.upstreamPreSharedKey') })
        .min(1, { message: t('zod.client.upstreamPreSharedKey') })
        .pipe(safeStringRefine)
        .nullable(),
      clientPrivateKey: z
        .string({ message: t('zod.client.upstreamClientKey') })
        .min(1, { message: t('zod.client.upstreamClientKey') })
        .pipe(safeStringRefine)
        .nullable(),
      allowedIps: z
        .array(AddressSchema, {
          message: t('zod.client.upstreamAllowedIps'),
        })
        .default([]),
      tunnelAddress: AddressSchema.nullable(),
      persistentKeepalive: PersistentKeepaliveSchema.nullable(),
    })
    .transform((value) => normalizeUpstreamConfig(value))
    .superRefine((value, ctx) => {
      if (!value.enabled) {
        return;
      }

      if (!value.endpointHost) {
        ctx.addIssue({
          path: ['endpointHost'],
          code: z.ZodIssueCode.custom,
          message: t('zod.client.upstreamHost'),
        });
      }
      if (!value.endpointPort) {
        ctx.addIssue({
          path: ['endpointPort'],
          code: z.ZodIssueCode.custom,
          message: t('zod.client.upstreamPort'),
        });
      }
      if (!value.publicKey) {
        ctx.addIssue({
          path: ['publicKey'],
          code: z.ZodIssueCode.custom,
          message: t('zod.client.upstreamPublicKey'),
        });
      }
      if (!value.clientPrivateKey) {
        ctx.addIssue({
          path: ['clientPrivateKey'],
          code: z.ZodIssueCode.custom,
          message: t('zod.client.upstreamClientKey'),
        });
      }
      if (!value.tunnelAddress) {
        ctx.addIssue({
          path: ['tunnelAddress'],
          code: z.ZodIssueCode.custom,
          message: t('zod.client.upstreamTunnelAddress'),
        });
      }
    })
    .default(createDefaultUpstreamConfig())
);

const splitTunnelRuleSchema = z
  .string({ message: t('zod.client.splitTunnelDomain') })
  .min(1, { message: t('zod.client.splitTunnelDomain') })
  .pipe(safeStringRefine);

const splitTunnelSchema = schemaForType<ClientSplitTunnelConfig>()(
  z
    .object({
      mode: z.enum(['direct', 'upstream', 'custom'], {
        message: t('zod.client.splitTunnelMode'),
      }),
      proxyRules: z
        .array(splitTunnelRuleSchema, {
          message: t('zod.client.splitTunnelDomain'),
        })
        .default([]),
      directRules: z
        .array(splitTunnelRuleSchema, {
          message: t('zod.client.splitTunnelDomain'),
        })
        .default([]),
    })
    .transform((value) => normalizeSplitTunnelConfig(value))
    .default(createDefaultSplitTunnelConfig())
);

export const ClientCreateSchema = z.object({
  name: name,
  expiresAt: expiresAt,
});

export type ClientCreateType = z.infer<typeof ClientCreateSchema>;

export const ClientUpdateSchema = schemaForType<UpdateClientType>()(
  z.object({
    name: name,
    enabled: EnabledSchema,
    expiresAt: expiresAt,
    ipv4Address: address4,
    ipv6Address: address6,
    preUp: HookSchema,
    postUp: HookSchema,
    preDown: HookSchema,
    postDown: HookSchema,
    allowedIps: AllowedIpsSchema.nullable(),
    serverAllowedIps: serverAllowedIps,
    mtu: MtuSchema,
    persistentKeepalive: PersistentKeepaliveSchema,
    serverEndpoint: AddressSchema.nullable(),
    dns: DnsSchema.nullable(),
    upstream: upstreamSchema,
    splitTunnel: splitTunnelSchema,
  })
);

// TODO: investigate if coerce is bad
const clientId = z.coerce.number({ message: t('zod.client.id') });

export const ClientGetSchema = z.object({
  clientId: clientId,
});

export type ClientCreateFromExistingType = Pick<
  ClientType,
  | 'name'
  | 'ipv4Address'
  | 'ipv6Address'
  | 'privateKey'
  | 'preSharedKey'
  | 'publicKey'
  | 'enabled'
>;
