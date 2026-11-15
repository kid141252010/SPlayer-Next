use std::{
    marker::PhantomData,
    ptr::NonNull,
    time::Duration,
};

use crate::{
    AudioError,
    AudioSample,
    Result,
    core::timeline::{
        FramePlacement,
        FrameTiming,
        Timeline,
    },
    sys,
};

/// A safe enum representing the memory layout of underlying FFmpeg PCM data.
#[derive(Debug, Clone)]
pub enum RawAudioData<'a, T> {
    /// Packed (Interleaved) layout.
    /// All channel data is interleaved in a single contiguous memory block, e.g., `[L, R, L, R, L,
    /// R]`.
    Packed(&'a [T]),

    /// Planar layout.
    /// Data for each channel is stored in independent, contiguous memory blocks, e.g., `[L, L, L]`
    /// and `[R, R, R]`. The length of the outer Vec represents the number of channels.
    Planar(Vec<&'a [T]>),
}

/// Reads the timing FFmpeg reported for a decoded frame.
///
/// # Safety
/// `frame` must point to a valid FFmpeg `AVFrame`.
pub(crate) unsafe fn frame_timing(frame: *const sys::AVFrame) -> FrameTiming {
    unsafe {
        FrameTiming {
            pts: (*frame).pts,
            samples: (*frame).nb_samples.max(0) as usize,
            sample_rate: (*frame).sample_rate,
        }
    }
}

/// A safe, zero-copy wrapper around FFmpeg's raw `AVFrame`.
///
/// This wrapper is useful for 1-to-N zero-copy dispatching to multiple downstream
/// `Resampler` instances simultaneously.
pub struct AudioFrame<'a> {
    ptr: NonNull<sys::AVFrame>,
    placement: FramePlacement,
    timeline: &'a Timeline,
    packets: Vec<Vec<u8>>,
    _marker: PhantomData<&'a mut ()>,
}

impl<'a> AudioFrame<'a> {
    /// 包装有效音频帧；帧内存与时间线在视图借用期间必须保持有效。
    pub(crate) const fn new(
        ptr: *const sys::AVFrame,
        placement: FramePlacement,
        timeline: &'a Timeline,
    ) -> Self {
        Self {
            ptr: NonNull::new(ptr.cast_mut()).expect("FFmpeg returned a null AVFrame pointer"),
            placement,
            timeline,
            packets: Vec::new(),
            _marker: PhantomData,
        }
    }

    /// 关联自上一输出帧以来送入解码器的原始包。
    pub(crate) fn with_packets(mut self, packets: Vec<Vec<u8>>) -> Self {
        self.packets = packets;
        self
    }

    /// 转移原始包的所有权，不复制载荷。
    pub fn take_packets(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.packets)
    }

    /// 返回未裁剪 PCM 与原本跳过的每声道样本数，供有状态对象渲染使用。
    pub fn full_frame(&self) -> (AudioFrame<'_>, usize) {
        let offset = self.offset();
        let placement = if offset == 0 {
            self.placement
        } else {
            let timing = unsafe { frame_timing(self.ptr.as_ptr()) };
            self.timeline.placement_at_offset(timing, 0)
        };
        (
            AudioFrame::new(self.ptr.as_ptr(), placement, self.timeline),
            offset,
        )
    }

    /// 创建跳过指定前缀的零复制视图，沿用同一条有理数时间线。
    pub fn skip_samples(&self, samples: usize) -> AudioFrame<'_> {
        let skipped = samples.min(self.samples());
        let placement = if skipped == 0 {
            self.placement
        } else {
            let timing = unsafe { frame_timing(self.ptr.as_ptr()) };
            self.timeline
                .placement_at_offset(timing, self.offset() + skipped)
        };
        AudioFrame::new(self.ptr.as_ptr(), placement, self.timeline)
    }

    /// Extracts the underlying raw FFmpeg `AVFrame` pointer.
    ///
    /// This is used internally to pass the raw frame data into FFmpeg's FFI functions
    /// (such as the resampling context).
    pub(crate) const fn as_ptr(&self) -> *const sys::AVFrame {
        self.ptr.as_ptr()
    }

    /// Returns the number of available audio samples (per channel) contained in this frame.
    ///
    /// For example, if a stereo frame contains 1024 samples and has an offset of 100,
    /// this will return `924`.
    #[must_use]
    pub const fn samples(&self) -> usize {
        self.placement.samples()
    }

    /// Returns the offset applied to the beginning of the frame's payload.
    pub(crate) const fn offset(&self) -> usize {
        self.placement.offset()
    }

    /// Returns the actual sample format of this specific frame.
    pub(crate) fn sample_fmt(&self) -> sys::AVSampleFormat {
        unsafe { (*self.ptr.as_ptr()).format }
    }

    /// 获取当前帧的源声道布局
    /// @returns FFmpeg 声道布局引用
    pub fn channel_layout(&self) -> &sys::AVChannelLayout {
        unsafe { &(*self.ptr.as_ptr()).ch_layout }
    }

    /// 获取当前帧的源采样率
    /// @returns 每秒样本数
    pub fn frame_sample_rate(&self) -> i32 {
        unsafe { (*self.ptr.as_ptr()).sample_rate }
    }

    /// 返回相对当前视图的样本偏移，不使用已舍入的 PTS 反算位置。
    pub fn sample_offset_to(&self, target: Duration) -> Option<usize> {
        let timing = unsafe { frame_timing(self.ptr.as_ptr()) };
        self.timeline
            .sample_offset_to(timing, target)
            .map(|offset| offset.saturating_sub(self.offset()))
    }

    /// Returns the precise playback duration of this audio frame, rounded down to whole
    /// nanoseconds.
    #[must_use]
    pub const fn duration(&self) -> Duration {
        self.placement.duration()
    }

    /// Returns the position of this frame's first sample on the public timeline, rounded down to
    /// whole nanoseconds.
    ///
    /// Samples trimmed from the beginning of the frame (preroll, or samples before a seek
    /// target) are already accounted for.
    ///
    /// # Returns
    /// - `Some(Duration)` representing the exact playback time of the frame.
    /// - `None` if the underlying frame lacks a valid PTS (`AV_NOPTS_VALUE`).
    #[must_use]
    pub const fn pts(&self) -> Option<Duration> {
        self.placement.pts()
    }

    /// Returns the public time right after this frame's last sample, if the frame has a PTS.
    pub(crate) const fn end(&self) -> Option<Duration> {
        self.placement.end()
    }

    /// Zero-copy extraction of raw PCM audio data directly from the underlying FFmpeg AVFrame.
    ///
    /// # Returns
    /// * `Ok(RawAudioData)` - The corresponding memory slice enum.
    /// * `Err(AudioError::FormatMismatch)` - The requested `T` does not match the type actually
    ///   output by the underlying decoder.
    pub fn raw_data<T: AudioSample>(&self) -> Result<RawAudioData<'a, T>> {
        let fmt = self.sample_fmt();
        let is_packed = fmt == T::PACKED_FORMAT;
        let is_planar = fmt == T::PLANAR_FORMAT;

        if !is_packed && !is_planar {
            return Err(AudioError::FormatMismatch);
        }

        let logical_samples = self.samples();
        let channels = unsafe { (*self.ptr.as_ptr()).ch_layout.nb_channels } as usize;
        let offset = self.offset();
        let extended_data = unsafe { (*self.ptr.as_ptr()).extended_data };

        if logical_samples == 0 || extended_data.is_null() {
            return if is_packed {
                Ok(RawAudioData::Packed(&[]))
            } else {
                Ok(RawAudioData::Planar(vec![&[]; channels]))
            };
        }

        if is_packed {
            unsafe {
                let base_ptr = (*extended_data).cast::<T>();
                let adjusted_ptr = base_ptr.add(offset * channels);
                let slice = std::slice::from_raw_parts(adjusted_ptr, logical_samples * channels);

                Ok(RawAudioData::Packed(slice))
            }
        } else {
            let mut planes = Vec::with_capacity(channels);
            unsafe {
                for ch in 0..channels {
                    let base_ptr = (*extended_data.add(ch)).cast::<T>();
                    let adjusted_ptr = base_ptr.add(offset);
                    let slice = std::slice::from_raw_parts(adjusted_ptr, logical_samples);

                    planes.push(slice);
                }
            }
            Ok(RawAudioData::Planar(planes))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::mem;

    use ffmpeg_audio_sys::MICROSECONDS_Q;

    use super::*;

    fn frame<'a>(raw: &'a sys::AVFrame, timeline: &'a Timeline, offset: usize) -> AudioFrame<'a> {
        let placement = timeline.placement_at_offset(unsafe { frame_timing(raw) }, offset);
        AudioFrame::new(raw, placement, timeline)
    }

    #[test]
    fn pts_is_relative_to_the_timeline_origin() {
        let mut raw = unsafe { mem::zeroed::<sys::AVFrame>() };
        raw.pts = 10_000_000;
        raw.nb_samples = 1_024;
        raw.sample_rate = 48_000;
        let timeline = Timeline::new(MICROSECONDS_Q, 10_000_000).unwrap();
        assert_eq!(
            frame(&raw, &timeline, 48).pts(),
            Some(Duration::from_millis(1))
        );
        raw.pts = sys::AV_NOPTS_VALUE;
        assert_eq!(frame(&raw, &timeline, 0).pts(), None);
    }

    #[test]
    fn frame_time_boundaries_use_the_same_sample_clock() {
        let mut raw = unsafe { mem::zeroed::<sys::AVFrame>() };
        raw.pts = 10_000;
        raw.nb_samples = 480;
        raw.sample_rate = 48_000;
        let timeline = Timeline::new(MICROSECONDS_Q, 0).unwrap();
        let frame = frame(&raw, &timeline, 0);
        assert_eq!(frame.duration(), Duration::from_millis(10));
        assert_eq!(frame.end(), Some(Duration::from_millis(20)));
    }

    #[test]
    fn seek_offset_preserves_exact_44100_hz_sample_boundaries() {
        let mut raw = unsafe { mem::zeroed::<sys::AVFrame>() };
        raw.sample_rate = 44_100;
        raw.nb_samples = 2_048;
        let timeline = Timeline::new(
            sys::AVRational {
                num: 1,
                den: 44_100,
            },
            0,
        )
        .unwrap();
        raw.pts = 176_128;
        assert_eq!(
            frame(&raw, &timeline, 0).sample_offset_to(Duration::from_secs(4)),
            Some(272)
        );
        raw.pts = 0;
        assert_eq!(
            frame(&raw, &timeline, 0).sample_offset_to(Duration::from_millis(25)),
            Some(1_103)
        );
        raw.pts = -272;
        assert_eq!(
            frame(&raw, &timeline, 272).sample_offset_to(Duration::ZERO),
            Some(0)
        );
    }

    #[test]
    fn frame_falls_back_when_sample_rate_is_unknown() {
        let mut raw = unsafe { mem::zeroed::<sys::AVFrame>() };
        raw.nb_samples = 1_024;
        raw.pts = 1_000;
        let timeline = Timeline::new(MICROSECONDS_Q, 0).unwrap();
        let frame = frame(&raw, &timeline, 0);
        assert_eq!(frame.duration(), Duration::ZERO);
        assert_eq!(frame.end(), Some(Duration::from_millis(1)));
        assert_eq!(frame.sample_offset_to(Duration::from_secs(5)), None);
    }

    #[test]
    fn full_joc_frame_and_trimmed_view_share_exact_pcm_and_pts() {
        let pcm: Vec<f32> = (0..2_048).map(|sample| sample as f32).collect();
        let mut raw = unsafe { mem::zeroed::<sys::AVFrame>() };
        raw.format = sys::AVSampleFormat_AV_SAMPLE_FMT_FLT;
        raw.sample_rate = 44_100;
        raw.nb_samples = 1_024;
        raw.pts = 176_128;
        raw.ch_layout.nb_channels = 2;
        raw.data[0] = pcm.as_ptr().cast_mut().cast();
        raw.extended_data = raw.data.as_mut_ptr();
        let timeline = Timeline::new(
            sys::AVRational {
                num: 1,
                den: 44_100,
            },
            0,
        )
        .unwrap();
        let placement = timeline
            .place(unsafe { frame_timing(&raw) }, Duration::from_secs(4))
            .unwrap();
        let trimmed = AudioFrame::new(&raw, placement, &timeline);
        let (full, skipped) = trimmed.full_frame();
        assert_eq!(skipped, 272);
        assert_eq!(full.samples(), 1_024);
        let restored = full.skip_samples(skipped);
        assert_eq!(restored.pts(), trimmed.pts());
        let RawAudioData::Packed(full_pcm) = full.raw_data::<f32>().unwrap() else {
            panic!("expected packed PCM")
        };
        let RawAudioData::Packed(trimmed_pcm) = restored.raw_data::<f32>().unwrap() else {
            panic!("expected packed PCM")
        };
        assert_eq!(full_pcm, pcm);
        assert_eq!(trimmed_pcm, &pcm[skipped * 2..]);
    }
}
