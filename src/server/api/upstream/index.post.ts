import { UpstreamCreateSchema } from '#db/repositories/upstream/types';

export default definePermissionEventHandler(
  'upstream',
  'create',
  async ({ event }) => {
    const data = await readValidatedBody(
      event,
      validateZod(UpstreamCreateSchema, event)
    );

    const result = await Database.upstreams.create(data);

    // Apply split tunneling configurations
    await SplitTunneling.applyAllConfigs();

    return {
      success: true,
      upstreamId: result[0]!.id,
      interfaceName: result[0]!.interfaceName,
    };
  }
);
