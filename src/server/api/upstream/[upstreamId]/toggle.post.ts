import { UpstreamGetSchema } from '#db/repositories/upstream/types';

export default definePermissionEventHandler(
  'upstream',
  'update',
  async ({ event }) => {
    const { upstreamId } = await getValidatedRouterParams(
      event,
      validateZod(UpstreamGetSchema, event)
    );

    const { enabled } = await readValidatedBody(
      event,
      validateZod(EnabledSchemaWrapper, event)
    );

    await Database.upstreams.toggle(upstreamId, enabled);

    // Apply split tunneling configurations
    await SplitTunneling.applyAllConfigs();

    return { success: true };
  }
);
