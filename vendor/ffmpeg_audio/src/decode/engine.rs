use std::{
    io::{Read, Seek},
    time::Duration,
};

use crate::{
    AudioError, AudioFrame, AudioReaderOptions, Decoder, Demuxer, Result, TimeBase,
    decode::{SeekMode, io::IoContext},
    sys,
};

/// Specifies the strategy used to scan an audio stream to determine its exact duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanMode {
    /// Rapidly scans the stream by reading demuxer packet timestamps without decoding them.
    ///
    /// This mode is extremely fast and relies entirely on the container's metadata.
    /// However, it may fail or return inaccurate results for raw formats or highly
    /// corrupted streams that lack valid timestamp information.
    Packet,

    /// Fully decodes the stream into raw physical audio frames to calculate the duration.
    ///
    /// This mode is the most accurate fallback method, as it calculates time based purely
    /// on the actual number of generated audio samples and the stream's sample rate.
    /// Because it requires full decompression, it consumes significantly more CPU
    /// and takes much longer to complete.
    Frame,
}

/// A decode engine that orchestrates the extraction and decoding of audio data.
///
/// This engine acts as a unified abstraction over FFmpeg's underlying parsing (`Demuxer`)
/// and decompression (`Decoder`) stages. It encapsulates the complex send/receive
/// state machines, timestamp alignments, and buffering required to safely yield raw audio frames.
pub struct DecodeEngine {
    /// The underlying component responsible for reading and parsing the media container.
    demuxer: Demuxer,

    /// The underlying component responsible for decompressing raw packets into audio frames.
    decoder: Decoder,

    /// The fundamental unit of time representation for the current stream.
    time_base: TimeBase,

    /// Raw stream PTS that maps to the public zero-based timeline.
    timeline_origin_pts: i64,

    /// The presentation timestamp (PTS) of the most recently decoded frame, if available.
    current_pts: Option<Duration>,

    /// Indicates whether the internal stream has reached the End Of File (EOF).
    is_exhausted: bool,

    /// Indicates whether a valid frame was decoded and buffered during a seek operation,
    /// waiting to be consumed by the next read invocation.
    has_buffered_seek_frame: bool,
    /// Stores the calculated sample offset for the buffered seek frame
    buffered_seek_offset: usize,
    packet_passthrough: bool,
    pending_packets: Vec<Vec<u8>>,
}

impl DecodeEngine {
    /// 开关原始包旁路，关闭时释放未消费载荷
    /// @param enabled - 是否保留送入解码器的包
    pub fn set_packet_passthrough(&mut self, enabled: bool) {
        self.packet_passthrough = enabled;
        self.pending_packets.clear();
    }

    /// 将开流选项传递给解封装器，不改变解码和 seek 逻辑。
    pub fn new<T>(source: T, options: AudioReaderOptions) -> Result<Self>
    where
        T: Read + Seek + Send + 'static,
    {
        let io_ctx = IoContext::new(source)?;

        let demuxer = Demuxer::new(io_ctx, options)?;

        let codec_params = demuxer.stream_codec_params();
        let decoder = Decoder::new(codec_params)?;

        let time_base = demuxer.time_base()?;
        let timeline_origin_pts = demuxer.timeline_origin_pts();

        Ok(Self {
            demuxer,
            decoder,
            time_base,
            timeline_origin_pts,
            current_pts: None,
            is_exhausted: false,
            has_buffered_seek_frame: false,
            buffered_seek_offset: 0,
            packet_passthrough: false,
            pending_packets: Vec::new(),
        })
    }

    fn debug_verify(&self) {
        debug_assert!(
            !(self.is_exhausted && self.has_buffered_seek_frame),
            "Stream is marked as exhausted, but a buffered seek frame is present."
        );

        let tb = self.time_base.as_rational();

        debug_assert!(tb.den > 0, "Time base denominator is zero or negative.");

        debug_assert!(tb.num > 0, "Time base numerator is zero or negative.");
    }

    /// 解码下一音频帧，开启旁路时关联自上一帧以来送入的原始包
    /// @returns 解码帧、流末尾空值或解码错误
    pub fn receive_frame(&mut self) -> Result<Option<AudioFrame<'_>>> {
        self.debug_verify();

        if self.is_exhausted {
            return Ok(None);
        }

        if self.has_buffered_seek_frame {
            self.has_buffered_seek_frame = false;
            let frame_ptr = self.decoder.current_frame();
            let audio_frame = AudioFrame::new(frame_ptr, self.time_base)
                .with_timeline_origin(self.timeline_origin_pts)
                .with_offset(self.buffered_seek_offset)
                .with_packets(std::mem::take(&mut self.pending_packets));

            self.buffered_seek_offset = 0;
            self.current_pts = audio_frame.pts();

            self.debug_verify();
            return Ok(Some(audio_frame));
        }

        loop {
            match self.decoder.receive_frame() {
                Ok(Some(frame)) => {
                    let mut audio_frame = AudioFrame::new(frame, self.time_base)
                        .with_timeline_origin(self.timeline_origin_pts);

                    if let (Some(start_us), Some(end_us)) =
                        (audio_frame.pts_micros(), audio_frame.end_micros())
                    {
                        if end_us <= 0 {
                            self.pending_packets.clear();
                            #[cfg(feature = "tracing")]
                            tracing::debug!(
                                "Dropped preroll frame (start: {start_us} us, end: {end_us} us)"
                            );
                            continue;
                        }

                        if start_us < 0 && audio_frame.offset() == 0 {
                            let offset_samples = audio_frame
                                .sample_offset_to(Duration::ZERO)
                                .unwrap_or(audio_frame.samples());

                            if offset_samples < audio_frame.samples() {
                                audio_frame = audio_frame.with_offset(offset_samples);
                            } else {
                                self.pending_packets.clear();
                                continue;
                            }
                        }
                    }

                    audio_frame =
                        audio_frame.with_packets(std::mem::take(&mut self.pending_packets));
                    self.current_pts = audio_frame.pts();
                    self.debug_verify();
                    return Ok(Some(audio_frame));
                }
                Err(AudioError::Eagain) => {
                    if let Some(packet) = self.demuxer.read_packet()? {
                        self.decoder.send_packet(packet)?;
                        if self.packet_passthrough {
                            // send_packet 已接受该包，解封装器下一次读取前复制载荷
                            let packet = unsafe { &*packet };
                            if packet.size > 0 {
                                let bytes = unsafe {
                                    std::slice::from_raw_parts(packet.data, packet.size as usize)
                                };
                                self.pending_packets.push(bytes.to_vec());
                            }
                        }
                    } else {
                        if self.decoder.is_flushing() {
                            self.is_exhausted = true;
                            self.debug_verify();
                            return Ok(None);
                        }

                        self.decoder.send_eof_flush()?;
                    }
                }
                Ok(None) => {
                    self.is_exhausted = true;
                    self.debug_verify();
                    return Ok(None);
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// 跳转并清理旧包，精确模式保留目标帧的载荷与裁剪量
    /// @param target - 目标播放时间
    /// @param mode - 精确或粗略定位策略
    /// @returns 定位及帧对齐结果
    pub fn seek(&mut self, target: Duration, mode: SeekMode) -> Result<()> {
        self.debug_verify();

        self.demuxer.seek_to(target)?;
        self.decoder.flush();
        self.pending_packets.clear();

        self.is_exhausted = false;
        self.current_pts = None;
        self.has_buffered_seek_frame = false;
        self.buffered_seek_offset = 0;

        if mode == SeekMode::Coarse {
            self.debug_verify();
            return Ok(());
        }

        loop {
            match self.receive_frame() {
                Ok(Some(mut frame)) => {
                    if let Some(offset_samples) = frame.sample_offset_to(target) {
                        if offset_samples >= frame.samples() {
                            continue;
                        }
                        let offset = frame.offset() + offset_samples;
                        let packets = frame.take_packets();
                        self.pending_packets = packets;
                        self.buffered_seek_offset = offset;
                        self.has_buffered_seek_frame = true;
                        break;
                    } else {
                        return Err(AudioError::InvalidData(
                            "Cannot perform accurate seek on a stream lacking valid timestamps."
                                .to_string(),
                        ));
                    }
                }
                Ok(None) => break,
                Err(e) => return Err(e),
            }
        }

        self.current_pts = None;
        self.debug_verify();
        Ok(())
    }

    /// Returns the position from which the next `receive_frame` call should resume.
    fn next_read_position(&self) -> Duration {
        if self.has_buffered_seek_frame {
            let frame_ptr = self.decoder.current_frame();
            return AudioFrame::new(frame_ptr, self.time_base)
                .with_timeline_origin(self.timeline_origin_pts)
                .with_offset(self.buffered_seek_offset)
                .pts()
                .unwrap_or(Duration::ZERO);
        }

        if self.current_pts.is_none() {
            return Duration::ZERO;
        }

        let frame_ptr = self.decoder.current_frame();
        let frame = AudioFrame::new(frame_ptr, self.time_base)
            .with_timeline_origin(self.timeline_origin_pts);

        frame
            .pts()
            .map_or(Duration::ZERO, |pts| pts.saturating_add(frame.duration()))
    }

    /// Scans the audio stream to determine its exact total duration.
    ///
    /// This operation performs internal seeking and state resets. It is recommended to
    /// call this method before establishing a continuous reading pipeline to prevent
    /// disrupting the primary playback flow.
    ///
    /// # Arguments
    /// * `mode` - The strategy ([`ScanMode`]) to employ during the scanning process.
    ///
    /// # Returns
    /// * `Ok(Some(Duration))` representing the accurate total length of the audio stream.
    /// * `Ok(None)` if the file is completely empty or lacks valid timestamp data.
    /// * `Err(AudioError)` if an I/O or parsing failure halts the scanning process.
    pub fn scan_duration(&mut self, mode: ScanMode) -> Result<Option<Duration>> {
        let was_exhausted = self.is_exhausted;
        let original_current_pts = self.current_pts;

        let original_position = self.next_read_position();

        self.seek(Duration::ZERO, SeekMode::Coarse)?;

        let mut min_start_us: Option<i64> = None;
        let mut max_end_us: Option<i64> = None;
        let mut total_duration_us_fallback: i64 = 0;
        let mut scan_error = None;

        match mode {
            ScanMode::Packet => loop {
                match self.demuxer.read_packet() {
                    Ok(Some(packet)) => unsafe {
                        let pts = (*packet).pts;
                        if pts == sys::AV_NOPTS_VALUE {
                            continue;
                        }

                        if let Some(start_us) = self.time_base.calc_micros(pts) {
                            let duration = (*packet).duration;
                            let end_pts = if duration > 0 {
                                pts.saturating_add(duration)
                            } else {
                                pts
                            };
                            let end_us = self.time_base.calc_micros(end_pts).unwrap_or(start_us);

                            let safe_start = start_us.max(0);
                            let safe_end = end_us.max(0);

                            min_start_us =
                                Some(min_start_us.map_or(safe_start, |m| m.min(safe_start)));
                            max_end_us = Some(max_end_us.map_or(safe_end, |m| m.max(safe_end)));
                        }
                    },
                    Ok(None) => break,
                    Err(e) => {
                        scan_error = Some(e);
                        break;
                    }
                }
            },
            ScanMode::Frame => loop {
                match self.receive_frame() {
                    Ok(Some(frame)) => {
                        total_duration_us_fallback =
                            total_duration_us_fallback.saturating_add(frame.duration_micros());

                        if let (Some(start_us), Some(end_us)) =
                            (frame.pts_micros(), frame.end_micros())
                        {
                            min_start_us = Some(min_start_us.map_or(start_us, |m| m.min(start_us)));
                            max_end_us = Some(max_end_us.map_or(end_us, |m| m.max(end_us)));
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        scan_error = Some(e);
                        break;
                    }
                }
            },
        }

        let seek_result = if was_exhausted {
            self.is_exhausted = true;
            self.current_pts = original_current_pts;
            self.has_buffered_seek_frame = false;
            self.buffered_seek_offset = 0;
            Ok(())
        } else {
            self.seek(original_position, SeekMode::Accurate)
        };

        if let Some(e) = scan_error {
            return Err(e);
        }
        seek_result?;

        if let (Some(start), Some(end)) = (min_start_us, max_end_us) {
            let duration_us = end.saturating_sub(start).max(0).cast_unsigned();
            Ok(Some(Duration::from_micros(duration_us)))
        } else if mode == ScanMode::Frame && total_duration_us_fallback > 0 {
            let safe_duration = total_duration_us_fallback.max(0).cast_unsigned();
            Ok(Some(Duration::from_micros(safe_duration)))
        } else {
            Ok(None)
        }
    }

    /// Returns a shared, immutable reference to the underlying demuxer.
    pub(crate) const fn demuxer(&self) -> &Demuxer {
        &self.demuxer
    }

    /// Returns a shared, immutable reference to the underlying decoder.
    pub(crate) const fn decoder(&self) -> &Decoder {
        &self.decoder
    }

    /// Returns the presentation timestamp of the most recently decoded audio frame.
    ///
    /// # Returns
    /// * `Some(Duration)` representing the current playback position.
    /// * `None` if no frames have been successfully decoded yet, or immediately after a seek.
    pub const fn stream_position(&self) -> Option<Duration> {
        self.current_pts
    }
}
