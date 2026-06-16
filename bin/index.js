#!/usr/bin/env node

import { execSync } from 'child_process';
import { Octokit } from '@octokit/rest';
import { program } from 'commander';
import ora from 'ora';
import chalk from 'chalk';

// 1. 定義 CLI 參數
program
  .name('ghaction-lis')
  .description('A lightweight CLI tool to listen to GitHub Actions deployment status.')
  .option('--open', '部署成功後，自動呼叫系統預設瀏覽器開啟指定的部署連結。')
  .option('--timeout <number>', '自訂監聽逾時分鐘數', 30)
  .parse(process.argv);

const options = program.opts();
const timeoutMs = options.timeout * 60 * 1000;

// 執行系統指令的小工具
const runCmd = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();

async function main() {
  const spinner = ora('初始化並尋找專案資訊...').start();
  
  try {
    // 2. 自動環境解析：取得 git origin url
    let remoteUrl;
    try {
      remoteUrl = runCmd('git remote get-url origin');
    } catch (e) {
      spinner.fail(chalk.red('這似乎不是一個 Git 專案，或者沒有設定 origin remote。'));
      process.exit(1);
    }

    // 解析 owner 與 repo
    const match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
    if (!match) {
      spinner.fail(chalk.red('無法從 remote URL 解析出 GitHub owner 與 repo。請確認這是 GitHub 專案。'));
      process.exit(1);
    }
    const owner = match[1];
    const repo = match[2];
    
    // 3. 認證整合：從 gh 取得 token
    let token;
    try {
      token = runCmd('gh auth token');
    } catch (e) {
      spinner.fail(chalk.red('找不到有效的 GitHub Token！請確認您已安裝 GitHub CLI 並執行過 `gh auth login` 登入。'));
      process.exit(1);
    }

    const octokit = new Octokit({
      auth: token,
    });

    spinner.succeed(chalk.green(`成功鎖定專案：${owner}/${repo}`));
    spinner.start('正在抓取本地最新 Commit Hash...');

    // 4. 鎖定目標：等待並取得與本地 Commit SHA 吻合的 workflow run
    let localSha;
    try {
      localSha = runCmd('git rev-parse HEAD');
    } catch (e) {
      spinner.fail(chalk.red('無法取得本地端的 Commit Hash，請確認這是一個有效的 Git 儲存庫。'));
      process.exit(1);
    }

    spinner.text = '等待 GitHub 建立對應的 Action 任務...';
    let latestRun = null;
    const waitActionStartTime = Date.now();

    while (!latestRun) {
      if (Date.now() - waitActionStartTime > timeoutMs) {
        spinner.fail(chalk.red(`等待 GitHub 建立 Action 逾時，自動終止。`));
        process.exit(1);
      }

      const { data: runsData } = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        per_page: 5,
      });

      const matchedRun = runsData.workflow_runs.find((run) => run.head_sha === localSha);
      if (matchedRun) {
        latestRun = matchedRun;
      } else {
        // 如果 Hash 不吻合，代表 GitHub 還在處理中，等待 2 秒再重試
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    const commitMsg = latestRun.head_commit?.message?.split('\n')[0] || 'Unknown commit';
    spinner.succeed(chalk.green(`鎖定目標：Run ID #${latestRun.id} (${commitMsg})`));

    // 5. 循環監聽 (Loop)
    spinner.start('GitHub Action 狀態監聽中...');
    const startTime = Date.now();
    let currentRun = latestRun;

    while (['in_progress', 'queued', 'waiting', 'requested', 'pending'].includes(currentRun.status)) {
      if (Date.now() - startTime > timeoutMs) {
        spinner.fail(chalk.red(`監聽逾時 (超過 ${options.timeout} 分鐘)，自動終止。`));
        process.exit(1);
      }

      // 每 5 秒輪詢一次
      await new Promise((resolve) => setTimeout(resolve, 5000));
      
      const { data } = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: latestRun.id,
      });
      currentRun = data;

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      spinner.text = `GitHub Action 執行中 (${currentRun.status})，已耗時 ${elapsed}s...`;
    }

    // 6. 結果顯示與自毀
    const elapsedTotal = Math.floor((Date.now() - startTime) / 1000);
    
    if (currentRun.conclusion === 'success') {
      spinner.succeed(chalk.green(`Action 執行成功！🎉 (總耗時: ${elapsedTotal}s)`));
      
      // 若有 --open 參數，自動開啟網頁
      if (options.open) {
        console.log(chalk.green(`🌐 準備在瀏覽器開啟部署頁面...`));
        let openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        runCmd(`${openCmd} ${currentRun.html_url}`);
      }
      
      process.exit(0);
    } else {
      spinner.fail(chalk.red(`Action 執行失敗！🔥 (結論: ${currentRun.conclusion}, 總耗時: ${elapsedTotal}s)`));
      
      // 智慧除錯：抓取失敗 Log 於終端機輸出
      spinner.start(chalk.yellow('正在抓取失敗 Log 分析...'));
      try {
        const { data: jobsData } = await octokit.rest.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: latestRun.id,
        });

        const failedJob = jobsData.jobs.find((job) => job.conclusion === 'failure');
        spinner.stop();
        
        if (failedJob) {
          console.log('\n' + chalk.bgRed.white.bold(` [錯誤分析] Job: ${failedJob.name} 發生錯誤 `));
          console.log(chalk.blue(`🔗 查看完整紀錄: ${failedJob.html_url}\n`));
          
          // 嘗試抓取 Job 的詳細日誌 (有時候 GitHub API 下載日誌會遇到 Redirect 或格式問題，這邊做簡單擷取)
          try {
            const { data: logData } = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
              owner,
              repo,
              job_id: failedJob.id,
            });
            
            // 擷取最後 25 行顯示
            const lines = String(logData).split('\n');
            const lastLines = lines.slice(-25).join('\n');
            console.log(chalk.gray('--- 錯誤日誌片段 (最後 25 行) ---'));
            console.log(chalk.red(lastLines));
            console.log(chalk.gray('----------------------------------'));
          } catch (e) {
            console.log(chalk.yellow('無法抓取詳細文字 Log (可能因日誌過長或已被 GitHub 清理)。'));
          }
        } else {
          console.log(chalk.yellow('無法定位具體失敗的 Job，請前往 GitHub 介面查看詳情。'));
          console.log(chalk.blue(`🔗 ${currentRun.html_url}`));
        }
      } catch (logErr) {
        spinner.stop();
        console.log(chalk.yellow('分析 Log 時發生錯誤，請直接前往網頁查看。'));
        console.log(chalk.blue(`🔗 ${currentRun.html_url}`));
      }
      
      process.exit(1);
    }

  } catch (err) {
    spinner.fail(chalk.red('發生未預期的系統錯誤！'));
    console.error(err.message);
    process.exit(1);
  }
}

main();
