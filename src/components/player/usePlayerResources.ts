import type { Ref } from "vue";
import type { Artist, Track } from "@shared/types/player";
import { fetchSongAlbums, fetchSongArtists } from "@/apis/song/applemusic";
import {
  canNavigateToResource,
  navigateToResource,
  type ResourceNavigationTarget,
} from "@/utils/navigate";
import { setPlayerExpanded } from "@/services/playerTransition";

/** 播放栏和两种播放器布局共用资源身份与 AM 缺失 ID 的补全。 */
export const usePlayerResources = (
  displayTrack: Readonly<Ref<Track | null | undefined>>,
  collapse = false,
) => {
  let disposed = false;
  onScopeDispose(() => (disposed = true));

  const artistTarget = (artist: Artist): ResourceNavigationTarget => ({
    type: "artist",
    source: displayTrack.value?.source,
    serverId: artist.serverId ?? displayTrack.value?.serverId,
    id: artist.id,
    name: artist.name,
  });
  const albumTarget = computed<ResourceNavigationTarget | null>(() => {
    const track = displayTrack.value;
    if (!track?.album?.name) return null;
    return {
      type: "album",
      source: track.source,
      serverId: track.album.serverId ?? track.serverId,
      id: track.album.id,
      name: track.album.name,
    };
  });
  const isLinkable = (target: ResourceNavigationTarget | null): boolean => {
    if (!target) return false;
    return (
      canNavigateToResource(target) ||
      (target.type !== "page" &&
        target.source === "applemusic" &&
        (target.type === "artist" || target.type === "album") &&
        !!target.name &&
        !!displayTrack.value?.id)
    );
  };
  const isArtistLinkable = (artist: Artist): boolean => isLinkable(artistTarget(artist));
  const isAlbumLinkable = computed(() => isLinkable(albumTarget.value));

  const goToResource = async (resource: ResourceNavigationTarget | null): Promise<void> => {
    if (!isLinkable(resource) || !resource) return;
    const target = { ...resource };
    const track = displayTrack.value;
    if (target.type !== "page" && target.source === "applemusic" && !target.id && track?.id) {
      try {
        if (target.type === "album") {
          const albums = await fetchSongAlbums(track.id);
          const album = albums.find((item) => item.name === target.name) ?? albums[0];
          if (album?.id) {
            target.id = album.id;
            target.name = album.name || target.name;
            if (track.album) track.album.id = album.id;
          }
        } else if (target.type === "artist") {
          const artists = await fetchSongArtists(track.id);
          const artist = artists.find((item) => item.name === target.name) ?? artists[0];
          if (artist?.id) {
            target.id = artist.id;
            const original = track.artists.find((item) => item.name === target.name);
            if (original) original.id = artist.id;
            target.name = artist.name || target.name;
          }
        }
      } catch (error) {
        console.warn("[PlayerResources] resolve AM resource failed:", error);
      }
    }
    // 异步补全期间切歌或卸载后，不再用旧曲目改变当前页面。
    if (disposed || displayTrack.value !== track) return;
    if (navigateToResource(target) && collapse) setPlayerExpanded(false);
  };

  return { artistTarget, albumTarget, isArtistLinkable, isAlbumLinkable, goToResource };
};
