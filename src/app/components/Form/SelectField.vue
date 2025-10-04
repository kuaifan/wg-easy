<template>
  <div class="flex items-center">
    <FormLabel :for="id">
      {{ label }}
    </FormLabel>
    <BaseTooltip v-if="description" :text="description">
      <IconsInfo class="size-4" />
    </BaseTooltip>
  </div>
  <BaseSelect :id="id" v-model="data" :options="options" />
</template>

<script lang="ts" setup>
defineProps<{
  id: string;
  label: string;
  description?: string;
  options: { label: string; value: string }[];
}>();

const data = defineModel<string>();
</script>
