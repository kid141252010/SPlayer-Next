<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";
import { useSpatialStore } from "@/stores/spatial";

const SpatialScene = defineAsyncComponent(
  () => import("@/components/player/SpatialScene/SpatialScene.vue"),
);
const spatial = useSpatialStore();

const settings = useSettingsStore();

watchEffect(() => {
  document.documentElement.toggleAttribute("data-reduced-motion", settings.reducedMotion);
  const v = settings.appearance.fontFamily;
  const root = document.documentElement.style;
  if (v) root.setProperty("--user-font", `${v}, var(--app-font)`);
  else root.removeProperty("--user-font");
});
</script>

<template>
  <AppBackground />
  <RouterView />
  <SpatialScene v-if="spatial.open" />
</template>
