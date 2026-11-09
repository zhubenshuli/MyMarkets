# MyMarkets

独立部署的重点产业链与全球宏观行情监测及智能研判服务。

## 涵盖板块
1. **全球大宗与股指（`macro`）**：布伦特原油、伦敦现货黄金（折算人民币克价）、上证指数、恒生科技指数（各交易时段内每 10 分钟定时更新）。
2. **生猪产业链（`pork`）**：全国外三元生猪、农业部白条肉批发、大商所生猪期货连续、15kg 仔猪、二元母猪、能繁母猪存栏、猪粮比价、玉米、豆粕，以及畜牧养殖 ETF（`516670`）周期配置与波段指导（每日北京时间 `00:00` 结算更新）。
3. **航空业（`aviation`）**：上期原油连续、低硫燃料油、美元兑人民币汇率、上海机场、三大航、春秋航空、民航正班客座率，以及中国东航（`600115`）周期配置与波段指导（每日北京时间 `00:05` 结算更新）。
4. **恒生科技（`hstech`）**：恒生科技指数、离岸汇率锚、腾讯、阿里、美团、京东、小米、中芯国际，以及恒生科技 ETF（`513180`）周期配置与 T+0 波段指导（每日北京时间 `00:10` 结算更新）。
5. **AI 模型与额度监测（`models`）**：左侧导航内置查看面板，实时展示当前主用/备用 AI 模型通道、剩余配额（Apinex `/v1/subscription` 实时剩余 Token、TokenHarbor 7天免费额度百分比、NVIDIA 状态码监测）、各板块当前生效研判模型与生成时间，以及完整历史调用流水。

## 快速启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：`http://localhost:4080`
行情接口：`http://localhost:4080/api/markets`
模型通道与额度接口：`http://localhost:4080/api/llm/channels`
健康检查：`http://localhost:4080/api/health`

## 本地开发与检查

```bash
npm run typecheck
npm test
npm run build
npm start
```
