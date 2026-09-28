use super::*;

impl DecoderData {
    /// 在已有 reader 上 seek，失败时调用方应回退到完整 load
    ///
    /// seek 后两个重采样器要 flush 掉残留样本，否则播放/FFT会带上上一段尾巴
    pub fn seek(&mut self, position_secs: f64) -> bool {
        if let Some(handle) = &self.cancel_handle {
            handle.reset();
        }
        let target = Duration::from_secs_f64(position_secs);
        if self.reader.seek(target, SeekMode::Accurate).is_err()
            && self.reader.seek(target, SeekMode::Coarse).is_err()
        {
            return false;
        }
        let _ = self.player_resampler.flush();
        let _ = self.fft_resampler.flush();
        true
    }

    /// 获取网络中断句柄，恢复解码时绑定到新的共享状态
    pub fn cancel_handle(&self) -> Option<HttpCancelHandle> {
        self.cancel_handle.clone()
    }

    /// 输出设备格式变化后重建播放重采样器；FFT 分支仍保持固定双声道分析格式
    pub fn reconfigure_player_output(&mut self, sample_rate: u32, channels: u16) -> Result<()> {
        self.player_resampler = build_player_resampler(&self.reader, sample_rate, channels)?;
        Ok(())
    }
}

use std::io::{Read, Seek, SeekFrom};

/// 对网络流进行延迟 Seek 包装，消除 AVSEEK_SIZE 探测触发的断网与重连。
///
/// FFmpeg 打开流时探测大小（AVSEEK_SIZE）会先后调用 seek(Current(0))、seek(End(0)) 与 seek(Start(0))。
/// 原始 HttpAudioSource 会将 seek(End(0)) 视为向末尾的 Hard-Seek，导致当前 HTTP 连接被掐断，
/// 去请求文件尾数据后又再次掐断重连回起点。本结构通过跟踪虚拟位置，将该瞬态探测限制在内存级别，
/// 仅当发生后续 read() 且偏移量不一致时才执行真实网络 Seek。
struct LazySeekHttpSource<T> {
    inner: T,
    total_size: Option<u64>,
    virtual_pos: u64,
    actual_pos: u64,
}

impl<T: Read + Seek> LazySeekHttpSource<T> {
    fn new(inner: T, total_size: Option<u64>) -> Self {
        Self {
            inner,
            total_size,
            virtual_pos: 0,
            actual_pos: 0,
        }
    }
}

impl<T: Read + Seek> Read for LazySeekHttpSource<T> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.virtual_pos != self.actual_pos {
            self.inner.seek(SeekFrom::Start(self.virtual_pos))?;
            self.actual_pos = self.virtual_pos;
        }
        let n = self.inner.read(buf)?;
        self.actual_pos += n as u64;
        self.virtual_pos = self.actual_pos;
        Ok(n)
    }
}

impl<T: Read + Seek> Seek for LazySeekHttpSource<T> {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let new_pos = match pos {
            SeekFrom::Start(offset) => offset,
            SeekFrom::Current(offset) => {
                let p = self.virtual_pos as i64 + offset;
                if p < 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "无效的目标 Seek 偏移量",
                    ));
                }
                p as u64
            }
            SeekFrom::End(offset) => {
                if let Some(total) = self.total_size {
                    let p = total as i64 + offset;
                    if p < 0 {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            "无效的目标 Seek 偏移量",
                        ));
                    }
                    p as u64
                } else {
                    let p = self.inner.seek(pos)?;
                    self.actual_pos = p;
                    if offset == 0 {
                        self.total_size = Some(p);
                    }
                    self.virtual_pos = p;
                    return Ok(p);
                }
            }
        };

        self.virtual_pos = new_pos;
        Ok(new_pos)
    }
}

/// 从 URL 参数中提取预置的流字节大小（若存在）
fn extract_stream_size(url: &str) -> Option<u64> {
    let (_, query) = url.split_once('?')?;
    for part in query.split('&') {
        if let Some((k, v)) = part.split_once('=') {
            if k == "size" {
                return v.parse::<u64>().ok();
            }
        }
    }
    None
}

/// 从 URL 参数中提取预置的音频总时长（秒，若存在）
pub(crate) fn extract_stream_duration(url: &str) -> Option<f64> {
    let (_, query) = url.split_once('?')?;
    for part in query.split('&') {
        if let Some((k, v)) = part.split_once('=') {
            if k == "duration" {
                let d = v.parse::<f64>().ok()?;
                if d > 0.0 {
                    return Some(d);
                }
            }
        }
    }
    None
}

/// 根据 source 协议打开音频：http(s) 走延迟 Range 源，其他走本地 File
pub(super) fn open_source(
    source: &str,
    cancel_handle: HttpCancelHandle,
) -> Result<(AudioReader, Option<HttpCancelHandle>)> {
    let (reader, cancel) = if source.starts_with("http://") || source.starts_with("https://") {
        let http = HttpAudioSource::new_with_cancel_handle(source, &cancel_handle)?;
        let total_size = extract_stream_size(source);
        let lazy_http = LazySeekHttpSource::new(http, total_size);
        let reader =
            AudioReader::new(lazy_http).with_context(|| format!("打开网络音频失败: {source}"))?;
        (reader, Some(cancel_handle))
    } else {
        let file = File::open(source).with_context(|| format!("打开本地文件失败: {source}"))?;
        let reader =
            AudioReader::new(file).with_context(|| format!("打开本地音频失败: {source}"))?;
        (reader, None)
    };

    Ok((reader, cancel))
}

fn build_player_resampler(
    reader: &AudioReader,
    target_rate: u32,
    target_channels: u16,
) -> Result<Resampler> {
    let player_opts = ResampleOptions::new()
        .sample_rate(target_rate as i32)
        .channels(i32::from(target_channels))
        .format::<f32>();
    reader
        .build_resampler(player_opts)
        .with_context(|| "构建播放重采样器失败")
}

pub(super) fn build_resamplers(
    reader: &AudioReader,
    target_rate: u32,
    target_channels: u16,
) -> Result<(Resampler, Resampler)> {
    let player_resampler = build_player_resampler(reader, target_rate, target_channels)?;

    let fft_opts = ResampleOptions::new()
        .sample_rate(FFT_TARGET_SAMPLE_RATE as i32)
        .channels(i32::from(FFT_CHANNELS))
        .format::<f32>();
    let fft_resampler = reader
        .build_resampler(fft_opts)
        .with_context(|| "构建 FFT 重采样器失败")?;

    Ok((player_resampler, fft_resampler))
}

/// 核心解码循环：每帧解码一次，使用复用缓冲分发到播放与 FFT 重采样器
pub(super) fn run_decoding_loop(data: &mut DecoderData, shared: &Shared) {
    // 响度归一化：有 ReplayGain 标签时用固定增益，否则用实时分析
    let has_replay_gain = (shared.normalization_gain() - 1.0).abs() > f32::EPSILON;
    let mut loudness = LoudnessAnalyzer::new(shared.sample_rate(), shared.channels());
    loudness.set_has_replay_gain(has_replay_gain);

    // 用于日志诊断：记录是否曾成功解码过帧
    let mut had_success = false;

    loop {
        // 背压：缓冲区满时阻塞等待消费
        if !shared.wait_for_space() {
            return;
        }

        match data.reader.receive_frame() {
            Ok(Some(frame)) => {
                // 1-to-N: 同一帧顺序喂两个重采样器
                if data.player_resampler.process::<f32>(Some(&frame)).is_err() {
                    debug!("player resampler 处理失败，结束解码");
                    shared.mark_decode_failed();
                    return;
                }
                let mut player_samples = shared.take_player_buffer();
                player_samples.extend_from_slice(data.player_resampler.output_as::<f32>());

                if data.fft_resampler.process::<f32>(Some(&frame)).is_err() {
                    debug!("fft resampler 处理失败，结束解码");
                    shared.recycle_player_buffer(player_samples);
                    shared.mark_decode_failed();
                    return;
                }
                let mut fft_samples = shared.take_fft_buffer();
                fft_samples.extend_from_slice(data.fft_resampler.output_as::<f32>());

                // 重采样可能还在攒样本，本轮没出数据就跳过
                if player_samples.is_empty() && fft_samples.is_empty() {
                    shared.recycle_player_buffer(player_samples);
                    shared.recycle_fft_buffer(fft_samples);
                    continue;
                }
                had_success = true;

                if shared.is_normalization_enabled() && !player_samples.is_empty() {
                    let gain = if has_replay_gain {
                        shared.normalization_gain()
                    } else {
                        loudness.process(&player_samples)
                    };
                    if (gain - 1.0).abs() > f32::EPSILON {
                        for s in &mut player_samples {
                            *s *= gain;
                        }
                    }
                }

                shared.push(AudioChunk {
                    source_sample_count: player_samples.len() as u64,
                    player_samples,
                    fft_samples,
                });
            }
            Ok(None) | Err(AudioError::Eof) => {
                // EOF flush：把两个重采样器内部残留挤出来，否则最后几十毫秒丢
                let _ = data.player_resampler.process::<f32>(None);
                let _ = data.fft_resampler.process::<f32>(None);
                let mut player_samples = shared.take_player_buffer();
                player_samples.extend_from_slice(data.player_resampler.output_as::<f32>());
                let mut fft_samples = shared.take_fft_buffer();
                fft_samples.extend_from_slice(data.fft_resampler.output_as::<f32>());
                if !player_samples.is_empty() || !fft_samples.is_empty() {
                    shared.push(AudioChunk {
                        source_sample_count: player_samples.len() as u64,
                        player_samples,
                        fft_samples,
                    });
                } else {
                    shared.recycle_player_buffer(player_samples);
                    shared.recycle_fft_buffer(fft_samples);
                }
                return;
            }
            Err(e) => {
                // stop/切歌触发的 HTTP 取消不是源故障
                if shared.is_stopping() {
                    debug!(error = %e, "解码线程因停止信号退出");
                    return;
                }
                // 本地 File 的 io::Error 可能经 ffmpeg_audio read 回调映射为 AVERROR(EIO)
                let io_failure = match &e {
                    AudioError::Io(_) => true,
                    AudioError::FFmpeg(code, _) => *code == AVERROR_EIO,
                    _ => false,
                };
                // 统一标记 decode_failed：包括 IO 错误和 FFmpeg 数据错误
                // 长时间暂停后 HTTP 流断开重连、URL 过期等场景下 FFmpeg 会报
                // INVALIDDATA（非 EIO），但本质仍是数据源故障，需要标记以触发
                // SourceError 让 JS 重新解析播放地址
                // 尾部坏帧（FLAC ID3v1 / VBR 末帧）容忍由 position timer 的 3s
                // 阈值保障：mark_decode_failed 后若 position 接近末尾仍发 Ended
                shared.mark_decode_failed();
                debug!(error = %e, had_success, io_failure, "解码线程异常结束");
                return;
            }
        }
    }
}

#[cfg(test)]
#[path = "tests/reader.rs"]
mod tests;
