import { UpstreamGetSchema } from '#db/repositories/upstream/types';

export default definePermissionEventHandler(
  'upstream',
  'read',
  async ({ event }) => {
    const { upstreamId } = await getValidatedRouterParams(
      event,
      validateZod(UpstreamGetSchema, event)
    );

    const upstream = await Database.upstreams.get(upstreamId);

    if (!upstream) {
      throw createError({
        statusCode: 404,
        message: 'Upstream server not found',
      });
    }

    // Don't return sensitive information
    const { privateKey, presharedKey, ...safeUpstream } = upstream;

    return {
      upstream: {
        ...safeUpstream,
        hasPrivateKey: !!privateKey,
        hasPresharedKey: !!presharedKey,
      },
    };
  }
);
