import { spawnSync } from "node:child_process";
import process from "node:process";

interface NativeModule {
  name: string;
  enabled?: boolean;
}

const modules: NativeModule[] = [
  {
    name: "audio-engine",
  },
  {
    name: "audio-capture",
    enabled: process.platform === "win32" || process.platform === "linux",
  },
  {
    name: "media-ctrl",
  },
  {
    name: "taskbar-lyric",
    enabled: process.platform === "win32",
  },
  {
    name: "taskbar-thumbnail",
    enabled: process.platform === "win32",
  },
  {
    name: "opencc",
  },
];

const isRustAvailable = () => {
  const result = spawnSync("cargo", ["--version"], {
    stdio: "ignore",
  });

  return !result.error && !result.signal && result.status === 0;
};

if (process.env.SKIP_NATIVE_BUILD === "true" || process.env.SKIP_NATIVE_BUILD === "1") {
  console.log("[BuildNative] SKIP_NATIVE_BUILD 已设置，跳过原生模块构建");
  process.exit(0);
}

if (!isRustAvailable()) {
  console.error("[BuildNative] 错误：检测不到 Rust 工具链");
  console.error("[BuildNative] 未设置 SKIP_NATIVE_BUILD，因此必须包含 Rust 环境才能继续");
  console.error(
    "[BuildNative] 安装 Rust (https://rust-lang.org/tools/install/) 或者设置环境变量 SKIP_NATIVE_BUILD=true",
  );
  process.exit(1);
}

const parseArgs = () => {
  const options: {
    isDev: boolean;
    passing?: string[];
  } = {
    isDev: false,
  };

  const argv = process.argv;
  let index = 2;

  while (index < argv.length) {
    switch (argv[index]) {
      case "--dev": {
        options.isDev = true;
        index += 1;
        break;
      }
      case "--": {
        options.passing = argv.slice(index + 1);
        index = argv.length;
        break;
      }
      default: {
        console.error(`[BuildNative] 错误：未知参数 ${argv[index]}`);
        process.exit(1);
      }
    }
  }

  return options;
};

const napiArgs = ["--no-const-enum"];
const options = parseArgs();

if (!options.isDev) napiArgs.push("--release");
if (options.passing) napiArgs.push(...options.passing);

for (const mod of modules) {
  if (mod.enabled === false) {
    continue;
  }
  const cwd = `native/${mod.name}`;

  const buildType = options.isDev ? "debug" : "release";
  console.log(`[BuildNative] 构建 ${mod.name} (${buildType})`);

  const result = spawnSync("napi", ["build", ...napiArgs], {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd,
  });

  if (result.error) {
    console.error("[BuildNative] 模块构建失败，进程启动失败", result.error);
    process.exit(1);
  }
  if (result.signal) {
    console.error("[BuildNative] 模块构建失败，进程被信号终止", result.signal);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error("[BuildNative] 模块构建失败，进程异常退出", result.status);
    process.exit(result.status ?? 1);
  }
}

if (process.platform === "win32") {
  const isDotnetAvailable = () => {
    const res = spawnSync("dotnet", ["--version"], { stdio: "ignore" });
    return !res.error && !res.signal && res.status === 0;
  };
  if (isDotnetAvailable()) {
    console.log("[BuildNative] 构建 CavernBridge (Native AOT)");
    const dotnetRes = spawnSync(
      "dotnet",
      [
        "publish",
        "native/cavern-bridge/CavernBridge.csproj",
        "-c",
        "Release",
        "-r",
        "win-x64",
        "-o",
        "native/audio-engine",
      ],
      {
        stdio: "inherit",
        shell: true,
      },
    );
    if (dotnetRes.status !== 0) {
      console.warn("[BuildNative] 警告：CavernBridge 构建失败，杜比全景声空间解码功能将不可用");
    }
  }
}
