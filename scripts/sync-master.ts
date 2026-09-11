#!/usr/bin/env node

/**
 * 自动化合并脚本
 * 将 dev 分支（或上游 upstream/dev）最新提交合并至 master 分支
 * 包含工作区检查、拉取更新、自动合并、类型检查与可选推送
 */

import { execSync } from "child_process";

interface CommandOptions {
  push: boolean;
}

const parseArgs = (): CommandOptions => {
  const args = process.argv.slice(2);
  return {
    push: args.includes("--push") || args.includes("-p"),
  };
};

const run = (command: string, silent = false): string => {
  return execSync(command, {
    encoding: "utf-8",
    stdio: silent ? "pipe" : "inherit",
  });
};

const runCapture = (command: string): string => {
  try {
    return execSync(command, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
};

const main = (): void => {
  const options = parseArgs();

  console.log("=== 开始执行 dev -> master 自动化合并 ===");

  // 检查工作区状态（忽略未追踪文件）
  const statusOutput = runCapture("git status --porcelain");
  const hasTrackedChanges = statusOutput
    .split("\n")
    .some((line) => line.trim() && !line.startsWith("??"));

  if (hasTrackedChanges) {
    console.error("错误: 检测到未提交的改动，请先保存或暂存工作区修改后重试。");
    process.exit(1);
  }

  // 检测远程仓库配置
  const remotes = runCapture("git remote")
    .split("\n")
    .map((r) => r.trim());
  const hasUpstream = remotes.includes("upstream");
  const hasOrigin = remotes.includes("origin");

  console.log(`远程配置: origin=${hasOrigin}, upstream=${hasUpstream}`);

  // 同步远程分支
  if (hasUpstream) {
    console.log("正在从 upstream 获取最新提交...");
    run("git fetch upstream dev");
  }
  if (hasOrigin) {
    console.log("正在从 origin 获取最新提交...");
    run("git fetch origin");
  }

  // 确保本地 dev 分支为最新
  const targetDevRef = hasUpstream ? "upstream/dev" : "origin/dev";
  console.log(`使用目标源: ${targetDevRef}`);

  run("git checkout dev");
  run(`git merge --ff-only ${targetDevRef}`);

  // 切换到 master 并更新
  console.log("正在切换到 master 分支...");
  run("git checkout master");
  if (hasOrigin) {
    try {
      run("git pull --ff-only origin master");
    } catch {
      console.warn("提示: 无法快进更新 master 分支，将基于当前本地 master 进行合并。");
    }
  }

  // 检查是否已有新提交需要合并
  const unmergedCommits = runCapture("git log master..dev --oneline");
  if (!unmergedCommits) {
    console.log("dev 分支的所有提交已包含在 master 中，无需合并。");
    return;
  }

  console.log("发现待合并提交:");
  console.log(unmergedCommits);

  // 执行合并
  console.log("正在合并 dev 到 master...");
  try {
    run("git merge dev -m \"Merge branch 'dev' into master\"");
  } catch (err) {
    console.error("合并过程出现冲突，请手动解决冲突后提交。");
    throw err;
  }

  // 运行类型检查确保无破坏
  console.log("正在执行类型检查 (pnpm typecheck)...");
  try {
    run("pnpm typecheck");
  } catch (err) {
    console.error("类型检查未通过，请检查代码后重试。");
    throw err;
  }

  console.log("合并完成并通过类型检查！");

  // 可选推送
  if (options.push) {
    console.log("正在推送 master 到 origin...");
    run("git push origin master");
    console.log("已成功推送至 origin/master！");
  } else {
    console.log(
      "提示: 可执行 `git push origin master` 完成推送，或在运行时加上 `--push` 参数自动推送。",
    );
  }
};

main();
