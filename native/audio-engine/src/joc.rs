use std::sync::Arc;

use anyhow::{ensure, Result};
use ffmpeg_audio::{AudioFrame, RawAudioData, ResampleOptions, Resampler};
use joc_core::binaural::Controls;
use joc_core::stream::{Mode, Stream, StreamConfig, StreamInfo};
use parking_lot::Mutex;

use crate::player::{EventEmitter, PlayerEvent};

/// 跨曲目共享的控制状态，只缓存当前 HRTF
pub struct Settings {
    pub mode: String,
    pub gain_db: f64,
    pub controls: Controls,
    pub hrtf: Option<(String, Arc<Vec<u8>>)>,
    pub revision: u64,
    pub active: bool,
    pub info: StreamInfo,
    pub scene: Option<[f32; 64]>,
    pub callback: Option<EventEmitter>,
}

impl Default for Settings {
    /// 创建默认关闭的对象渲染状态
    fn default() -> Self {
        Self {
            mode: "off".into(),
            gain_db: 0.0,
            controls: Controls::default(),
            hrtf: None,
            revision: 0,
            active: false,
            info: StreamInfo::default(),
            scene: None,
            callback: None,
        }
    }
}

impl Settings {
    /// 仅在生效状态变化时推送低频事件
    /// @param active - 当前帧是否使用对象渲染
    pub fn set_active(&mut self, active: bool) {
        if self.active != active {
            self.active = active;
            if !active {
                self.scene = None;
            }
            if let Some(callback) = &self.callback {
                callback(PlayerEvent::JocStateChanged { active });
            }
        }
    }
}

/// 每条解码链独立保存历史，控制状态由播放器共享
pub struct Renderer {
    pub settings: Arc<Mutex<Settings>>,
    stream: Option<Box<Stream>>,
    converter: Resampler,
    revision: u64,
    failed: bool,
    detected: bool,
    core: Vec<f32>,
    stereo: Vec<f32>,
    discard_samples: usize,
    pending_samples: usize,
}

impl Renderer {
    /// 按设备格式创建 JOC 输出转换器
    /// @param settings - 跨曲目控制状态
    /// @param rate - 设备采样率
    /// @param channels - 设备声道数
    /// @returns 独立渲染会话
    pub fn new(settings: Arc<Mutex<Settings>>, rate: u32, channels: u16) -> Result<Self> {
        Ok(Self {
            settings,
            stream: None,
            converter: Resampler::from_interleaved_f32(
                48_000,
                2,
                ResampleOptions::new()
                    .sample_rate(rate as i32)
                    .channels(i32::from(channels))
                    .format::<f32>(),
            )?,
            revision: u64::MAX,
            failed: false,
            detected: false,
            core: Vec::new(),
            stereo: vec![0.0; 1536 * 2],
            discard_samples: 0,
            pending_samples: 0,
        })
    }

    /// 重置解码历史但保留交互参数
    pub fn reset(&mut self) {
        self.stream = None;
        self.failed = false;
        self.detected = false;
        self.revision = u64::MAX;
        self.discard_samples = 0;
        self.pending_samples = 0;
        let _ = self.converter.flush();
    }

    /// 对同一解码帧的包和完整核心 PCM 执行对象渲染
    /// @param frame - 未下混的源帧
    /// @param packets - 送入 FFmpeg 的原始包
    /// @param skip - 渲染后需要裁去的每声道样本数
    /// @param publish - 是否更新当前播放曲目的场景和状态
    /// @param output - 设备格式的交错输出
    /// @returns 当前帧是否采用对象渲染
    pub fn process(
        &mut self,
        frame: &AudioFrame<'_>,
        packets: &[Vec<u8>],
        skip: usize,
        publish: bool,
        output: &mut Vec<f32>,
    ) -> Result<bool> {
        let settings = self.settings.lock();
        if self.revision != settings.revision {
            self.stream = None;
            self.failed = false;
            self.revision = settings.revision;
            self.converter.flush()?;
        }
        if self.failed || settings.mode == "off" {
            return Ok(false);
        }
        if !self.detected {
            self.detected = contains_joc(packets)?;
            if !self.detected {
                return Ok(false);
            }
        }
        if self.stream.is_none() {
            let mode = if settings.mode == "binaural" {
                Mode::Binaural
            } else {
                Mode::Speaker20
            };
            self.stream = Some(Box::new(Stream::new(StreamConfig {
                mode,
                gain_db: settings.gain_db,
                hrtf: settings
                    .hrtf
                    .as_ref()
                    .map(|(_, bytes)| bytes.as_ref().clone()),
                ..StreamConfig::default()
            })?));
        }
        let stream = self.stream.as_mut().unwrap();
        stream.set_gain_db(settings.gain_db);
        stream.set_controls(&settings.controls);
        drop(settings);
        ensure!(
            frame.frame_sample_rate() == 48_000,
            "JOC 核心采样率必须为 48 kHz"
        );
        let channels = frame.channel_layout().nb_channels as usize;
        ensure!(channels == 6 || channels == 8, "JOC 核心必须为 6 或 8 声道");
        ensure!(!packets.is_empty(), "JOC 帧缺少原始包");
        self.core.clear();
        match frame.raw_data::<f32>()? {
            RawAudioData::Packed(samples) => self.core.extend_from_slice(samples),
            RawAudioData::Planar(planes) => {
                self.core.reserve(frame.samples() * channels);
                for sample in 0..frame.samples() {
                    for plane in &planes {
                        self.core.push(plane[sample]);
                    }
                }
            }
        }
        for packet in packets {
            stream.push_eac3(packet)?;
        }
        stream.push_pcm(&self.core, channels)?;
        stream.flush_pending()?;
        self.discard_samples += skip;
        self.pending_samples += frame.samples() - skip;
        let count = stream.pull(&mut self.stereo, 1536)?;
        let discard = self.discard_samples.min(count);
        self.discard_samples -= discard;
        let end = count.min(discard + self.pending_samples);
        self.pending_samples -= end - discard;
        output.clear();
        if discard < end {
            self.converter
                .process_interleaved_f32(&self.stereo[discard * 2..end * 2])?;
            output.extend_from_slice(self.converter.output_as::<f32>());
        }
        if !publish {
            return Ok(true);
        }
        let mut settings = self.settings.lock();
        settings.info = stream.info();
        if let (Some(scene), Some(controls)) = (stream.take_scene(), stream.controls()) {
            let mut values = [0.0; 64];
            for (index, position) in scene.positions.iter().enumerate() {
                for axis in 0..3 {
                    values[index * 3 + axis] = position[axis] as f32;
                }
            }
            for (index, level) in scene.levels.iter().enumerate() {
                values[45 + index] = *level as f32;
            }
            for axis in 0..3 {
                values[61 + axis] = controls.walk[axis] as f32;
            }
            settings.scene = Some(values);
        }
        Ok(true)
    }

    /// 当前会话发生解析错误后禁用渲染，模式切换或 seek 可重试
    pub fn fail(&mut self) {
        self.failed = true;
        self.stream = None;
    }

    /// 排出双耳渲染和设备重采样延迟，按源样本预算裁去房间尾音
    /// @param output - 设备格式输出
    pub fn finish(&mut self, output: &mut Vec<f32>) -> Result<()> {
        if let Some(stream) = &mut self.stream {
            stream.flush()?;
            while self.pending_samples > 0 || self.discard_samples > 0 {
                let count = stream.pull(&mut self.stereo, 1536)?;
                ensure!(count > 0, "JOC 排空后输出少于源样本预算");
                let discard = self.discard_samples.min(count);
                self.discard_samples -= discard;
                let end = count.min(discard + self.pending_samples);
                self.pending_samples -= end - discard;
                if end > discard {
                    self.converter
                        .process_interleaved_f32(&self.stereo[discard * 2..end * 2])?;
                    output.extend_from_slice(self.converter.output_as::<f32>());
                }
            }
        }
        self.converter.process_interleaved_f32(&[])?;
        output.extend_from_slice(self.converter.output_as::<f32>());
        Ok(())
    }
}

/// 检查包中的所有完整 syncframe 是否包含有效 JOC 元数据
/// @param packets - 一个核心帧关联的原始包
/// @returns 是否存在 JOC 容器
fn contains_joc(packets: &[Vec<u8>]) -> Result<bool> {
    for packet in packets {
        let mut offset = 0;
        while offset < packet.len() {
            let header = joc_core::eac3::parse_syncframe_header(packet, offset)
                .ok_or_else(|| anyhow::anyhow!("无效 E-AC-3 syncframe"))?;
            ensure!(
                header.size > 0 && offset + header.size <= packet.len(),
                "E-AC-3 包不完整"
            );
            let bytes = &packet[offset..offset + header.size];
            let score = |container: &joc_core::emdf::Container| {
                joc_core::id14::score_container_as_joc(bytes, container)
            };
            if let Some((container, _)) =
                joc_core::emdf::find_joc_emdf_optional(bytes, Some(&score))?
            {
                if container.find(joc_core::emdf::ID_JOC).is_some() {
                    return Ok(true);
                }
            }
            offset += header.size;
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 空包不触发渲染，损坏包报告错误而不是伪装成 JOC
    #[test]
    fn detector_handles_empty_and_invalid_input() {
        assert!(!contains_joc(&[]).unwrap());
        assert!(!contains_joc(&[Vec::new()]).unwrap());
        assert!(contains_joc(&[vec![1, 2, 3]]).is_err());
        assert!(contains_joc(&[
            include_bytes!("../../joc-core/tests/fixtures/joc_fixture.eac3").to_vec()
        ])
        .unwrap());
    }

    /// 损坏元数据不会破坏核心帧，禁用后交还现有下混路径
    #[test]
    fn invalid_packets_disable_rendering_until_reset() {
        std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(|| {
                let mut reader = ffmpeg_audio::AudioReader::new(std::io::Cursor::new(
                    include_bytes!("../tests/fixtures/core.eac3").to_vec(),
                ))
                .unwrap();
                let frame = reader.receive_frame().unwrap().unwrap();
                let settings = Arc::new(Mutex::new(Settings {
                    mode: "speaker".into(),
                    ..Settings::default()
                }));
                let mut renderer = Renderer::new(settings, 48_000, 2).unwrap();
                let mut output = Vec::new();
                assert!(renderer
                    .process(&frame, &[vec![1, 2, 3]], 0, false, &mut output)
                    .is_err());
                renderer.fail();
                assert!(!renderer
                    .process(&frame, &[], 0, false, &mut output)
                    .unwrap());
                renderer.reset();
                assert!(!renderer.failed);
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
