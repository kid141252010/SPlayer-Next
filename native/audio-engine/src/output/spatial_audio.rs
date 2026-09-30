//! Windows Spatial Audio (`ISpatialAudioClient`) 原生空间音频流输出。
//!
//! 通过与系统 Spatial Audio Platform (ISpatialAudioClient) 交互，
//! 传递 5.1/7.1.4 基础床声道与携带三维坐标 (x,y,z) 的动态音频对象，
//! 交由已激活的 Dolby Access (Dolby Atmos for Headphones) 执行官方 HRTF 空间渲染。

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;

use anyhow::{Context, Result};
use tracing::{debug, error, info, warn};
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED, BLOB,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;

use crate::decoder::buffer::Shared;
use crate::decoder::cavern::CavernDecoder;
use crate::output::OutputFailureCallback;
use crate::priority;

/// 静态床声道对应的 AudioObjectType 映射
fn reference_channel_to_audio_object_type(ch: i32) -> AudioObjectType {
    match ch {
        0 => AudioObjectType_FrontLeft,
        1 => AudioObjectType_FrontRight,
        2 => AudioObjectType_FrontCenter,
        3 => AudioObjectType_LowFrequency,
        4 => AudioObjectType_BackLeft,
        5 => AudioObjectType_BackRight,
        6 => AudioObjectType_SideLeft,
        7 => AudioObjectType_SideRight,
        16 => AudioObjectType_TopFrontLeft,
        17 => AudioObjectType_TopFrontRight,
        27 => AudioObjectType_TopBackLeft,
        28 => AudioObjectType_TopBackRight,
        _ => AudioObjectType_None,
    }
}

/// 检查系统当前默认输出端点是否支持空间音频流
pub fn is_spatial_audio_available() -> bool {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    unsafe {
        let enumerator: Result<IMMDeviceEnumerator, _> =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL);
        let Ok(enumerator) = enumerator else { return false; };
        let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eConsole) else {
            return false;
        };
        let spatial_client: Result<ISpatialAudioClient, _> = device.Activate(CLSCTX_ALL, None);
        let Ok(spatial_client) = spatial_client else { return false; };
        spatial_client
            .IsSpatialAudioStreamAvailable(
                &ISpatialAudioObjectRenderStream::IID,
                None,
            )
            .is_ok()
    }
}

/// 空间音频流句柄
pub struct SpatialAudioStream {
    thread: Option<JoinHandle<()>>,
    shutdown_tx: SyncSender<()>,
    paused: Arc<AtomicBool>,
    seek_sample: Arc<AtomicI64>,
    sample_rate: u32,
}

impl SpatialAudioStream {
    pub fn pause(&self) {
        self.paused.store(true, Ordering::Release);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::Release);
    }

    pub fn seek(&self, position_secs: f64) {
        let sample = (position_secs * self.sample_rate as f64) as i64;
        self.seek_sample.store(sample, Ordering::Release);
    }
}

impl Drop for SpatialAudioStream {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(());
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

/// 启动 Windows Spatial Audio 渲染流
pub fn open_spatial_audio_stream(
    device_id: Option<&str>,
    mut decoder: CavernDecoder,
    shared: Arc<Shared>,
    volume: Arc<AtomicU32>,
    stopped: Arc<AtomicBool>,
    paused_init: bool,
    on_failure: OutputFailureCallback,
) -> Result<SpatialAudioStream> {
    let (ready_tx, ready_rx) = sync_channel::<Result<()>>(1);
    let (shutdown_tx, shutdown_rx) = sync_channel::<()>(1);
    let paused = Arc::new(AtomicBool::new(paused_init));
    let paused_clone = Arc::clone(&paused);
    let seek_sample = Arc::new(AtomicI64::new(-1));
    let seek_sample_clone = Arc::clone(&seek_sample);
    let sample_rate = decoder.sample_rate();
    let device_id_owned = device_id.map(ToString::to_string);

    let thread = std::thread::Builder::new()
        .name("spatial-audio-render".to_string())
        .spawn(move || {
            priority::boost_current_audio_thread("spatial-audio-render");
            let com_init = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if com_init.is_err() {
                let _ = ready_tx.send(Err(anyhow::anyhow!("CoInitializeEx 失败")));
                return;
            }

            let result = run_spatial_stream_loop(
                device_id_owned.as_deref(),
                &mut decoder,
                shared,
                seek_sample_clone,
                volume,
                stopped,
                paused_clone,
                on_failure,
                &ready_tx,
                shutdown_rx,
            );

            if let Err(e) = result {
                error!(error = %e, "空间音频渲染线程异常结束");
            }
            unsafe { CoUninitialize() };
        })
        .context("启动空间音频渲染线程失败")?;

    ready_rx
        .recv()
        .context("等待空间音频流就绪超时")??;

    Ok(SpatialAudioStream {
        thread: Some(thread),
        shutdown_tx,
        paused,
        seek_sample,
        sample_rate,
    })
}

fn run_spatial_stream_loop(
    device_id: Option<&str>,
    decoder: &mut CavernDecoder,
    shared: Arc<Shared>,
    seek_sample: Arc<AtomicI64>,
    volume: Arc<AtomicU32>,
    stopped: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    on_failure: OutputFailureCallback,
    ready_tx: &SyncSender<Result<()>>,
    shutdown_rx: std::sync::mpsc::Receiver<()>,
) -> Result<()> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device: IMMDevice = match device_id {
            Some(id) => {
                let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
                enumerator.GetDevice(PCWSTR(wide.as_ptr()))?
            }
            None => enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?,
        };

        let spatial_client: ISpatialAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let sample_rate = decoder.sample_rate();

        // 单声道 32-bit Float 对象格式
        let object_format = WAVEFORMATEX {
            wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
            nChannels: 1,
            nSamplesPerSec: sample_rate,
            nAvgBytesPerSec: sample_rate * 4,
            nBlockAlign: 4,
            wBitsPerSample: 32,
            cbSize: 0,
        };

        // 激活 5.1/7.1.4 完整床声道掩码（含地面环绕与天空顶声道）
        let static_mask = AudioObjectType_FrontLeft
            | AudioObjectType_FrontRight
            | AudioObjectType_FrontCenter
            | AudioObjectType_LowFrequency
            | AudioObjectType_SideLeft
            | AudioObjectType_SideRight
            | AudioObjectType_BackLeft
            | AudioObjectType_BackRight
            | AudioObjectType_TopFrontLeft
            | AudioObjectType_TopFrontRight
            | AudioObjectType_TopBackLeft
            | AudioObjectType_TopBackRight;

        let buffer_event = CreateEventW(None, false, false, None)?;
        let max_dynamic = decoder.dynamic_object_count().min(16);

        let mut params = SpatialAudioObjectRenderStreamActivationParams {
            ObjectFormat: &object_format,
            StaticObjectTypeMask: static_mask,
            MinDynamicObjectCount: 0,
            MaxDynamicObjectCount: max_dynamic,
            Category: AUDIO_STREAM_CATEGORY(1), // AudioCategory_Media
            EventHandle: buffer_event,
            NotifyObject: core::mem::ManuallyDrop::new(None),
        };

        let blob = BLOB {
            cbSize: std::mem::size_of::<SpatialAudioObjectRenderStreamActivationParams>() as u32,
            pBlobData: &mut params as *mut _ as *mut u8,
        };

        let pv = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: core::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 { blob },
                }),
            },
        };

        let stream: ISpatialAudioObjectRenderStream = spatial_client
            .ActivateSpatialAudioStream(&pv)
            .context("激活 Windows 空间音频流失败 (请确认 Windows 声音设置中已开启 Dolby Atmos)")?;

        stream.Start()?;

        info!(
            sample_rate,
            max_dynamic,
            "成功创建并启动 Windows Spatial Audio 流 (Dolby Access 渲染中)"
        );

        let _ = ready_tx.send(Ok(()));

        let mut available_dynamic_objects = 0u32;
        let mut frame_count = 0u32;

        loop {
            // 检查停止信号
            if stopped.load(Ordering::Acquire) || shutdown_rx.try_recv().is_ok() {
                break;
            }

            // 处理跳转 (Seek)
            let seek_target = seek_sample.swap(-1, Ordering::AcqRel);
            if seek_target >= 0 {
                let _ = decoder.seek(seek_target);
            }

            let wait_res = WaitForSingleObject(buffer_event, 100);
            if wait_res != WAIT_OBJECT_0 {
                continue;
            }

            if paused.load(Ordering::Acquire) {
                // 暂停时填充静音帧维持时序
                if stream
                    .BeginUpdatingAudioObjects(
                        &mut available_dynamic_objects,
                        &mut frame_count,
                    )
                    .is_ok()
                {
                    let _ = stream.EndUpdatingAudioObjects();
                }
                continue;
            }

            let begin_res = stream
                .BeginUpdatingAudioObjects(&mut available_dynamic_objects, &mut frame_count);
            if let Err(e) = begin_res {
                warn!(error = %e, "BeginUpdatingAudioObjects 失败");
                on_failure();
                break;
            }

            if frame_count == 0 {
                let _ = stream.EndUpdatingAudioObjects();
                continue;
            }

            // 从 Cavern 解构器拉取对应帧数的音频数据与空间元数据
            let block = decoder.read_block(frame_count as usize);
            let Some(block) = block else {
                let _ = stream.EndUpdatingAudioObjects();
                shared.mark_all_consumed();
                break;
            };

            let gain = f32::from_bits(volume.load(Ordering::Relaxed));
            let total_objects = block.object_infos.len();

            // 写入各对象
            for i in 0..total_objects {
                let meta = &block.object_infos[i];
                let is_dynamic = meta.is_dynamic != 0;

                let audio_obj_res = if is_dynamic {
                    stream.ActivateSpatialAudioObject(AudioObjectType_Dynamic)
                } else {
                    let st = reference_channel_to_audio_object_type(meta.channel_type);
                    if st == AudioObjectType_None {
                        continue;
                    }
                    stream.ActivateSpatialAudioObject(st)
                };

                let Ok(audio_obj) = audio_obj_res else {
                    continue;
                };

                if is_dynamic {
                    // 映射 Cavern 坐标系 (X=左右, Y=前后, Z=高低) 到 Windows 空间音频平台 (x=左右, y=高低, z=前后)
                    let _ = audio_obj.SetPosition(meta.x, meta.z, meta.y);
                }
                let _ = audio_obj.SetVolume(meta.volume * gain);

                let mut buf_ptr = std::ptr::null_mut();
                let mut buf_len = 0u32;
                if audio_obj.GetBuffer(&mut buf_ptr, &mut buf_len).is_ok()
                    && !buf_ptr.is_null()
                    && buf_len >= frame_count
                {
                    let src_offset = i * (frame_count as usize);
                    if src_offset + (frame_count as usize) <= block.planar_samples.len() {
                        let src_slice =
                            &block.planar_samples[src_offset..src_offset + (frame_count as usize)];
                        std::ptr::copy_nonoverlapping(
                            src_slice.as_ptr(),
                            buf_ptr as *mut f32,
                            frame_count as usize,
                        );
                    }
                }
            }

            let _ = stream.EndUpdatingAudioObjects();
            shared.advance_consumed(frame_count as u64 * shared.channels() as u64);
        }

        let _ = stream.Stop();
        let _ = CloseHandle(buffer_event);
        debug!("Windows 空间音频流已优雅关闭");
        Ok(())
    }
}
