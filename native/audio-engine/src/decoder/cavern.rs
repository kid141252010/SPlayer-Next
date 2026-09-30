//! CavernBridge 动态加载与杜比全景声元对象解构器。
//!
//! 通过运行时加载 `CavernBridge.dll`（由 .NET Native AOT 编译），
//! 绕过开源解码器无法解构 E-AC-3 JOC / TrueHD Atmos 元对象的限制，
//! 提取 5.1/7.1.4 基础床声道与动态声学对象及每帧的 3D 空间坐标。

#![cfg(target_os = "windows")]

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::OnceLock;

use tracing::{debug, info, warn};
use windows::core::PCWSTR;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CavernStreamInfo {
    pub sample_rate: c_int,
    pub static_channel_count: c_int,
    pub dynamic_object_count: c_int,
    pub total_object_count: c_int,
    pub length_samples: i64,
    pub has_objects: c_int,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CavernObjectInfo {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub volume: f32,
    pub size: f32,
    pub channel_type: c_int,
    pub is_dynamic: c_int,
}

type FnCavernIsAvailable = unsafe extern "C" fn() -> c_int;
type FnCavernOpen = unsafe extern "C" fn(path: *const c_char, info: *mut CavernStreamInfo) -> *mut c_void;
type FnCavernReadBlock = unsafe extern "C" fn(
    handle: *mut c_void,
    sample_count: c_int,
    out_samples: *mut f32,
    out_info: *mut CavernObjectInfo,
) -> c_int;
type FnCavernSeek = unsafe extern "C" fn(handle: *mut c_void, offset: i64) -> c_int;
type FnCavernClose = unsafe extern "C" fn(handle: *mut c_void);

#[allow(dead_code)]
struct CavernVtbl {
    _module: HMODULE,
    is_available: FnCavernIsAvailable,
    open: FnCavernOpen,
    read_block: FnCavernReadBlock,
    seek: FnCavernSeek,
    close: FnCavernClose,
}

// HMODULE is Send/Sync
unsafe impl Send for CavernVtbl {}
unsafe impl Sync for CavernVtbl {}

static CAVERN_VTBL: OnceLock<Option<CavernVtbl>> = OnceLock::new();

/// 将 UTF-16 宽字符串路径加载为 DLL
fn load_library_wide(path: &Path) -> Option<HMODULE> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe { LoadLibraryW(PCWSTR(wide.as_ptr())).ok() }
}

/// 探测并加载 `CavernBridge.dll`
fn get_cavern_vtbl() -> Option<&'static CavernVtbl> {
    CAVERN_VTBL
        .get_or_init(|| {
            // 候选探测路径：
            // 1. 与当前模块同目录 (native/ 或 resources/native/)
            // 2. native/audio-engine/CavernBridge.dll
            // 3. native/cavern-bridge/bin/publish/CavernBridge.dll
            let mut candidates = Vec::new();

            if let Ok(exe_dir) = std::env::current_exe() {
                if let Some(parent) = exe_dir.parent() {
                    candidates.push(parent.join("CavernBridge.dll"));
                    candidates.push(parent.join("native").join("CavernBridge.dll"));
                    candidates.push(parent.join("resources").join("native").join("CavernBridge.dll"));
                }
            }

            if let Ok(cwd) = std::env::current_dir() {
                candidates.push(cwd.join("native").join("audio-engine").join("CavernBridge.dll"));
                candidates.push(cwd.join("native").join("cavern-bridge").join("bin").join("publish").join("CavernBridge.dll"));
                candidates.push(cwd.join("CavernBridge.dll"));
            }

            let mut loaded_module = None;
            for candidate in &candidates {
                if candidate.exists() {
                    if let Some(h) = load_library_wide(candidate) {
                        info!(path = ?candidate, "成功加载 CavernBridge.dll");
                        loaded_module = Some(h);
                        break;
                    }
                }
            }

            if loaded_module.is_none() {
                // 回退到系统标准搜索路径
                let default_name: Vec<u16> = "CavernBridge.dll\0".encode_utf16().collect();
                loaded_module = unsafe { LoadLibraryW(PCWSTR(default_name.as_ptr())).ok() };
            }

            let module = loaded_module?;

            unsafe {
                let sym_avail = GetProcAddress(module, windows::core::s!("cavern_is_available"))?;
                let sym_open = GetProcAddress(module, windows::core::s!("cavern_open"))?;
                let sym_read = GetProcAddress(module, windows::core::s!("cavern_read_block"))?;
                let sym_seek = GetProcAddress(module, windows::core::s!("cavern_seek"))?;
                let sym_close = GetProcAddress(module, windows::core::s!("cavern_close"))?;

                let is_available: FnCavernIsAvailable = std::mem::transmute(sym_avail);
                if is_available() != 1 {
                    warn!("CavernBridge 自检失败");
                    return None;
                }

                Some(CavernVtbl {
                    _module: module,
                    is_available,
                    open: std::mem::transmute(sym_open),
                    read_block: std::mem::transmute(sym_read),
                    seek: std::mem::transmute(sym_seek),
                    close: std::mem::transmute(sym_close),
                })
            }
        })
        .as_ref()
}

/// 检查系统当前是否具备 Cavern 杜比全景声解构能力
pub fn is_cavern_available() -> bool {
    get_cavern_vtbl().is_some()
}

/// 杜比全景声音频块（含床声道与各独立动态对象数据及坐标）
#[allow(dead_code)]
pub struct CavernBlock {
    pub sample_count: usize,
    /// 平面排列的对象样本数据：[对象0 样本...][对象1 样本...]...
    pub planar_samples: Vec<f32>,
    /// 每个对象的时变元数据（空间坐标、音量、声道类型）
    pub object_infos: Vec<CavernObjectInfo>,
}

/// Cavern 杜比全景声流解码器
pub struct CavernDecoder {
    handle: *mut c_void,
    info: CavernStreamInfo,
}

unsafe impl Send for CavernDecoder {}

impl CavernDecoder {
    /// 尝试打开指定音频文件（支持 .ec3, .eac3, .m4a, .mp4, .mka, .wav 等）
    pub fn open(path: &str) -> Option<Self> {
        let vtbl = get_cavern_vtbl()?;
        let c_path = CString::new(path).ok()?;
        let mut info = CavernStreamInfo::default();

        let handle = unsafe { (vtbl.open)(c_path.as_ptr(), &mut info) };
        if handle.is_null() {
            return None;
        }

        debug!(
            rate = info.sample_rate,
            static_ch = info.static_channel_count,
            dynamic_obj = info.dynamic_object_count,
            total_obj = info.total_object_count,
            has_objects = info.has_objects,
            "成功通过 Cavern 打开空间音频流"
        );

        Some(Self { handle, info })
    }

    pub fn sample_rate(&self) -> u32 {
        self.info.sample_rate.max(1) as u32
    }

    #[allow(dead_code)]
    pub fn static_channel_count(&self) -> u32 {
        self.info.static_channel_count.max(0) as u32
    }

    pub fn dynamic_object_count(&self) -> u32 {
        self.info.dynamic_object_count.max(0) as u32
    }

    pub fn total_object_count(&self) -> u32 {
        self.info.total_object_count.max(0) as u32
    }

    /// 是否包含杜比全景声空间动态元对象
    pub fn has_objects(&self) -> bool {
        self.info.has_objects != 0 && self.info.dynamic_object_count > 0
    }

    /// 读取一个音频采样块
    pub fn read_block(&mut self, sample_count: usize) -> Option<CavernBlock> {
        let vtbl = get_cavern_vtbl()?;
        let total_objects = self.total_object_count() as usize;
        if total_objects == 0 || sample_count == 0 {
            return None;
        }

        let total_samples = total_objects * sample_count;
        let mut planar_samples = vec![0.0f32; total_samples];
        let mut object_infos = vec![CavernObjectInfo::default(); total_objects];

        let read = unsafe {
            (vtbl.read_block)(
                self.handle,
                sample_count as c_int,
                planar_samples.as_mut_ptr(),
                object_infos.as_mut_ptr(),
            )
        };

        if read <= 0 {
            return None;
        }

        Some(CavernBlock {
            sample_count: read as usize,
            planar_samples,
            object_infos,
        })
    }

    /// 跳转到指定样本偏移
    pub fn seek(&mut self, sample_offset: i64) -> bool {
        if let Some(vtbl) = get_cavern_vtbl() {
            unsafe { (vtbl.seek)(self.handle, sample_offset) != 0 }
        } else {
            false
        }
    }
}

impl Drop for CavernDecoder {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            if let Some(vtbl) = get_cavern_vtbl() {
                unsafe { (vtbl.close)(self.handle) };
            }
            self.handle = std::ptr::null_mut();
        }
    }
}
