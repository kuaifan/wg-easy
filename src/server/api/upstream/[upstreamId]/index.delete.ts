import { UpstreamGetSchema } from '#db/repositories/upstream/types';

export default definePermissionEventHandler(
  'upstream',
  'delete',
  async ({ event }) => {
    const { upstreamId } = await getValidatedRouterParams(
      event,
      validateZod(UpstreamGetSchema, event)
    );

    // Check if any clients are using this upstream
    const clients = await Database.clients.getAll();
    const usingClients = clients.filter((c) => c.upstreamId === upstreamId);

    if (usingClients.length > 0) {
      throw createError({
        statusCode: 400,
        message: `Cannot delete upstream: ${usingClients.length} client(s) are using it`,
      });
    }

    const upstream = await Database.upstreams.get(upstreamId);
    if (upstream) {
      await SplitTunneling.stopUpstreamInterface(upstream.interfaceName);
    }

    await Database.upstreams.delete(upstreamId);

    return { success: true };
  }
);
