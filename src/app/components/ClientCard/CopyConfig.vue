<template>
  <button
    class="inline-block rounded bg-gray-100 p-2 align-middle transition hover:bg-red-800 hover:text-white dark:bg-neutral-600 dark:text-neutral-300 dark:hover:bg-red-800 dark:hover:text-white"
    type="button"
    :title="$t('client.copyConfig')"
    @click="copyConfig"
  >
    <IconsCopy class="w-5" />
  </button>
</template>

<script setup lang="ts">
const props = defineProps<{
  client: LocalClient;
}>();

const { t } = useI18n();
const toast = useToast();
const isCopying = ref(false);

async function copyConfig() {
  if (isCopying.value) {
    return;
  }

  if (typeof window === 'undefined') {
    return;
  }

  isCopying.value = true;

  try {
    const response = await fetch(`/api/client/${props.client.id}/configuration`);

    if (!response.ok) {
      throw new Error('Failed to fetch configuration');
    }

    const configText = await response.text();

    await writeToClipboard(configText);

    toast.showToast({
      type: 'success',
      message: t('client.copyConfigSuccess'),
    });
  } catch (error: unknown) {
    console.error(error);
    toast.showToast({
      type: 'error',
      message: t('client.copyConfigFailed'),
    });
  } finally {
    isCopying.value = false;
  }
}

async function writeToClipboard(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === 'undefined') {
    throw new Error('Clipboard not supported');
  }

  legacyCopy(text);
}

function legacyCopy(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const selectedRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.select();

  const succeeded = document.execCommand('copy');

  textarea.remove();

  if (selectedRange && selection) {
    selection.removeAllRanges();
    selection.addRange(selectedRange);
  }

  if (!succeeded) {
    throw new Error('Legacy copy command failed');
  }
}
</script>
