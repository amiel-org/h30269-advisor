# 境内可访问入口（反向代理）

## 为什么需要它

`*.workers.dev` 在大陆被 DNS 污染：本机解析到 Dropbox(162.125.32.2)、
Facebook(69.63.187.12)、Twitter(199.59.149.231) 的 IP，TCP 443 直接超时。
`*.pages.dev` 解析到真实 Cloudflare 边缘节点，可直连（同机实测 TLS 握手
0.5～0.6 秒，证书 CN 正确）。

因此新建一个 Pages 项目，把请求转发给原有 Worker。**Worker 一行未改**：KV、
15:10 定时任务、全部业务逻辑都留在原处，这里只搬字节。

## 结构

```
pages-proxy/
├── functions/[[path]].js   # 唯一逻辑：catch-all 反向代理
├── public/_routes.json     # include 全部路径，否则静态文件会绕过代理
├── public/                 # 无静态资源：页面由上游 Worker 提供
└── wrangler.toml
```

## 关键约定

- 剥离 `host`、`cf-*`、`x-forwarded-*` 等跳数与身份头，不让上游把代理当成真实客户端。
- 删除 `content-encoding` / `content-length`，因为运行时已解码响应体，原值不再成立。
- 把指向上游 `workers.dev` 的 `Location` 改写为相对路径，否则浏览器会被弹回打不开的域名。
- 上游失败时返回可读的 502 JSON，而不是空白边缘错误页。

## 访问地址

- 境内：https://hs300-desk.pages.dev  （直连，无需代理）
- 原地址：https://h30269-hs300.anyongliang027.workers.dev  （需代理）

## 本地与部署

```powershell
cd pages-proxy
npx wrangler pages dev public --port 8794   # 本地：本机在国内连不到上游，会 502，属预期
cd ..
npm run deploy:proxy                        # 部署代理
npm run test:proxy                          # 代理逻辑单测
```

## 局限

- 仅解决 DNS 污染，仍走 Cloudflare 海外节点，晚高峰可能变慢。
- `pages.dev` 若将来也被污染，需要换自有域名；彻底稳定需国内云 + 备案。
- 代理本身无鉴权，知道地址即可访问，与原来 Worker 的公开程度一致。
