//! TaskbarService：通过命令队列驱动的任务栏歌词嵌入服务。
//!
//! 单后台线程接收 NAPI 命令，按 win10/win11 策略管理任务栏嵌入和 UIA 重扫，
//! 自带去抖（聚合连续 Update）和 UIA 冷启动重试

use std::ffi::c_void;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

use crate::strategy::{LayoutParams, LegacyStrategy, TaskbarStrategy, Win11Strategy, sync_z_order};
use crate::utils::{ComApartmentGuard, get_windows_build_number};
use crate::{JsTaskbarLayout, take_valid_hwnd};
use napi::{
    Status,
    bindgen_prelude::Function,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use windows::Win32::Foundation::HWND;

/// 置顶状态比对间隔：全屏应用切换时歌词窗口最多滞后这么久才随任务栏沉下/浮起
const Z_ORDER_SYNC_INTERVAL: Duration = Duration::from_millis(250);

type LayoutTsfn =
    ThreadsafeFunction<JsTaskbarLayout, UnknownReturnValue, JsTaskbarLayout, Status, false>;

enum TaskbarCommand {
    Embed {
        hwnd_ptr: usize,
    },
    Update {
        width: i32,
    },
    /// explorer 重启后重新初始化策略并用最近的 hwnd/width 恢复
    Reinit,
    Stop,
}

#[napi]
pub struct TaskbarService {
    sender: Sender<TaskbarCommand>,
}

#[napi]
impl TaskbarService {
    #[napi(
        constructor,
        ts_args_type = "callback: (layout: JsTaskbarLayout) => void"
    )]
    #[allow(clippy::needless_pass_by_value)]
    pub fn new(callback: Function<JsTaskbarLayout, UnknownReturnValue>) -> napi::Result<Self> {
        let tsfn = callback
            .build_threadsafe_function::<JsTaskbarLayout>()
            .build_callback(|ctx| Ok(ctx.value))?;

        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            worker_loop(&rx, &tsfn);
        });

        Ok(Self { sender: tx })
    }

    /// 嵌入窗口到任务栏。传入 Electron BrowserWindow 的 native handle (Buffer → usize)
    #[napi]
    pub fn embed_window_by_ptr(&self, hwnd_ptr: f64) {
        let _ = self.sender.send(TaskbarCommand::Embed {
            hwnd_ptr: hwnd_ptr as usize,
        });
    }

    /// 更新歌词显示宽度，触发重新计算布局
    #[napi]
    pub fn update(&self, lyric_width: i32) {
        let _ = self
            .sender
            .send(TaskbarCommand::Update { width: lyric_width });
    }

    /// 通知服务重建策略（explorer.exe 重启时由 JS 层调用）
    #[napi]
    pub fn reinit(&self) {
        let _ = self.sender.send(TaskbarCommand::Reinit);
    }

    /// 停止服务并恢复任务栏原始状态
    #[napi]
    pub fn stop(&self) {
        let _ = self.sender.send(TaskbarCommand::Stop);
    }
}

fn worker_loop(rx: &Receiver<TaskbarCommand>, tsfn: &LayoutTsfn) {
    // 进入 MTA apartment，作用域结束自动配对 CoUninitialize；失败直接退出线程
    let Some(_com_guard) = ComApartmentGuard::try_init() else {
        return;
    };

    let mut strategy = create_strategy();
    // 记忆最近的 hwnd/width，explorer 重启后 Reinit 据此恢复
    let mut last_hwnd: Option<usize> = None;
    let mut last_width: i32 = 0;

    loop {
        let msg = match rx.recv_timeout(Z_ORDER_SYNC_INTERVAL) {
            Ok(msg) => msg,
            Err(RecvTimeoutError::Timeout) => {
                if let (Some(s), Some(hwnd)) = (strategy.as_ref(), last_hwnd) {
                    sync_z_order(HWND(hwnd as *mut c_void), s.taskbar_hwnd());
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        match msg {
            TaskbarCommand::Embed { hwnd_ptr } => {
                if let Some(hwnd) = take_valid_hwnd(hwnd_ptr) {
                    last_hwnd = Some(hwnd_ptr);
                    if let Some(s) = strategy.as_ref() {
                        s.embed_window(hwnd);
                    }
                }
            }

            TaskbarCommand::Update { width } => {
                let mut final_width = width;
                let mut stop_signal = false;
                let mut reinit_requested = false;

                while let Ok(next_msg) = rx.try_recv() {
                    match next_msg {
                        TaskbarCommand::Update { width: w } => final_width = w,
                        TaskbarCommand::Embed { hwnd_ptr } => {
                            if let Some(hwnd) = take_valid_hwnd(hwnd_ptr) {
                                last_hwnd = Some(hwnd_ptr);
                                if let Some(s) = strategy.as_ref() {
                                    s.embed_window(hwnd);
                                }
                            }
                        }
                        TaskbarCommand::Reinit => {
                            reinit_requested = true;
                        }
                        TaskbarCommand::Stop => {
                            stop_signal = true;
                            break;
                        }
                    }
                }

                if stop_signal {
                    break;
                }

                last_width = final_width;

                if reinit_requested {
                    do_reinit(&mut strategy, last_hwnd);
                }

                if !run_updates(
                    &mut strategy,
                    &mut last_width,
                    &mut last_hwnd,
                    rx,
                    &mut |layout| {
                        tsfn.call(layout, ThreadsafeFunctionCallMode::NonBlocking);
                    },
                    &mut do_reinit,
                ) {
                    break;
                }
            }

            TaskbarCommand::Reinit => {
                do_reinit(&mut strategy, last_hwnd);
                if last_width > 0
                    && !run_updates(
                        &mut strategy,
                        &mut last_width,
                        &mut last_hwnd,
                        rx,
                        &mut |layout| {
                            tsfn.call(layout, ThreadsafeFunctionCallMode::NonBlocking);
                        },
                        &mut do_reinit,
                    )
                {
                    break;
                }
            }

            TaskbarCommand::Stop => {
                break;
            }
        }
    }

    if let Some(s) = strategy.as_ref() {
        s.restore();
    }
}

/// Drop 旧策略（自动 restore），新建策略并用最近的 hwnd 重新嵌入
fn do_reinit(strategy: &mut Option<Box<dyn TaskbarStrategy>>, last_hwnd: Option<usize>) {
    debug!("TaskbarCreated → 重建策略");
    *strategy = None;
    *strategy = create_strategy();
    if let (Some(s), Some(hwnd)) = (strategy.as_ref(), last_hwnd.and_then(take_valid_hwnd)) {
        s.embed_window(hwnd);
    }
}

enum UpdateOutcome {
    Complete,
    Reinit,
    Stop,
}

/// 外层持有窗口和宽度；退避中的重建指令必须在此执行后继续更新。
fn run_updates(
    strategy: &mut Option<Box<dyn TaskbarStrategy>>,
    last_width: &mut i32,
    last_hwnd: &mut Option<usize>,
    rx: &Receiver<TaskbarCommand>,
    emit: &mut impl FnMut(JsTaskbarLayout),
    reinit: &mut impl FnMut(&mut Option<Box<dyn TaskbarStrategy>>, Option<usize>),
) -> bool {
    loop {
        match run_update_with_retry(strategy, last_width, last_hwnd, emit, rx) {
            UpdateOutcome::Complete => return true,
            UpdateOutcome::Stop => return false,
            UpdateOutcome::Reinit => reinit(strategy, *last_hwnd),
        }
    }
}

/// 对 `update_layout` 做有界退避重试，专门兜底 UIA 冷启动首次扫描返回 None 的情形。
///
/// 重试窗口累计约 1.1s：第一次立即尝试，之后分别等 50/150/300/600ms；
/// 每次等待都用 `recv_timeout` 可被新命令打断（新 Update 改宽度、Embed 继续嵌入、Stop 退出）。
///
/// 注意：`update_layout` 返回 `Some(layout)`（含"两侧空间都 0"这种合法的"无空间"情况）会立即 emit 并返回——
/// 这种是真·无位置展示，不该被当成失败；只有真·扫描失败（UIA 树冷启拿不到内容）才会走重试。
///
/// 明确返回重建、停止或完成；重建由持有窗口/宽度的外层执行。
fn run_update_with_retry(
    strategy: &mut Option<Box<dyn TaskbarStrategy>>,
    current_width: &mut i32,
    last_hwnd: &mut Option<usize>,
    emit: &mut impl FnMut(JsTaskbarLayout),
    rx: &Receiver<TaskbarCommand>,
) -> UpdateOutcome {
    const DELAYS_MS: &[u64] = &[0, 50, 150, 300, 600];

    for &delay_ms in DELAYS_MS {
        if delay_ms > 0 {
            match rx.recv_timeout(Duration::from_millis(delay_ms)) {
                Ok(TaskbarCommand::Update { width }) => *current_width = width,
                Ok(TaskbarCommand::Embed { hwnd_ptr }) => {
                    if let Some(hwnd) = take_valid_hwnd(hwnd_ptr) {
                        *last_hwnd = Some(hwnd_ptr);
                        if let Some(s) = strategy.as_ref() {
                            s.embed_window(hwnd);
                        }
                    }
                }
                Ok(TaskbarCommand::Reinit) => {
                    return UpdateOutcome::Reinit;
                }
                Ok(TaskbarCommand::Stop) => return UpdateOutcome::Stop,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return UpdateOutcome::Stop,
            }
        }

        if let Some(s) = strategy.as_mut() {
            let params = LayoutParams {
                lyric_width: *current_width,
            };
            if let Some(layout) = s.update_layout(params) {
                let js_layout: JsTaskbarLayout = layout.into();
                emit(js_layout);
                return UpdateOutcome::Complete;
            }
        }
    }

    UpdateOutcome::Complete
}

fn create_strategy() -> Option<Box<dyn TaskbarStrategy>> {
    let build_num = get_windows_build_number();

    let (mut primary, mut secondary): (Box<dyn TaskbarStrategy>, Box<dyn TaskbarStrategy>) =
        if build_num >= 22000 {
            (
                Box::new(Win11Strategy::new()),
                Box::new(LegacyStrategy::new()),
            )
        } else {
            (
                Box::new(LegacyStrategy::new()),
                Box::new(Win11Strategy::new()),
            )
        };

    if primary.init() {
        return Some(primary);
    }

    if secondary.init() {
        return Some(secondary);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strategy::{AvailableSpace, ExtraLayoutInfo, Rect, SystemType, TaskbarLayout};

    struct TestStrategy {
        ready: bool,
    }

    impl TaskbarStrategy for TestStrategy {
        fn init(&mut self) -> bool {
            true
        }

        fn embed_window(&self, _: HWND) -> bool {
            true
        }

        fn taskbar_hwnd(&self) -> HWND {
            HWND::default()
        }

        fn update_layout(&mut self, params: LayoutParams) -> Option<TaskbarLayout> {
            self.ready.then_some(TaskbarLayout {
                space: AvailableSpace {
                    left: Rect {
                        width: params.lyric_width,
                        ..Rect::default()
                    },
                    right: Rect::default(),
                },
                extra: ExtraLayoutInfo {
                    system_type: SystemType::Win11,
                    is_centered: true,
                    is_light: false,
                },
            })
        }

        fn restore(&self) {}
    }

    #[test]
    fn reinit_during_retry_rebuilds_and_emits_latest_layout() {
        let (tx, rx) = mpsc::channel();
        // 预装命令，recv_timeout 无需等待，也不依赖 Explorer 或真实窗口。
        tx.send(TaskbarCommand::Update { width: 240 }).unwrap();
        tx.send(TaskbarCommand::Reinit).unwrap();
        tx.send(TaskbarCommand::Reinit).unwrap();
        let mut strategy: Option<Box<dyn TaskbarStrategy>> =
            Some(Box::new(TestStrategy { ready: false }));
        let mut width = 100;
        let mut hwnd = Some(123);
        let mut rebuilds = 0;
        let mut emitted = Vec::new();

        assert!(run_updates(
            &mut strategy,
            &mut width,
            &mut hwnd,
            &rx,
            &mut |layout| emitted.push(layout.space.left.width),
            &mut |strategy, last_hwnd| {
                assert_eq!(last_hwnd, Some(123));
                rebuilds += 1;
                *strategy = Some(Box::new(TestStrategy {
                    ready: rebuilds == 2,
                }));
            },
        ));
        assert_eq!(rebuilds, 2);
        assert_eq!(emitted, [240]);
        assert_eq!(width, 240);

        // 再次重建仍可更新；停止必须终止重试且不能额外发出旧布局。
        tx.send(TaskbarCommand::Stop).unwrap();
        strategy = Some(Box::new(TestStrategy { ready: false }));
        assert!(!run_updates(
            &mut strategy,
            &mut width,
            &mut hwnd,
            &rx,
            &mut |layout| emitted.push(layout.space.left.width),
            &mut |_, _| panic!("Stop 不应重建策略"),
        ));
        assert_eq!(emitted, [240]);
    }
}
