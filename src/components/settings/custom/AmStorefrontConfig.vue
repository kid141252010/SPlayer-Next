<script setup lang="ts">
import type { SSelectOption } from "@/components/ui/SSelect.vue";
import { toast } from "@/composables/useToast";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    modelValue?: string;
  }>(),
  {
    modelValue: "cn",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const { t } = useI18n();

const PRESET_CODES = ["cn", "us", "tr", "jp", "kr"] as const;

const options = computed<SSelectOption[]>(() => [
  { value: "cn", label: t("settings.amStorefront.cn") },
  { value: "us", label: t("settings.amStorefront.us") },
  { value: "tr", label: t("settings.amStorefront.tr") },
  { value: "jp", label: t("settings.amStorefront.jp") },
  { value: "kr", label: t("settings.amStorefront.kr") },
  { value: "custom", label: t("settings.amStorefront.custom") },
]);

const isCustom = computed(() => !PRESET_CODES.includes(props.modelValue as never));

const selectedMode = computed({
  get: () => (isCustom.value ? "custom" : props.modelValue),
  set: (val: string | number | boolean) => {
    const next = String(val);
    if (next === "custom") {
      // 保持当前值或默认转为自定义编辑
      return;
    }
    emit("update:modelValue", next);
  },
});

const customInput = ref(props.modelValue);

watch(
  () => props.modelValue,
  (val) => {
    customInput.value = val;
  },
);

const handleCustomSubmit = (raw: string) => {
  const trimmed = raw.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(trimmed)) {
    toast.error(t("settings.amStorefront.invalidCode"));
    customInput.value = props.modelValue;
    return;
  }
  emit("update:modelValue", trimmed);
};
</script>

<template>
  <div class="flex items-center gap-2">
    <SSelect v-model="selectedMode" :options="options" class="min-w-32" />
    <SInput
      v-if="selectedMode === 'custom' || isCustom"
      v-model="customInput"
      :placeholder="t('settings.amStorefront.customPlaceholder')"
      class="w-20 uppercase font-mono"
      maxlength="2"
      update-on="blur"
      @update:model-value="handleCustomSubmit"
    />
  </div>
</template>
