import type { CollectionType } from "@/types/collection";
import { fetchAppleMusicAlbum } from "@/apis/album/applemusic";
import { fetchAppleMusicPlaylist } from "@/apis/playlist/applemusic";
import type { LoadCollectionOptions } from "./types";

/**
 * 加载 Apple Music 集合（专辑或歌单）
 * @param type - 集合类型（album 或 playlist）
 * @param id - 集合 ID
 * @param options - 加载选项
 */
export const loadAppleMusicCollection = async (
  type: CollectionType,
  id: string,
  options: LoadCollectionOptions,
): Promise<void> => {
  const originalId = decodeURIComponent(id);
  const fallbackName = options.fallbackName ?? originalId;

  if (type === "album") {
    const { album, tracks, description } = await fetchAppleMusicAlbum(originalId, fallbackName);
    if (!options.signal?.aborted) {
      options.onUpdate({
        id: album.id ?? originalId,
        type,
        source: "applemusic",
        title: album.name,
        cover: album.cover,
        creator: album.artist,
        description,
        tracks,
        trackCount: album.trackCount ?? tracks.length,
      });
    }
    return;
  }

  if (type === "playlist") {
    const { playlist, tracks } = await fetchAppleMusicPlaylist(originalId, fallbackName);
    if (!options.signal?.aborted) {
      options.onUpdate({
        id: playlist.id ?? originalId,
        type,
        source: "applemusic",
        title: playlist.name,
        cover: playlist.cover,
        description: playlist.description,
        creator: playlist.owner,
        tracks,
        trackCount: playlist.trackCount ?? tracks.length,
      });
    }
    return;
  }

  options.onUpdate(null);
};
