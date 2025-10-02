import {
  UpstreamGetSchema,
  UpstreamUpdateSchema,
} from '#db/repositories/upstream/types';

export default definePermissionEventHandler(
  'upstream',
  'update',
  async ({ event }) => {
    const { upstreamId } = await getValidatedRouterParams(
      event,
      validateZod(UpstreamGetSchema, event)
    );

    const data = await readValidatedBody(
      event,
      validateZod(UpstreamUpdateSchema, event)
    );

    await Database.upstreams.update(upstreamId, data);

    // Apply split tunneling configurations
    await SplitTunneling.applyAllConfigs();

    return { success: true };
  }
);
