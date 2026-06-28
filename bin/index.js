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
  .option('--chain <workflow-name>', '接續監聽特定的下游任務 (例如: AWS Deploy)')
  .option('--pages', '自動接力監聽 GitHub Pages 部署任務 (等於 --chain "pages build and deployment")')
  .option('--timeout <number>', '自訂監聽逾時分鐘數', 30)
  .parse(process.argv);

const options = program.opts();
const timeoutMs = options.timeout * 60 * 1000;

// 執行系統指令的小工具
const runCmd = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();

async function main() {
  const spinner = ora('初始化並尋找專案資訊...').start();
  
  process.on('SIGINT', () => {
    spinner.fail(chalk.yellow('\n使用者手動中斷監聽。'));
    process.exit(0);
  });
  
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
    
    // 3. 認證整合：優先使用環境變數，其次嘗試 gh CLI
    let token = process.env.GITHUB_TOKEN;
    if (!token) {
      try {
        token = runCmd('gh auth token');
      } catch (e) {
        token = null;
      }
    }

    const octokitOptions = {};
    if (token) {
      octokitOptions.auth = token;
    } else {
      spinner.warn(chalk.yellow('未偵測到 GitHub Token！將以「未登入」身分呼叫 API。'));
      console.log(chalk.gray('👉 注意：這僅適用於「公開專案 (Public)」，且受限於 GitHub 每小時 60 次的呼叫限制，若輪詢太久可能會被阻擋。'));
      spinner.start();
    }

    const octokit = new Octokit(octokitOptions);

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

    // 第一階段成功，判斷是否需要接續監聽 Downstream (Chain) Action
    if (currentRun.conclusion === 'success' && (options.chain || options.pages)) {
      const chainName = options.pages ? 'pages build and deployment' : options.chain;
      spinner.succeed(chalk.green(`第一階段 Action 執行成功！(${currentRun.name})`));
      spinner.start(`等待下游任務觸發 (${chainName})...`);
      
      let chainRun = null;
      const waitChainStartTime = Date.now();
      
      // 尋找下游 Action (必須是第一階段完成後才建立或更新的)
      while (!chainRun) {
        if (Date.now() - waitChainStartTime > timeoutMs) {
          spinner.fail(chalk.red(`等待下游任務 [${chainName}] 逾時，自動終止。`));
          process.exit(1);
        }

        const { data: runsData } = await octokit.rest.actions.listWorkflowRunsForRepo({
          owner,
          repo,
          per_page: 5,
        });

        // 找尋名字相符，且是在我們第一階段啟動之後才觸發的
        const matchedChainRun = runsData.workflow_runs.find(
          (run) => run.name === chainName && new Date(run.created_at) > new Date(waitActionStartTime)
        );

        if (matchedChainRun) {
          chainRun = matchedChainRun;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      spinner.succeed(chalk.green(`鎖定下游任務：Run ID #${chainRun.id} (${chainName})`));
      spinner.start(`下游任務執行中...`);
      
      currentRun = chainRun;
      
      // 監聽第二階段的下游 Action
      while (['in_progress', 'queued', 'waiting', 'requested', 'pending'].includes(currentRun.status)) {
        if (Date.now() - startTime > timeoutMs) {
          spinner.fail(chalk.red(`下游任務監聽逾時，自動終止。`));
          process.exit(1);
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));
        
        const { data } = await octokit.rest.actions.getWorkflowRun({
          owner,
          repo,
          run_id: chainRun.id,
        });
        currentRun = data;

        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        spinner.text = `下游任務執行中 (${currentRun.status})，總耗時 ${elapsed}s...`;
      }
    }

    // 6. 結果顯示與自毀
    const elapsedTotal = Math.floor((Date.now() - startTime) / 1000);
    
    if (currentRun.conclusion === 'success') {
      spinner.succeed(chalk.green(`Action 執行成功！🎉 (總耗時: ${elapsedTotal}s)`));
      console.log(chalk.blue(`🔗 點擊查看紀錄: ${currentRun.html_url}\n`));
      
      // 若有 --open 參數，自動開啟網頁
      if (options.open) {
        console.log(chalk.green(`🌐 準備在瀏覽器開啟部署頁面...`));
        let openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        runCmd(`${openCmd} ${currentRun.html_url}`);
      }
      
      process.exit(0);
    } else {
      spinner.fail(chalk.red(`Action 執行失敗！🔥 (結論: ${currentRun.conclusion}, 總耗時: ${elapsedTotal}s)`));
      
      spinner.start(chalk.yellow('正在定位錯誤網址...'));
      try {
        const { data: jobsData } = await octokit.rest.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: latestRun.id,
        });

        const failedJob = jobsData.jobs.find((job) => job.conclusion === 'failure');
        spinner.stop();
        
        if (failedJob) {
          console.log(chalk.red(`❌ Job [${failedJob.name}] 發生錯誤`));
          console.log(chalk.blue(`🔗 點擊查看紀錄: ${failedJob.html_url}\n`));
        } else {
          console.log(chalk.blue(`🔗 點擊查看紀錄: ${currentRun.html_url}\n`));
        }
      } catch (logErr) {
        spinner.stop();
        console.log(chalk.blue(`🔗 點擊查看紀錄: ${currentRun.html_url}\n`));
      }
      
      process.exit(1);
    }

  } catch (err) {
    spinner.fail(chalk.red('發生未預期的系統錯誤！'));
    
    // 針對 Private Repo 無權限的友善提示
    if (err.status === 404 && !token) {
      console.log(chalk.yellow('\n👉 提示：GitHub 拒絕了存取 (Not Found)。'));
      console.log(chalk.yellow('這通常是因為這是一個「私有專案 (Private Repo)」，而您目前處於未登入狀態。'));
      console.log(chalk.yellow('請設定環境變數 GITHUB_TOKEN，或執行 `gh auth login` 來取得存取權限！\n'));
    } else {
      console.error(err.message);
    }
    
    process.exit(1);
  }
}

main();
