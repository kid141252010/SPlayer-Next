# audio-engine

Rust 音频引擎，通过 NAPI-RS 暴露给 Electron 主进程。FFmpeg 解码，CPAL 负责跨平台输出，Windows 独占输出直接使用 WASAPI。

## 目录与职责

| 目录                         | 职责                                                                      |
| ---------------------------- | ------------------------------------------------------------------------- |
| `src/bindings/player/`       | JS 类型和接口；按加载、seek、设备、事件、控制拆分，负责异步任务与错误转换 |
| `src/player/`                | 播放状态、资源所有权、加载代次、后台任务和状态转换                        |
| `src/decoder/`               | FFmpeg 读取、seek、重采样、解码与 DSP 工作线程、有界缓冲、输出供数        |
| `src/dsp/`                   | 均衡器、响度归一化、变速变调、限幅、FFT                                   |
| `src/output/`                | 设备选择、CPAL 输出流、播放句柄、Windows COM 线程与 PipeWire 环境         |
| `src/output/wasapi/`         | 独占流生命周期、设备格式协商、PCM 转换                                    |
| `src/output/device_watcher/` | 各平台设备变化监听                                                        |
| `src/metadata/`              | 标签、封面、歌词读取与写入                                                |
| `src/tests/`                 | 跨模块解码链路、真实 PipeWire 输出测试及音源 fixture                      |
| `tests/`                     | Node.js 加载实际 `.node` 插件的接口集成测试                               |

模块单元测试通过 `#[cfg(test)]` 和 `#[path]` 引入为被测模块的子模块，可访问私有实现。跨模块测试集中在 `src/tests/`；实际加载 `.node` 的 JS 集成测试位于 `tests/`。

## 构建与测试

在仓库根目录运行：

```bash
pnpm --dir native/audio-engine build:debug
cargo test -p audio-engine --lib
cargo fmt -p audio-engine --check
```

构建生成 `audio-engine.node` 和 `index.d.ts`。类型声明由 NAPI-RS 生成，不手动维护；主进程通过 `@splayer/audio-engine` 引用。

Linux PipeWire 集成测试需要 PipeWire、WirePlumber、D-Bus 和对应开发依赖。脚本创建独立服务和虚拟输出，日志目录在退出时打印：

```bash
bash scripts/test-pipewire.sh
```

JS 集成测试需要已构建的本机插件和可用音频输出设备：

```bash
pnpm --dir native/audio-engine test:integration
```

测试默认加载模块目录下的 `audio-engine.node`，也可通过 `SPLAYER_AUDIO_ENGINE_MODULE` 指定 `.node` 的绝对路径。测试音源由临时 WAV 和本机 HTTP 服务提供，无需连接在线音乐服务。

## Apple Music fMP4 首播

`src/decoder/reader.rs` 仅对 `http://127.0.0.1:<port>/am-stream` 启用
`AudioReaderOptions.ignore_index`，在 `avformat_open_input` 读取容器头之前设置
`AVFMT_FLAG_IGNIDX`，避免首播为了建立分片索引而扫描整首音频。普通 HTTP 音源和本地文件
保持默认开流行为；AM 仍使用可 seek 的 IO，总时长沿用代理 URL 中的 `duration`。

代理只在首片和第一个轨道密钥分片均成功解密后返回播放地址。密钥失败会拒绝开播，
后续请求可重新获取模板，不会降级成试听或把密文写进成功响应。每片使用清单声明的
`keyUri`；模板凭证绑定所属 WASM 实例，实例重置后从真实模板重载，不跨实例复用裸指针。
仅有 `contentKey` 而缺少 `ctx`、`state` 和寄存器的响应不构成可用模板。

分片下载校验 `Content-Range`、响应体长度和解密后的等长约束，读取响应体时的中断也参与重试。
原位解密及 ALAC 修复保留 `moof`、`mdat`、`tfdt`、`trun` 和 sample description 的坐标；
HTTP Range、尾部读取和 seek 返回真实字节，不再使用零填充模拟尾部探针。

`sourceError` 携带失败音源 `source` 和 `sourceGeneration`；`getSourceGeneration()` 返回当前原生
操作代次。主进程先核对音源、实例和代次，再失效缓存并通知渲染端重取音源，迟到事件不能删除
新曲缓存。旧版 Apple Music 缓存会单独失效重下，新版 AM 缓存跨重启保留，其它平台不受影响。

代理、真实 WASM 模板及缓存恢复回归：

```bash
pnpm exec vitest run --config vitest.config.ts electron/main/services/appleMusic electron/main/services/songCache.spec.ts electron/main/ipc/playerTransition.spec.ts
```

工作区通过 `[patch.crates-io]` 使用 `vendor/ffmpeg_audio`，基于 crates.io 的
`ffmpeg_audio 0.3.1`（上游提交 `d997800046723f22f823ddbcf45ea2e00601ef66`，
仓库 `https://github.com/apoint123/ffmpeg-audio` 的 `crates/ffmpeg_audio`）。
本地补丁增加 `AudioReaderOptions` 和 `AudioReader::with_options`，将选项传到解封装器；
`AudioReader::new` 默认不忽略索引。精确 seek 和 preroll 裁剪直接按原始 PTS、采样率与目标
样本位置换算，避免 44.1 kHz 时间戳先舍入到微秒再向上取整时多裁掉一个样本。
未改变上游 HTTP、解码算法或重采样实现；FFmpeg 仍依赖原有 `ffmpeg_audio_sys`。
升级依赖时先核对上游的等价配置和精确裁剪实现，再移除本地补丁；许可证位于
`vendor/ffmpeg_audio/COPYING`。

`src/decoder/tests/reader.rs` 覆盖首次开流不扫描后半首、完整 PCM 一致、索引未预建时的双向
seek，以及尾部真实字节。44.1 kHz 双声道非周期音源另行校验逐样本精确 seek，避免周期正弦波
掩盖错位。合成样本 `fragmented-alac.m4a` 是 48 秒、8 kHz、440 Hz 单声道正弦波，
每片约 16 秒，没有尾索引；测试运行不需要外部 FFmpeg。可在仓库根目录重新生成：

```bash
ffmpeg -v error -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=48" -c:a alac -movflags empty_moov+default_base_moof+skip_trailer -frag_duration 16000000 -map_metadata -1 -y native/audio-engine/src/decoder/tests/fragmented-alac.m4a
```
