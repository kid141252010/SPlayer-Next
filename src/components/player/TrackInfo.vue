<script setup lang="ts">
import { useMediaStore } from "@/stores/media";
import { usePlayerResources } from "@/components/player/usePlayerResources";
import { getValidArtists } from "@shared/utils/track";
import { isDolbyAtmosQuality } from "@/utils/quality";
import { setPlayerExpanded } from "@/services/playerTransition";

withDefaults(
  defineProps<{
    /** 紧凑模式 */
    compact?: boolean;
  }>(),
  { compact: false },
);

const media = useMediaStore();

/** 是否为杜比全景声 */
const isDolbyAtmos = computed(() => {
  const q = media.detail?.quality ?? media.track?.quality;
  return isDolbyAtmosQuality(q);
});

/** 当前歌曲中可展示的歌手 */
const artists = computed(() => getValidArtists(media.track?.artists));

const { artistTarget, isArtistLinkable, goToResource } = usePlayerResources(toRef(media, "track"));
</script>

<template>
  <div class="flex items-center min-w-0" :class="compact ? 'gap-2' : 'gap-3'">
    <!-- 封面 -->
    <div
      class="relative shrink-0 rounded-lg overflow-hidden cursor-pointer group"
      :class="compact ? 'size-10 shadow-sm' : 'size-14'"
      @click="setPlayerExpanded(true)"
    >
      <SImg :src="media.track?.cover" class="size-full rounded-lg" data-player-cover="bar" />
      <div
        data-player-cover-overlay
        class="absolute inset-0 z-10 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors duration-200"
      >
        <IconLucideChevronUp
          class="text-white opacity-0 group-hover:opacity-100 transition-opacity duration-200"
          :class="compact ? 'size-4.5' : 'size-6'"
        />
      </div>
    </div>
    <!-- 歌曲信息 -->
    <Transition name="slide-left" mode="out-in">
      <div v-if="media.track" :key="media.track.id" class="min-w-0 flex-1">
        <div class="flex items-center gap-1 min-w-0">
          <SMarquee
            fit
            class="min-w-0"
            :class="
              compact ? 'font-medium text-sm leading-tight' : 'font-bold text-base leading-snug'
            "
          >
            {{ media.track.title }}
          </SMarquee>
          <span
            v-if="media.track.contentRating === 'explicit' || media.track.explicit"
            class="shrink-0 self-center px-1 rounded text-[10px] leading-[14px] font-bold border border-solid text-on-surface-variant/70 border-on-surface-variant/30 select-none"
            title="Explicit"
          >
            Explicit
          </span>
          <span
            v-else-if="media.track.contentRating === 'clean'"
            class="shrink-0 self-center px-1 rounded text-[9px] leading-[14px] font-bold border border-solid text-on-surface-variant/60 border-on-surface-variant/25 select-none"
            title="Clean"
          >
            Clean
          </span>
          <span
            v-if="isDolbyAtmos"
            class="shrink-0 self-center px-1 rounded text-[9px] leading-[14px] font-bold border border-solid text-primary/80 border-primary/40 select-none tracking-tight"
            title="Dolby Atmos"
          >
            ATMOS
          </span>
          <slot name="title-trailing" />
        </div>
        <PlayerBarLyric :compact="compact">
          <div
            key="artist"
            class="text-on-surface-variant truncate"
            :class="compact ? 'text-xs leading-tight mt-0.5' : 'text-sm mt-1'"
          >
            <template v-if="artists.length">
              <template v-for="(artist, i) in artists" :key="artist.id ?? i">
                <span
                  :class="
                    isArtistLinkable(artist)
                      ? 'cursor-pointer transition-opacity hover:opacity-70'
                      : ''
                  "
                  @click.stop="goToResource(artistTarget(artist))"
                >
                  {{ artist.name }}
                </span>
                <span v-if="i < artists.length - 1" class="mx-0.5 opacity-50">/</span>
              </template>
            </template>
            <span v-else class="opacity-50">{{ $t("playlist.unknownArtist") }}</span>
          </div>
        </PlayerBarLyric>
      </div>
    </Transition>
  </div>
</template>
