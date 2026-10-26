#!/usr/bin/env node

/**
 * 在独立 worktree 中将最新远端 dev 合入最新 origin/master。
 * 默认仅保留本地集成；--push / -p 发布集成分支并创建或复用 PR，绝不推送 master。
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

let integrationWorktree: string | undefined;

const command = (file: string, args: string[], cwd?: string, capture = false): string => {
  const result = execFileSync(file, args, {
    cwd,
    encoding: "utf-8",
    stdio: capture ? "pipe" : "inherit",
  });
  return result?.trim() ?? "";
};

const git = (args: string[], cwd?: string, capture = false): string =>
  command("git", args, cwd, capture);

const gitPredicate = (args: string[], cwd: string): boolean => {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr || `git ${args.join(" ")} 执行失败`);
};

// pnpm 在 Windows 上是 .cmd；仅将固定命令交给 shell，git/gh 参数始终直接传递。
const pnpm = (
  args: "--version" | "install --frozen-lockfile" | "typecheck" | "test",
  cwd: string,
): string => {
  const result = execSync(`pnpm ${args}`, {
    cwd,
    encoding: "utf-8",
    stdio: args === "--version" ? "pipe" : "inherit",
  });
  return result?.trim() ?? "";
};

const githubRepository = (origin: string): string => {
  const ssh = /^git@([^:]+):(.+)$/.exec(origin);
  const url = ssh ? new URL(`https://${ssh[1]}/${ssh[2]}`) : new URL(origin);
  const repository = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("origin 必须指向可创建 PR 的 GitHub 仓库。");
  }
  return `${url.hostname}/${repository}`;
};

const main = (): void => {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--push" && arg !== "-p")) {
    throw new Error("用法: pnpm sync:master [--push|-p]");
  }
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error("同步需要 Node.js 24，请先切换 Node 版本。");
  }
  const push = args.includes("--push") || args.includes("-p");
  const root = git(["rev-parse", "--show-toplevel"], undefined, true);
  if (git(["status", "--porcelain=v1", "--untracked-files=all"], root, true)) {
    throw new Error(
      "工作区包含未提交或未跟踪文件；请先保存它们。脚本不会 stash、覆盖或切换当前分支。",
    );
  }

  const remotes = git(["remote"], root, true).split("\n");
  if (!remotes.includes("origin")) throw new Error("缺少 origin 远端，无法确定最新 master。");
  const sourceRemote = remotes.includes("upstream") ? "upstream" : "origin";
  git(["fetch", "origin", "refs/heads/master:refs/remotes/origin/master"], root);
  git(["fetch", sourceRemote, `refs/heads/dev:refs/remotes/${sourceRemote}/dev`], root);
  const base = git(["rev-parse", "refs/remotes/origin/master^{commit}"], root, true);
  const source = git(["rev-parse", `refs/remotes/${sourceRemote}/dev^{commit}`], root, true);
  if (gitPredicate(["merge-base", "--is-ancestor", source, base], root)) {
    console.log("最新远端 dev 已包含在 origin/master 中，无需集成。");
    return;
  }

  // 同一组输入复用同名分支，但绝不重置已有分支或覆盖额外提交。
  const branch = `integration/sync-dev-${base.slice(0, 12)}-${source.slice(0, 12)}`;
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/heads/${branch}`;
  const localTip = gitPredicate(["show-ref", "--verify", "--quiet", localRef], root)
    ? git(["rev-parse", localRef], root, true)
    : "";
  let remoteTip = "";
  if (git(["ls-remote", "--heads", "origin", remoteRef], root, true)) {
    git(["fetch", "origin", remoteRef], root);
    remoteTip = git(["rev-parse", "FETCH_HEAD"], root, true);
  }
  if (localTip && remoteTip && localTip !== remoteTip) {
    throw new Error(`${branch} 的本地和远端提交不同；为保护已有工作，停止同步。`);
  }
  const existingTip = remoteTip || localTip;
  if (existingTip) {
    const parents = git(["rev-list", "--parents", "-n", "1", existingTip], root, true).split(" ");
    if (parents.length !== 3 || parents[1] !== base || parents[2] !== source) {
      throw new Error(
        `${branch} 已存在且不是这组输入的完整合并提交；请检查保留的分支/worktree，脚本不会覆盖它。`,
      );
    }
  }

  const path = join(dirname(root), `${basename(root)}-sync-dev-master-${randomUUID()}`);
  if (existingTip) {
    // 不切换或修改可能已被其他 worktree 使用的分支。
    git(["worktree", "add", "--detach", path, existingTip], root);
  } else {
    git(["worktree", "add", "-b", branch, path, base], root);
  }
  integrationWorktree = path;
  console.log(`集成工作区: ${path}\n集成分支: ${branch}\n基线: ${base}\n来源: ${source}`);
  if (!existingTip) {
    git(
      ["merge", "--no-ff", source, "-m", `Merge ${sourceRemote}/dev into master via ${branch}`],
      path,
    );
  }

  const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf-8")) as {
    packageManager?: string;
  };
  const pinnedPnpm = /^pnpm@(12\.\d+\.\d+)(?:\+.*)?$/.exec(manifest.packageManager ?? "")?.[1];
  if (!pinnedPnpm || pnpm("--version", path) !== pinnedPnpm) {
    throw new Error(
      `请安装集成结果 packageManager 指定的 ${manifest.packageManager ?? "pnpm 12"} 后再检查此工作区。`,
    );
  }
  pnpm("install --frozen-lockfile", path);
  pnpm("typecheck", path);
  pnpm("test", path);
  const tip = git(["rev-parse", "HEAD"], path, true);
  if (git(["status", "--porcelain=v1", "--untracked-files=all"], path, true)) {
    throw new Error("安装或检查修改了集成工作区；请检查保留的现场，不会发布未经提交的结果。");
  }
  console.log("集成结果已通过冻结锁安装、类型检查和测试。原工作区和分支保持不变。");
  if (!push) {
    console.log(`仅完成本地集成。发布请再次运行 pnpm sync:master --push；工作区保留于 ${path}。`);
    return;
  }

  const repository = githubRepository(git(["remote", "get-url", "origin"], root, true));
  const gh = (args: string[], capture = false): string => command("gh", args, root, capture);
  gh(["repo", "view", repository, "--json", "nameWithOwner"], true);
  if (!remoteTip) {
    // 发布前重新检查，遇到并发创建也不主动更新既有远端分支；push 本身禁止 force。
    if (git(["ls-remote", "--heads", "origin", remoteRef], root, true)) {
      throw new Error(`${branch} 已被另一个同步创建，请重新运行以安全复用。`);
    }
    git(["push", "origin", `${tip}:${remoteRef}`], root);
  }
  const prs = JSON.parse(
    gh(
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--base",
        "master",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "state,url,headRefOid",
      ],
      true,
    ),
  ) as { state: string; url: string; headRefOid: string }[];
  const open = prs.find((pr) => pr.state === "OPEN");
  if (open) {
    if (open.headRefOid !== tip) throw new Error(`已有 PR 的提交已变化，请手动检查: ${open.url}`);
    console.log(`复用 PR: ${open.url}`);
    return;
  }
  if (prs.length) throw new Error(`已有同步 PR 已关闭或合并，不自动重开或覆盖: ${prs[0].url}`);
  gh([
    "pr",
    "create",
    "--repo",
    repository,
    "--base",
    "master",
    "--head",
    branch,
    "--title",
    "Sync dev into master",
    "--body",
    [
      `将 ${sourceRemote}/dev (${source}) 合入 origin/master (${base})。`,
      "同步流程已对该集成提交执行 pnpm install --frozen-lockfile、pnpm typecheck 和 pnpm test。",
      "未直接更新 master；请审查本 PR 后按仓库保护规则合并。",
      "检查触发说明：使用具有工作流触发权限的 SYNC_TOKEN/PAT 创建或更新 PR 时，正常触发 PR 工作流。",
      "若使用 GITHUB_TOKEN，GitHub 不会因此触发下游 push/PR 工作流；本次同步检查不代表三平台构建或其他 PR 检查已运行。",
      "这种情况下请由有权限的用户关闭并重新打开 PR 以触发 PR 检查，或手动 dispatch Test 和 Build Dev 并选择本集成分支；必需检查仍须满足。",
    ].join("\n\n"),
  ]);
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (integrationWorktree) {
    console.error(
      `现场保留于 ${integrationWorktree}。冲突请在该目录解决并提交；检查失败请在该目录修复并重新检查。原工作区未切换，master 未推送。`,
    );
  }
  process.exitCode = 1;
}
