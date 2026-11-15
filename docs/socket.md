# WebSocket API

WebSocket 接口在 [外部 API](/api) 的基础上提供**实时双向**通信：既能下发控制命令，也能订阅播放状态推送。

::: warning 默认关闭
WebSocket 需要在 **设置 → 外部 API** 中开启外部 API 后，**额外开启 WebSocket** 才会生效。安全约束与 HTTP 接口一致（默认仅本机、无鉴权）。
:::

## 连接

- **地址**：`ws://127.0.0.1:<port>/ws`
- **默认端口**：`14558`（与 HTTP 接口共用）

```javascript
const ws = new WebSocket("ws://127.0.0.1:14558/ws");
```

浏览器示例需运行在受支持的本机 `http://` / `https://` 页面中，例如 `http://localhost:5173`；不能直接从远程网站或 `file://` 页面连接。服务在 **HTTP 升级为 WebSocket 之前**校验 `Host` 与 `Origin`，失败返回 `403`，既不会建立连接，也不会订阅播放事件。

不发送 `Origin` 的原生 WebSocket 客户端仍可使用。开启局域网访问后，可通过服务启动时本机 IPv4 网卡地址或机器名连接，浏览器页面也只能来自这些地址或本机 loopback 来源。完整规则见 [浏览器来源约束](/api#浏览器来源约束)；这不是鉴权，也不依赖 CORS 保护 WebSocket。

## 服务器 → 客户端

所有下行消息都带有 `kind` 字段：

| `kind`  | 形态                                  | 说明                               |
| ------- | ------------------------------------- | ---------------------------------- |
| `hello` | `{ "kind": "hello", "clients": N }`   | 连接建立时发送，附当前连接数       |
| `event` | `{ "kind": "event", "type", "data" }` | 播放事件推送（状态、进度、切歌等） |
| `ack`   | `{ "kind": "ack", "op" }`             | 命令执行成功的回执                 |
| `error` | `{ "kind": "error", "op", "error" }`  | 命令失败，`error` 为原因           |

## 客户端 → 服务器

下行命令为 JSON，统一通过 `op` 字段标识：

```json
{ "op": "play" }
```

| `op`        | 附加字段                   | 说明             |
| ----------- | -------------------------- | ---------------- |
| `play`      | —                          | 播放             |
| `pause`     | —                          | 暂停             |
| `stop`      | —                          | 停止             |
| `next`      | —                          | 下一曲           |
| `prev`      | —                          | 上一曲           |
| `seek`      | `{ "positionMs": number }` | 跳转（毫秒，≥0） |
| `setVolume` | `{ "volume": number }`     | 音量（0 ~ 1）    |

非法 JSON 或未知 `op` 会收到 `{ "kind": "error", ... }`。

## 示例

```javascript
const ws = new WebSocket("ws://127.0.0.1:14558/ws");

ws.onopen = () => {
  // 暂停播放
  ws.send(JSON.stringify({ op: "pause" }));
  // 跳转到 1 分钟处
  ws.send(JSON.stringify({ op: "seek", positionMs: 60000 }));
};

ws.onmessage = (evt) => {
  const msg = JSON.parse(evt.data);
  switch (msg.kind) {
    case "hello":
      console.log("已连接，当前客户端数：", msg.clients);
      break;
    case "event":
      console.log("播放事件：", msg.type, msg.data);
      break;
    case "ack":
      console.log("命令成功：", msg.op);
      break;
    case "error":
      console.warn("命令失败：", msg.op, msg.error);
      break;
  }
};
```
