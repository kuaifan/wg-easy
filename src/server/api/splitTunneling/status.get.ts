export default definePermissionEventHandler(
  'splitTunneling',
  'read',
  async () => {
    const status = await SplitTunneling.getStatus();
    return status;
  }
);
