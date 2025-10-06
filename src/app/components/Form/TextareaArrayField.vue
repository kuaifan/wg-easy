<template>
  <div class="flex flex-col gap-2">
    <div v-if="label" class="flex items-center">
      <FormLabel :for="name">
        {{ label }}
      </FormLabel>
      <BaseTooltip v-if="description" :text="description">
        <IconsInfo class="size-4" />
      </BaseTooltip>
    </div>
    <textarea
      :id="name"
      v-model="localValue"
      :name="name"
      :rows="rows"
      :placeholder="placeholder"
      spellcheck="false"
      class="w-full rounded-lg border-2 border-gray-100 text-sm text-gray-500 focus:border-red-800 focus:outline-0 focus:ring-0 dark:border-neutral-800 dark:bg-neutral-700 dark:text-neutral-200 dark:placeholder:text-neutral-400"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed, nextTick, ref, toRefs, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    name: string;
    label?: string;
    description?: string;
    placeholder?: string;
    rows?: number;
  }>(),
  {
    rows: 6,
  },
);

const data = defineModel<string[]>({
  default: () => [],
});

function toTextareaValue(value: string[] | undefined) {
  if (!value || value.length === 0) {
    return '';
  }
  return value.join('\n');
}

function parseTextareaValue(value: string) {
  if (!value) {
    return [];
  }

  const lines = value.split(/\r?\n/);

  // Remove trailing blank lines so users can separate sections without
  // accidentally growing the list with empty entries at the end.
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop();
  }

  return lines.map((line) => line.trim());
}

const localValue = ref(toTextareaValue(data.value));

let updatingFromTextarea = false;

watch(
  () => data.value,
  (value) => {
    if (updatingFromTextarea) {
      return;
    }
    localValue.value = toTextareaValue(value);
  },
  { deep: true },
);

watch(
  localValue,
  (value) => {
    updatingFromTextarea = true;
    data.value = parseTextareaValue(value);
    nextTick(() => {
      updatingFromTextarea = false;
    });
  },
);

const { label, description, name, placeholder, rows: rowsProp } = toRefs(props);

const rows = computed(() => rowsProp.value);
</script>
