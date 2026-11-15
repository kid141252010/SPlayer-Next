# JOC 离线素材

`core.eac3` 是 3.84 秒、48 kHz、5.1 声道的合成正弦音，由 FFmpeg 的 E-AC-3 编码器生成，不含录音

```sh
ffmpeg -f lavfi -i 'aevalsrc=0.04*sin(2*PI*440*t)|0.04*sin(2*PI*554*t)|0.04*sin(2*PI*659*t)|0.04*sin(2*PI*55*t)|0.04*sin(2*PI*880*t)|0.04*sin(2*PI*110*t):s=48000:d=3.84:c=5.1' -c:a eac3 -b:a 384k core.eac3
python make_joc.py
ffmpeg -i joc.eac3 -c:a copy joc.mp4
```

`make_joc.py` 将 Fantastic/joc-core 的 fixture 中的真实 EMDF 容器附加到合成核心的填充区，生成 `joc.eac3`，`joc.mp4` 是其 ec-3 封装版本

这些文件用于测试包与 PCM 的时间对齐和控制链，不是 Dolby 编码器生成的真实 Atmos 混音，不能作为音质一致性认证素材

JOC 元数据来源与许可见 `native/joc-core/LICENSE`，HRTF 来源见 `resources/joc/JOC-NOTICE.md`
