import type { Track, TrackSource } from "@shared/types/player";

/** 封面摘要卡片 */
export interface CoverItem {
  /** ID */
  id: string;
  /** 标题 */
  title: string;
  /** 封面 */
  cover?: string;
  /** 副标题/描述 */
  subtitle?: string;
  /** 歌曲数量 */
  trackCount: number;
}

/** 歌手详情分页标识 */
export interface ArtistHasMore {
  songs?: boolean;
  albums?: boolean;
  singles?: boolean;
  liveAlbums?: boolean;
  compilations?: boolean;
}

/** 歌手详情 */
export interface ArtistProfile {
  /** 歌手 ID（URL 编码的名称） */
  id: string;
  /** 歌手名 */
  name: string;
  /** 头像 */
  avatar?: string;
  /** 数据来源 */
  source: TrackSource;
  /** 歌曲列表 */
  tracks: Track[];
  /** 专辑列表 */
  albums: CoverItem[];
  /** 单曲与 EP 列表 */
  singles?: CoverItem[];
  /** 现场专辑列表 */
  liveAlbums?: CoverItem[];
  /** 合辑列表 */
  compilations?: CoverItem[];
  /** 是否存在下一页 */
  hasMore?: ArtistHasMore;
  /** 歌曲数量 */
  trackCount: number;
  /** 专辑数量 */
  albumCount: number;
}
