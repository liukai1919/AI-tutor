# Issues 修复复审：#16、#20、#23、#24、#25、#26

2026-09-25，审核者 Codex，会话 01a0d99c-33ee-7750-b090-2eadb7f19f80。固定审查提交 dev@2ed8738（前轮9c0a8d8）；本轮最终修复为本报告所在修复分支相对2ed8738的改动。用户授权“继续审核，有问题直接让opus5.5来修复”。修复交给真实 Claude Opus 5.5 CLI，结果中的 canonicalModel 均为 claude-opus-5-5；Codex 独立复验并由两个审核代理分别核对规范与需求。

结论：本次确认的问题已闭合，无剩余阻断。#16、#25现有dev提交通过复审，已Done并关闭；#20、#23、#24、#26修复通过复审，随修复PR提交，合并前保留Review。父任务#19仍在进行，不据此宣称后续阶段已完成。

## Standards

最终0项未解决发现。

- Tool trace是旁路：同步抛错、Promise拒绝、异常thenable及错误上报通道失败都不改变业务结果，不产生未处理拒绝，也不重复发trace。
- schema声明/required只认own property；数字不接受NaN/Infinity；anyOf不跳过同层约束。calculator严格检查函数参数数量，不再接受继承来的函数/常量名。
- golden不再通过序列化文本嗅探error/skipped；正常HTTP路径显式期待200，专门验证拒绝的路径期待403/400，仅quiz/session的503 needsEngine作为明确缺fixture。任何失败都拒绝更新整份快照；参数校验拒绝继承属性名，杜绝零用例假绿。
- 清库后上一题的缓存回包也先校验当前题库，符合文档契约；开局请求代次和固定语言避免迟到响应覆盖当前场次。

## Spec

最终0项未解决发现。

- #16：b0308e6修复部分rename失败后的重复记分，以及keep内容遭后续回滚清除。实测磁盘和内存回退一致，恢复后只记一次；keep内容后台补存成功，重启保持一致。
- #20：answer非200/判题错配不再跳过；--update遇失败不再污染黄金快照。补上非quiz接口503、lesson400、progress403和--only原型属性名回归。
- #23：answer强制携带qid；重复最后一题返回原结果，更早/无关题拒绝。首题回包在途退出或切语言，等待原请求结束后结算原场次；丢回包后重试安全；快速zh→en和乱序开局回包只保留最新语言；退出作废迟到开局；开局失败回到可操作界面。
- #24：qbank容器引用保持稳定，清库原地删除键。真实服务器清库后写入确定性新题，新场次立即可答且正确落盘；旧票及上一题缓存都不能从清除前的题库记分。
- #25：Action第二片抽取的参数、重试、持久化和HTTP错误映射未发现新增回归；导出契约不变。
- #26：工具参数、角色、超时、错误归一化和trace测试通过；新增qid契约已同步到questions.answerQuiz并验证透传。

## 独立验证

Codex执行以下套件，合计450项通过、0失败；黄金用例0跳过。后续修改涉及的套件已重新运行，未受影响的套件沿用同工作区本轮独立结果。

| 命令（node tools/） | 通过数 |
|---|---:|
| test_quiz_flow.mjs | 57 |
| test_actions.mjs | 78 |
| test_quiz.mjs | 27 |
| test_tools.mjs | 66 |
| smoke_flows.mjs | 60 |
| regress_server.mjs | 24 |
| regress_storage.mjs | 18 |
| test_mastery.mjs | 42 |
| test_models_json.mjs | 24 |
| golden_cases.mjs | 12 |
| test_golden_gate.mjs | 42 |

- 故障注入覆盖HTTP错误/判题错配/快照拒写，以及rename故障和keep回滚；均使用临时目录。
- 页面测试执行public/index.html中的真实闯关函数，通过VM最小DOM桩连接真实隔离HTTP服务器，控制answer/session回包延迟、失败及乱序；不是手动浏览器截图测试。
- 16个相关JavaScript文件及页面完整内联脚本语法检查通过，git diff --check通过。
- module.exports与2ed8738保持一致；server.js无孤立LF，保持CRLF。
- export_apple --dry通过。pregen --dry在隔离目录中注入一个只用于dry-run的可用provider通过，同时将runEngine设为抛错以禁止模型执行。普通YY_DEMO直接运行会因所有引擎被禁用而提前拒绝，这是已确认的前置条件。
- tools/golden/expected.json字节未变，SHA256：916425ac024abf480ff92c8b54e5d83a565c18d791fcb0379019aff370329687。
- 未操作真实家庭数据；产品测试均为YY_DATA_DIR临时目录、YY_DEMO=1或确定性依赖桩。只调用了用户授权的Opus代码修复模型。

## 发布与边界

- /api/quiz/answer现在必须带qid；仓库内调用方和文档均已同步。发布时应同步前后端并刷新旧页面，外部直连接口的客户端需要适配。
- 本轮验证不包含生产部署、人工浏览器截图或真实产品模型生成。
- #16仍不是崩溃事务日志，进程在多文件提交中途终止、回滚本身再失败的torn情形，当前不保证恢复。
- 客户端请求已被判定网络失败，却在finish之后才到达服务器时，迟到作答会因票已结算而拒绝；本轮保证已经被服务端接受的在途答案被结算，不能承诺尚未到达的答案必定保存。
- 被过时开局响应弃用的空票按现有TTL/数量上限清理，不会记学习成绩。

规范轴0项未解决，需求轴0项未解决；本次范围复审通过。
