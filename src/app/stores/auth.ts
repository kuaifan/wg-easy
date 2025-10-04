export const useAuthStore = defineStore('Auth', () => {
  const { data: userData, refresh: update } = useFetch('/api/session', {
    method: 'get',
  });

  async function getSession() {
    try {
      await update();
      return userData.value;
    } catch {
      return null;
    }
  }

  return { userData, update, getSession };
});
