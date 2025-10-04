import type { NitroFetchRequest, NitroFetchOptions } from 'nitropack/types';
import { FetchError } from 'ofetch';

type RevertFn<T = unknown> = (
  success: boolean,
  data: T | undefined
) => Promise<void>;

type SubmitOpts<T = unknown> = {
  revert: RevertFn<T>;
  successMsg?: string;
  noSuccessToast?: boolean;
};

export function useSubmit<
  R extends NitroFetchRequest,
  O extends NitroFetchOptions<R> & { body?: never },
  T = unknown,
>(url: R, options: O, opts: SubmitOpts<T>) {
  const toast = useToast();

  return async (data: unknown) => {
    try {
      const res = await $fetch(url, {
        ...options,
        body: data,
      });

      if (!opts.noSuccessToast) {
        toast.showToast({
          type: 'success',
          message: opts.successMsg,
        });
      }

      await opts.revert(true, res as T);
    } catch (e) {
      if (e instanceof FetchError) {
        toast.showToast({
          type: 'error',
          message: e.data.message,
        });
      } else if (e instanceof Error) {
        toast.showToast({
          type: 'error',
          message: e.message,
        });
      } else {
        console.error(e);
      }
      await opts.revert(false, undefined);
    }
  };
}
