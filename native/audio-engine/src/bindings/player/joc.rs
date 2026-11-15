use super::*;
use joc_core::sofa_binaural::head_rotation;

/// 对象渲染模式与当前 HRTF
#[napi(object)]
pub struct JsJocMode {
    #[napi(ts_type = "'off' | 'speaker' | 'binaural'")]
    pub mode: String,
    pub hrtf_path: Option<String>,
    pub gain_db: f64,
}

/// 双耳交互参数，角度单位为弧度、位移单位为米
#[napi(object)]
pub struct JsJocControls {
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub focus: f64,
    pub height: f64,
    pub gains: Option<Vec<f64>>,
}

/// 当前对象渲染状态
#[napi(object)]
pub struct JsJocStatus {
    pub active: bool,
    pub mode: String,
    pub peak: f64,
    pub over_unity: f64,
    pub missing_joc_frames: f64,
}

#[napi]
impl AudioPlayer {
    /// 切换对象渲染模式，重建当前播放链以避免旧 PCM 缓冲延迟生效
    /// @param options - 模式、HRTF 路径与输出增益
    /// @returns 设置和必要的当前位置重载完成
    #[napi]
    pub async fn set_joc_mode(&self, options: JsJocMode) -> Result<()> {
        if !matches!(options.mode.as_str(), "off" | "speaker" | "binaural")
            || !options.gain_db.is_finite()
        {
            return Err(Error::from_reason("JOC 模式或增益无效"));
        }
        let (settings, position, loaded) = {
            let player = self.inner.lock();
            (
                Arc::clone(&player.joc),
                player.position(),
                player.state() != PlayerState::Idle && player.state() != PlayerState::Stopped,
            )
        };
        let changed = {
            let mut settings = settings.lock();
            let mut changed = settings.mode != options.mode;
            if let Some(path) = options.hrtf_path {
                if settings
                    .hrtf
                    .as_ref()
                    .is_none_or(|(cached, _)| cached != &path)
                {
                    let bytes = std::fs::read(&path)
                        .map_err(|error| Error::from_reason(format!("读取 HRTF 失败: {error}")))?;
                    joc_core::jochrtf::load_jochrtf(&bytes)
                        .map_err(|error| Error::from_reason(error.to_string()))?;
                    settings.hrtf = Some((path, Arc::new(bytes)));
                    changed = true;
                }
            }
            if options.mode == "binaural" && settings.hrtf.is_none() {
                return Err(Error::from_reason("双耳模式需要 .jochrtf 文件路径"));
            }
            settings.mode = options.mode;
            settings.gain_db = options.gain_db;
            if changed {
                settings.revision += 1;
            }
            changed
        };
        if changed && loaded {
            self.seek(position).await?;
        }
        Ok(())
    }

    /// 更新头部姿态、站位与对象增益，省略 gains 时保持原值
    /// @param options - 与 joc_set_controls 相同的交互参数
    #[napi]
    pub fn set_joc_controls(&self, options: JsJocControls) -> Result<()> {
        let values = [
            options.yaw,
            options.pitch,
            options.roll,
            options.x,
            options.y,
            options.z,
            options.focus,
            options.height,
        ];
        if values.iter().any(|value| !value.is_finite())
            || options.gains.as_ref().is_some_and(|gains| {
                gains.len() != 16 || gains.iter().any(|gain| !gain.is_finite())
            })
        {
            return Err(Error::from_reason(
                "JOC 控件必须为有限数值，gains 长度必须为 16",
            ));
        }
        let player = self.inner.lock();
        let mut settings = player.joc.lock();
        settings.controls.head = head_rotation(options.yaw, options.pitch, options.roll);
        settings.controls.walk = [options.x, options.y, options.z];
        settings.controls.focus = options.focus;
        settings.controls.height = options.height;
        if let Some(gains) = options.gains {
            settings.controls.gains.copy_from_slice(&gains);
        }
        Ok(())
    }

    /// 获取最近一帧的 64 浮点场景布局，非生效双耳模式返回空
    /// @returns 15 组位置、16 路电平与 3 个站位值
    #[napi]
    pub fn get_joc_scene(&self) -> Option<Float32Array> {
        let player = self.inner.lock();
        let settings = player.joc.lock();
        if !settings.active || settings.mode != "binaural" {
            return None;
        }
        settings.scene.map(|scene| scene.to_vec().into())
    }

    /// 获取当前对象渲染是否生效及峰值统计
    /// @returns 模式、生效状态、峰值、超限样本和缺失元数据帧数
    #[napi]
    pub fn get_joc_status(&self) -> JsJocStatus {
        let player = self.inner.lock();
        let settings = player.joc.lock();
        JsJocStatus {
            active: settings.active,
            mode: settings.mode.clone(),
            peak: settings.info.peak,
            over_unity: settings.info.over_unity as f64,
            missing_joc_frames: settings.info.missing_joc_frames as f64,
        }
    }
}
