export default definePermissionEventHandler(
  'upstream',
  'read',
  async () => {
    const upstreams = await Database.upstreams.getAll();

    // Don't return sensitive keys
    const safeUpstreams = upstreams.map(
      ({ privateKey, presharedKey, ...rest }) => ({
        ...rest,
        hasPrivateKey: !!privateKey,
        hasPresharedKey: !!presharedKey,
      })
    );

    return { upstreams: safeUpstreams };
  }
);
