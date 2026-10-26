import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@main/database/sessions", () => ({
  getSessionCookies: () => ({ uin: "123456", qm_keyst: "saved-key" }),
}));
vi.mock("@main/utils/logger", () => ({ coreLog: { info: vi.fn(), warn: vi.fn() } }));

import search from "../modules/search";
import { qmRequest } from "./request";

const fetchMock = vi.fn();

describe("QQ 搜索签名请求", () => {
  beforeEach(() => {
    fetchMock
      .mockReset()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ code: 0, request: { code: 0, data: { ok: true } } })),
      );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("按实际 UTF-8 请求体签名，匿名请求不携带保存的账号", async () => {
    await expect(
      qmRequest(
        "test.module",
        "Test",
        { text: "中文 /+=" },
        {
          signed: true,
          session: false,
          auth: false,
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://u.y.qq.com/cgi-bin/musics.fcg?sign=zzcfb9991bffdabwv8oespf5bkuwz5c7ue6q89c30b6d3",
    );
    expect(init.body).toBe(
      '{"comm":{"ct":"11","cv":"14090508","v":"14090508","tmeAppID":"qqmusic","phonetype":"EBG-AN10","deviceScore":"553.47","devicelevel":"50","newdevicelevel":"20","rom":"HuaWei/EMOTION/EmotionUI_14.2.0","os_ver":"12","OpenUDID":"0","OpenUDID2":"0","QIMEI36":"0","udid":"0","chid":"0","aid":"0","oaid":"0","taid":"0","tid":"0","wid":"0","uid":"0","sid":"0","modeSwitch":"6","teenMode":"0","ui_mode":"2","nettype":"1020","v4ip":"","uin":"0"},"request":{"module":"test.module","method":"Test","param":{"text":"中文 /+="}}}',
    );
    expect(init.headers.Cookie).toBe("tmeLoginType=-1;");
  });

  it("未启用签名的接口保留原网关和登录凭据", async () => {
    await qmRequest("test.module", "Test", {}, { session: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://u.y.qq.com/cgi-bin/musicu.fcg");
    expect(JSON.parse(init.body).comm).toMatchObject({ uin: "123456", authst: "saved-key" });
    expect(init.headers.Cookie).toBe("uin=123456; qm_keyst=saved-key");
  });

  it("四类搜索共用 DoSearchForQQMusicMobile 接口，并保留分页参数和结果映射", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            request: {
              code: 0,
              data: {
                meta: { sum: 100 },
                body: {
                  item_song: [{ id: 1, mid: "song", title: "晴天", interval: 269 }],
                  item_album: [{ albummid: "album", name: "叶惠美" }],
                  singer: [{ singerMID: "artist", singerName: "周杰伦" }],
                  item_songlist: [{ dissid: "playlist", dissname: "<em>周杰伦</em>精选" }],
                },
              },
            },
          }),
        ),
    );
    for (const [type, searchType, field, expected] of [
      [0, 0, "songs", { id: "1", mid: "song", name: "晴天", duration: 269000 }],
      [8, 2, "albums", { id: "album", name: "叶惠美" }],
      [9, 1, "artists", { id: "artist", name: "周杰伦" }],
      [2, 3, "playlists", { id: "playlist", name: "周杰伦精选" }],
    ] as const) {
      const result = await search({ keywords: "周杰伦", type, page: 2, limit: 50 });
      expect(result).toMatchObject({ code: 200, total: 100, [field]: [expected] });
      const [url, init] = fetchMock.mock.calls.at(-1)!;
      expect(new URL(url).pathname).toBe("/cgi-bin/musicu.fcg");
      expect(JSON.parse(init.body)).toMatchObject({
        comm: { tmeAppID: "qqmusic", cv: "14090508", uin: "0" },
        request: {
          method: "DoSearchForQQMusicMobile",
          param: {
            query: "周杰伦",
            search_type: searchType,
            page_num: 2,
            num_per_page: 50,
            highlight: 0,
            nqc_flag: 0,
            multi_zhida: 0,
            cat: 2,
            grp: 1,
            sin: 50,
            sem: 0,
          },
        },
      });
      expect(init.headers.Cookie).toBe("tmeLoginType=-1;");
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
