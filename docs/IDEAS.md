# 待定 / 暂存功能

这里记录写好但暂未合并进主干的功能，方便将来启用。对应的完整 diff 存在 `docs/patches/`。

## 历史消息懒加载（滑到顶往前翻）

**状态**：已实现完整 diff，未合并、未充分测试。补丁：`docs/patches/history-lazyload.patch`。

**要解决的问题**：首屏只铺最近 `HISTORY_TAIL`(12) 条历史（首屏轻、省流量）。想看更早的对话，
目前只能点右上角"刷新"整段重拉。懒加载让用户在手机上**滑到列表顶部就自动加载上一页更早的历史**。

**做法**：

- **server.ts**
  - 首拉时把整段解析结果缓存进 `HISTORY_CACHE`，记 `firstShownIdx = len - HISTORY_TAIL`
    （已铺给前端的最早一条在缓存里的下标）。
  - 新增 `olderHistory(before)`：返回 `[max(0, before-HISTORY_PAGE), before)` 这一页（时间正序），
    连同 `hasMore`（前面还有没有）和新游标 `before`。
  - 新增路由 `GET /history?before=<idx>` → `{ events, hasMore, before }`。`before` 省略时用 `firstShownIdx`。
  - 新增常量 `HISTORY_PAGE = 20`（每页条数）。

- **public/index.html**
  - 游标三件套：`histBefore`(当前已显示最早那条的下标) / `histHasMore` / `histLoading`。
  - `buildOlderBubble(msg)`：把一条历史事件（user / ai / tool_use）渲染成脱离文档的气泡，供 prepend。
  - `loadOlder()`：拉 `/history`，把这一页逆着 `insertBefore` 到列表顶部；**prepend 前后按
    `scrollHeight` 差值补回 `scrollTop`，避免滚动位置跳动**。
  - `log` 的 `scroll` 监听：`scrollTop < 60` 就 `loadOlder()`。
  - `history_start` 时重置游标（`histBefore=null; histHasMore=(msg.truncated!==false)`）；
    右上角"刷新"也一并重置游标。

**启用方式**：

```bash
git apply docs/patches/history-lazyload.patch
# 然后同步到运行目录、重启 claude-chat、手机刷新，滑到顶测试往前翻是否顺滑、不跳动。
```

**待验证点**：滑到顶加载时滚动位置是否稳（不同机型 momentum scroll 下的 scrollTop 补偿）、
一次滑很快连续触发多页时的去重、到顶后 `hasMore=false` 不再空拉。
