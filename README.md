# 红利低波自动决策助手 V3.1

程序自动抓取 `H30269`、中证全指 `000985`、红利低波股息率和中国10年国债收益率，以5年滚动Beta校正40日相对收益，并用2年、3年、5年窗口检查结论稳健性。

## Cloudflare 云端版（推荐）

仓库包含 Cloudflare Worker 云端实现：Worker 负责抓取公开金融数据、执行与本地版一致的 V3.1 规则，并托管原有网页静态资源。云端版支持手工刷新、最近历史记录和交易日收盘后定时刷新。

直接打开：<https://h30269-advisor.anyongliang027.workers.dev>

云端版不需要在本机启动 Python。工作日北京时间 15:10 自动刷新，也可以在网页右上角手工刷新。

```powershell
npm install
npm run test:cloudflare
npm run deploy:cloudflare
```

Cloudflare 使用 `wrangler.jsonc`，静态资源由 `npm run build:cloudflare` 生成到忽略版本管理的 `cloudflare-dist\`。Python 本地版继续保留，作为离线备用和规则对照基线。

## 本地网页版（离线备用）

双击 `run_webapp.bat`，浏览器会打开：

```text
http://127.0.0.1:8765/
```

页面支持刷新数据、切换仓位建议、查看日K与均线、查看原始40日收益差、Beta调整后差值、多窗口Beta和历史判定记录。停止服务可双击 `stop_webapp.bat`。

## V3.1 规则

### 加仓链

1. 5年Beta调整后40日差进入低估区，且2年、3年、5年窗口结论一致。
2. 股债利差仍有支撑。
3. 按计划仓位分批执行；短期趋势只决定执行快慢，不单独决定买入。

### 减仓链

1. Beta调整后40日差处于 `5%~7%` 时只暂停新增，不触发卖出。
2. 战术减仓必须同时满足：2/3/5年窗口调整后差值均 `≥7%`、红利自身40日收益 `≥5%`、站上MA250、连续 `2` 个已收盘交易日确认。
3. 盘中点位不计入连续收盘确认，盘中只提示、不执行减仓。
4. 战术仓条件全部满足后默认只减持仓约 `5%`，核心仓不动。
5. 核心仓降档还要额外满足：高于MA250至少 `10%`、相对过热连续 `5` 个收盘日、股债性价比降至中性或弱支撑。

程序使用明确的 `action_code` 判断动作，不再根据中文结论里是否出现“减仓”二字猜测执行建议。

## 复制到其他电脑

- 目标电脑有 Python：复制整个目录，双击 `install_and_run.bat`，首次会自动安装依赖。
- 目标电脑没有 Python：运行 `build_portable.bat` 生成免 Python 目录和 ZIP，再复制整个打包目录。
- 目标电脑不需要 AI、GPU、Codex、OpenAI Key 或任何模型账号。
- 目标电脑需要 Windows 10/11，并能访问公开金融数据接口。
- 详细说明见 `PORTABLE_README.md`。

## GitHub 更新

源码仓库：<https://github.com/amiel-org/h30269-advisor>

双击 `publish_update.bat`，输入本次更新说明即可提交并推送到 GitHub。Cloudflare Workers Builds 连接 `main` 分支后，每次推送都会自动构建并发布公网版；也可以随时运行 `npm run deploy:cloudflare` 手工发布。
运行产生的行情缓存、报告、日志和打包文件已由 `.gitignore` 排除，不会随源码上传。

## 命令行版

双击 `run_advisor.bat`，或在 PowerShell 中运行：

```powershell
python .\advisor.py
```

每次运行会生成：

- `latest.md`：最新中文报告
- `latest.json`：最新结构化结果
- `reports\`：历史报告
- `cache\`：行情缓存，在线接口短时失败时备用

## 数据源

- 指数历史行情、当天点位：中证指数有限公司公开接口
- 红利低波股息率：蛋卷基金公开指数估值接口
- 中国10年国债收益率：中国债券信息网

程序记录每项数据的来源和日期。行情过旧时会输出“暂停行动”，不会静默拿旧数据给出买卖建议。

## 常用参数

```powershell
# 输出完整JSON
python .\advisor.py --json

# 只使用缓存
python .\advisor.py --offline

# 只使用正式日线，不合并盘中点位
python .\advisor.py --no-intraday

# 临时覆盖股息率或国债收益率
python .\advisor.py --dividend-yield 5.2 --bond-yield 1.75
```

## 模型边界

1. 程序只生成规则化建议，不自动交易。
2. 原始相对收益差只用于观察轮动，不能直接触发卖出。
3. Beta是历史校正系数，不是固定真值，因此页面同时展示2年、3年、5年结果；窗口分歧时动作降级为观察。
4. 短期趋势只控制分批速度，不单独改变买卖方向。
5. 数据源结构变化时程序会报错或降级，不会伪造结果。
