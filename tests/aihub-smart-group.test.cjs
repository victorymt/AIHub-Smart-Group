const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../aihub-smart-group.user.js');
const userscriptSource = fs.readFileSync(path.join(__dirname, '..', 'aihub-smart-group.user.js'), 'utf8');

test('hides inactive availability settings despite the shared label display rule', () => {
  assert.match(userscriptSource, /\[data-availability-setting\]\[hidden\]\{display:none !important\}/);
});

test('stacks narrow-screen panel sections without unbounding the candidate list', () => {
  const mediaStart = userscriptSource.indexOf('@media (max-width:759px){');
  const styleEnd = userscriptSource.indexOf('const USAGE_STYLE', mediaStart);

  assert.notEqual(mediaStart, -1);
  assert.notEqual(styleEnd, -1);

  const mobileStyles = userscriptSource.slice(mediaStart, styleEnd);
  assert.match(mobileStyles, /#\$\{ROOT_ID\},#\$\{ROOT_ID\}\[data-side-open=true\]\{width:min\(360px,calc\(100vw - 32px\)\)\}/);
  assert.match(mobileStyles, /\.asg-body\{\s*display:flex;\s*flex-direction:column;\s*overflow:auto;/);
  assert.match(mobileStyles, /\.asg-main-column,\s*#\$\{ROOT_ID\} \.asg-side-column\{\s*flex:0 0 auto;\s*min-height:auto;\s*overflow:visible;/);
  assert.match(mobileStyles, /\.asg-side-head\{\s*position:static;\s*top:auto;\s*z-index:auto;/);
  assert.doesNotMatch(mobileStyles, /\.asg-body\{[^}]*grid-template-columns/);
  assert.doesNotMatch(mobileStyles, /\.asg-list\{max-height:none\}/);
});

test('keeps the desktop side panel collapsed until a header tab opens it', () => {
  assert.match(userscriptSource, /width:min\(480px,calc\(100vw - 32px\)\)/);
  assert.match(userscriptSource, /\[data-side-open=true\]\{width:min\(820px,calc\(100vw - 32px\)\)\}/);
  assert.match(userscriptSource, /<aside class="asg-side-column"[^>]* hidden>/);
  assert.match(userscriptSource, /data-panel-tab="settings">设置<\/button>/);
  assert.match(userscriptSource, /data-panel-tab="logs">日志<\/button>/);
  assert.match(userscriptSource, /data-action="close-side"/);
});

test('wires the native key group dropdown enhancer through the app router', () => {
  assert.match(userscriptSource, /class KeyGroupDropdownEnhancer/);
  assert.match(userscriptSource, /this\.keyGroups = new KeyGroupDropdownEnhancer\(\)/);
  assert.match(userscriptSource, /input\[placeholder="搜索分组\.\.\."\]/);
});

test('renders the full candidate ranking as a labeled ordered list', () => {
  assert.match(userscriptSource, /<span class="asg-ranking-title"[^>]*>推荐排序<\/span>/);
  assert.match(userscriptSource, /<ol class="asg-list" data-field="list"><\/ol>/);
  assert.doesNotMatch(userscriptSource, /this\.ranked\.slice\(0,\s*5\)/);
  assert.match(userscriptSource, /locate\.dataset\.action = 'locate-provider'/);
});

test('finds a provider row by its complete normalized group name', () => {
  const rows = [
    { querySelector: () => ({ textContent: 'A001-Plus' }) },
    { querySelector: () => ({ textContent: ' A008-BugTeam ' }) },
  ];
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, '.monitor-api-row:not(.monitor-api-head)');
      return rows;
    },
  };

  assert.equal(core.findProviderGroupRow(root, 'a008-bugteam'), rows[1]);
  assert.equal(core.findProviderGroupRow(root, 'A008'), null);
  assert.equal(core.findProviderGroupRow(null, 'A008-BugTeam'), null);
});

test('accepts only unexpired provider location targets', () => {
  const valid = JSON.stringify({ name: 'A008-BugTeam', expiresAt: 31_000 });
  assert.deepEqual(core.parsePendingProviderLocation(valid, 1_000), { name: 'A008-BugTeam', expiresAt: 31_000 });
  assert.equal(core.parsePendingProviderLocation(valid, 31_001), null);
  assert.equal(core.parsePendingProviderLocation('{invalid', 1_000), null);
  assert.equal(core.parsePendingProviderLocation(JSON.stringify({ name: '', expiresAt: 31_000 }), 1_000), null);
});

test('maps dropdown monitor tones to native group badge classes', () => {
  assert.equal(core.getGroupDropdownToneClass('available'), 'asg-key-group-badge-available');
  assert.equal(core.getGroupDropdownToneClass('warning'), 'asg-key-group-badge-warning');
  assert.equal(core.getGroupDropdownToneClass('unavailable'), 'asg-key-group-badge-unavailable');
  assert.equal(core.getGroupDropdownToneClass('disabled'), 'asg-key-group-badge-disabled');
  assert.equal(core.getGroupDropdownToneClass('error'), 'asg-key-group-badge-error');
  assert.equal(core.getGroupDropdownToneClass('unknown'), '');
  assert.equal(core.getGroupDropdownToneClass('unexpected'), '');
});

test('defaults the adjustable 10m availability threshold to 10 percent', () => {
  assert.equal(core.DEFAULT_CONFIG.minSuccess10m, 0.1);
  assert.equal(core.normalizeConfig({}).minSuccess10m, 0.1);
  assert.equal(core.normalizeConfig({ minSuccess6h: 0.95 }).minSuccess10m, 0.1);
});

test('normalizes thresholds and safety settings', () => {
  const config = core.normalizeConfig({
    minSuccess10m: '0.9',
    consecutiveChecks: 0,
    pollIntervalSeconds: 2,
    cooldownMinutes: -1,
    requireNoWarnings: false,
  });

  assert.equal(config.minSuccess10m, 0.9);
  assert.equal(config.consecutiveChecks, 1);
  assert.equal(config.pollIntervalSeconds, 10);
  assert.equal(config.cooldownMinutes, 0);
  assert.equal(config.requireNoWarnings, false);
  assert.equal(config.availabilityMode, 'percent');
  assert.equal(config.minSuccessPoints10m, 1);
  assert.equal(config.minConsecutiveSuccesses10m, 2);
});

test('normalizes selectable availability criteria', () => {
  const config = core.normalizeConfig({ availabilityMode: 'successes', minSuccessPoints10m: '2', minConsecutiveSuccesses10m: 0 });
  assert.equal(config.availabilityMode, 'successes');
  assert.equal(config.minSuccessPoints10m, 2);
  assert.equal(config.minConsecutiveSuccesses10m, 1);
  assert.equal(core.normalizeConfig({ availabilityMode: 'unknown' }).availabilityMode, 'percent');
});

test('normalizes the monitor freshness limit', () => {
  assert.equal(core.DEFAULT_CONFIG.maxMonitorAgeSeconds, 600);
  assert.equal(core.normalizeConfig({ maxMonitorAgeSeconds: '240' }).maxMonitorAgeSeconds, 600);
  assert.equal(core.normalizeConfig({ maxMonitorAgeSeconds: 1 }).maxMonitorAgeSeconds, 600);
  assert.equal(core.normalizeConfig({ maxMonitorAgeSeconds: 9999 }).maxMonitorAgeSeconds, 600);
});

test('uses the latest actual monitor sample as the freshness timestamp', () => {
  assert.equal(core.getLatestMonitorSampleAt({
    generatedAt: '2026-07-22T05:10:00Z',
    seriesByApiId: {
      one: [[Date.parse('2026-07-22T05:04:00Z'), 1], [Date.parse('2026-07-22T05:09:00Z'), 0]],
      two: [[Date.parse('2026-07-22T05:08:00Z'), 1]],
    },
  }), Date.parse('2026-07-22T05:09:00Z'));
  assert.equal(core.getLatestMonitorSampleAt({ generatedAt: '2026-07-22T05:10:00Z', seriesByApiId: {} }), null);
});

test('preserves decimal cooldowns and normalizes excluded group keywords', () => {
  const config = core.normalizeConfig({ cooldownMinutes: '0.1', excludedGroupKeywords: ' free | Test |free ' });

  assert.equal(config.cooldownMinutes, 0.1);
  assert.equal(config.excludedGroupKeywords, 'free|test');
});

test('filters and orders eligible monitor rows by recent availability then price', () => {
  const rows = [
    { planType: 'slow-cheap', group_id: 3, priceMultiplier: 0.03, available: true, successRates: { '10m': 1, '24h': 0.01 }, firstTokenLatencyMs: 3000, warningReasons: [] },
    { planType: 'best', group_id: 2, priceMultiplier: 0.05, available: true, successRates: { '10m': 1, '24h': 1 }, firstTokenLatencyMs: 800, warningReasons: [] },
    { planType: 'unavailable', group_id: 1, priceMultiplier: 0.001, available: false, successRates: { '10m': 1, '24h': 1 }, warningReasons: [] },
    { planType: 'warning', group_id: 4, priceMultiplier: 0.02, available: true, successRates: { '10m': 1, '24h': 1 }, warningReasons: [{ type: 'input_tokens_change' }] },
    { planType: 'low-10m', group_id: 5, priceMultiplier: 0.01, available: true, successRates: { '10m': 0, '24h': 1 }, warningReasons: [] },
  ];

  const ranked = core.rankCandidates(rows, core.DEFAULT_CONFIG);

  assert.deepEqual(ranked.map((row) => row.planType), ['slow-cheap', 'best']);
});

test('excludes groups whose names contain configured keywords', () => {
  const rows = [
    { planType: 'free-fast', group_id: 1, priceMultiplier: 0.01, available: true, successRates: { '10m': 1 }, firstTokenLatencyMs: 50, warningReasons: [] },
    { planType: 'Paid-Standard', group_id: 2, priceMultiplier: 0.02, available: true, successRates: { '10m': 1 }, firstTokenLatencyMs: 100, warningReasons: [] },
    { planType: 'premium', group_id: 3, priceMultiplier: 0.03, available: true, successRates: { '10m': 1 }, firstTokenLatencyMs: 150, warningReasons: [] },
  ];

  const ranked = core.rankCandidates(rows, { ...core.DEFAULT_CONFIG, excludedGroupKeywords: 'free|PREMIUM' });

  assert.deepEqual(ranked.map((row) => row.planType), ['Paid-Standard']);
});

test('previews excluded group keyword matches case-insensitively', () => {
  const info = core.getExcludedGroupInfo([
    { planType: 'Free-Fast' },
    { name: 'stable' },
    { planType: 'unstable-test' },
    { planType: 'paid' },
  ], ' free | unstable | free ');
  assert.deepEqual(info.keywords, ['free', 'unstable']);
  assert.deepEqual(info.matches.map((row) => row.name), ['Free-Fast', 'unstable-test']);
});

test('reports mutually exclusive candidate diagnostics', () => {
  const rows = [
    { planType: 'invalid', group_id: 'x', priceMultiplier: 0.01 },
    { planType: 'disabled', group_id: 1, priceMultiplier: 0.01, enabled: false, available: true, successRates: { '10m': 1 } },
    { planType: 'unavailable', group_id: 2, priceMultiplier: 0.01, available: false, successRates: { '10m': 1 } },
    { planType: 'low', group_id: 3, priceMultiplier: 0.01, available: true, successRates: { '10m': 0.01 } },
    { planType: 'warning', group_id: 4, priceMultiplier: 0.01, available: true, successRates: { '10m': 1 }, warningReasons: ['warning'] },
    { planType: 'free-fast', group_id: 5, priceMultiplier: 0.01, available: true, successRates: { '10m': 1 }, warningReasons: [] },
    { planType: 'eligible', group_id: 6, priceMultiplier: 0.02, available: true, successRates: { '10m': 1 }, warningReasons: [] },
  ];
  const result = core.analyzeCandidates(rows, { ...core.DEFAULT_CONFIG, excludedGroupKeywords: 'free' });
  assert.deepEqual(result.counts, { total: 7, invalid: 1, unavailable: 2, lowSuccess: 1, warnings: 1, keywords: 1, eligible: 1 });
  assert.deepEqual(result.candidates.map((row) => row.name), ['eligible']);
});

test('formats monitor freshness and treats invalid timestamps as stale', () => {
  const now = Date.parse('2026-07-22T05:10:00Z');
  assert.deepEqual(core.getMonitorFreshness(new Date(now - 42_000).toISOString(), now, 180), {
    generatedAt: now - 42_000, ageMs: 42_000, stale: false, label: '42 秒前',
  });
  assert.equal(core.getMonitorFreshness(new Date(now - 181_000).toISOString(), now, 180).stale, true);
  assert.equal(core.getMonitorFreshness('bad timestamp', now, 180).label, '时间未知');
  assert.equal(core.getMonitorFreshness('bad timestamp', now, 180).stale, true);
});

test('reports fractional cooldown remaining time', () => {
  assert.deepEqual(core.getCooldownInfo(1_000, 0.1, 4_000), { remainingMs: 3_000, active: true, label: '剩余 3 秒' });
  assert.equal(core.getCooldownInfo(1_000, 0.1, 7_000).active, false);
});

test('uses reliability and latency as deterministic tie breakers', () => {
  const rows = [
    { planType: 'slow', group_id: 1, priceMultiplier: 0.05, available: true, successRates: { '10m': 0.98, '24h': 0.99 }, firstTokenLatencyMs: 2000, warningReasons: [] },
    { planType: 'fast', group_id: 2, priceMultiplier: 0.05, available: true, successRates: { '10m': 0.98, '24h': 0.99 }, firstTokenLatencyMs: 1000, warningReasons: [] },
  ];

  assert.equal(core.rankCandidates(rows, core.DEFAULT_CONFIG)[0].planType, 'fast');
});

test('computes availability from valid monitor samples in the latest 10 minutes', () => {
  const now = Date.parse('2026-07-22T05:10:00Z');
  const rows = [
    { id: 'api-1', successRates: { '24h': 0.5 } },
    { id: 'api-2', successRates: { '24h': 1 } },
  ];
  const series = {
    generatedAt: new Date(now).toISOString(),
    seriesByApiId: {
      'api-1': [
        [now - 11 * 60_000, 0],
        [now - 9 * 60_000, 1],
        [now - 4 * 60_000, 0],
      ],
      'api-2': [[now - 11 * 60_000, 1]],
    },
  };

  const enriched = core.attachRecentAvailability(rows, series, 10 * 60_000);
  assert.equal(enriched[0].successRates['10m'], 0.5);
  assert.equal(enriched[0].recentSampleCount, 2);
  assert.equal(enriched[0].recentSuccessCount, 1);
  assert.equal(enriched[0].recentConsecutiveSuccessCount, 0);
  assert.equal(Number.isNaN(enriched[1].successRates['10m']), true);
  assert.equal(enriched[1].recentSampleCount, 0);
});

test('builds a six-hour availability timeline for the recommended group', () => {
  const generatedAt = Date.parse('2026-07-31T06:00:00Z');
  const model = core.buildAvailabilityChartModel({
    generatedAt: '2026-07-31T06:00:00Z',
    seriesByApiId: {
      48: [
        [Date.parse('2026-07-30T23:59:00Z'), 1],
        [Date.parse('2026-07-31T00:00:00Z'), 0],
        [Date.parse('2026-07-31T03:00:00Z'), 1],
        [Date.parse('2026-07-31T06:00:00Z'), 1],
        [Date.parse('2026-07-31T06:01:00Z'), 0],
        [generatedAt - 1_000, null],
      ],
    },
  }, 48);

  assert.equal(model.startAt, Date.parse('2026-07-31T00:00:00Z'));
  assert.equal(model.endAt, generatedAt);
  assert.equal(model.total, 3);
  assert.equal(model.successCount, 2);
  assert.equal(model.successRate, 2 / 3);
  assert.deepEqual(model.points.map((point) => point.available), [false, true, true]);
  assert.equal(model.points[0].x, 4);
  assert.equal(model.points[2].x, 316);
  assert.match(model.path, /^M4\.0,31\.0 H160\.0 V9\.0 H316\.0$/);
});

test('returns an empty availability timeline when the group has no valid samples', () => {
  const model = core.buildAvailabilityChartModel({ generatedAt: '2026-07-31T06:00:00Z', seriesByApiId: { 48: [[1, 'unknown']] } }, 48);

  assert.equal(model.total, 0);
  assert.equal(model.successCount, 0);
  assert.equal(model.path, '');
  assert.equal(Number.isNaN(model.successRate), true);
});

test('selects AIHub candidates for price, balance, and speed modes', () => {
  const rows = [
    { planType: 'cheap', group_id: 1, priceMultiplier: 0.04, available: true, successRates: { '10m': 1, '24h': 1 }, firstTokenLatencyMs: 500, warningReasons: [] },
    { planType: 'balanced', group_id: 2, priceMultiplier: 0.045, available: true, successRates: { '10m': 1, '24h': 1 }, firstTokenLatencyMs: 100, warningReasons: [] },
    { planType: 'fast', group_id: 3, priceMultiplier: 0.08, available: true, successRates: { '10m': 1, '24h': 1 }, firstTokenLatencyMs: 50, warningReasons: [] },
  ];

  assert.equal(core.rankCandidates(rows, { ...core.DEFAULT_CONFIG, mode: 'price' })[0].planType, 'cheap');
  assert.equal(core.rankCandidates(rows, { ...core.DEFAULT_CONFIG, mode: 'balance', balanceMaxPrice: 0.05 })[0].planType, 'balanced');
  assert.equal(core.rankCandidates(rows, { ...core.DEFAULT_CONFIG, mode: 'speed' })[0].planType, 'fast');
});

test('describes the active candidate ranking rule', () => {
  assert.equal(core.getCandidateRankingRule({ mode: 'price' }), '倍率从低到高');
  assert.equal(core.getCandidateRankingRule({ mode: 'speed' }), '首 Token 从快到慢');
  assert.equal(core.getCandidateRankingRule({ mode: 'balance', balanceMaxPrice: 0.1 }), '倍率 ≤ ×0.1 · 首 Token 从快到慢');
});

test('normalizes adjustable AIHub mode settings', () => {
  const config = core.normalizeConfig({ mode: 'balance', balanceMaxPrice: '0.1', balancePricePercent: 500 });
  assert.equal(config.mode, 'balance');
  assert.equal(config.balanceMaxPrice, 0.1);
  assert.equal(Object.hasOwn(config, 'balancePricePercent'), false);
  assert.equal(core.normalizeConfig({ mode: 'unknown', balanceMaxPrice: 9999 }).mode, 'price');
  assert.equal(core.normalizeConfig({ mode: 'unknown', balanceMaxPrice: 9999 }).balanceMaxPrice, 1000);
});

test('normalizes the side panel tab to settings or logs', () => {
  assert.equal(core.normalizePanelTab('settings'), 'settings');
  assert.equal(core.normalizePanelTab('logs'), 'logs');
  assert.equal(core.normalizePanelTab('unknown'), 'settings');
  assert.equal(core.normalizePanelTab(), 'settings');
});

test('toggles the requested side panel tab without closing when switching tabs', () => {
  assert.deepEqual(core.toggleSidePanelState(false, 'settings', 'settings'), { open: true, tab: 'settings' });
  assert.deepEqual(core.toggleSidePanelState(true, 'settings', 'settings'), { open: false, tab: 'settings' });
  assert.deepEqual(core.toggleSidePanelState(true, 'settings', 'logs'), { open: true, tab: 'logs' });
  assert.deepEqual(core.toggleSidePanelState(false, 'logs', 'unknown'), { open: true, tab: 'settings' });
});

test('ignores groups above the absolute balance price limit', () => {
  const rows = [
    { planType: 'cheap', group_id: 1, priceMultiplier: 0.04, available: true, successRates: { '10m': 1 }, firstTokenLatencyMs: 500, warningReasons: [] },
    { planType: 'balanced', group_id: 2, priceMultiplier: 0.045, available: true, successRates: { '10m': 1 }, firstTokenLatencyMs: 100, warningReasons: [] },
    { planType: 'too-expensive', group_id: 3, priceMultiplier: 0.08, available: true, successRates: { '10m': 1 }, firstTokenLatencyMs: 10, warningReasons: [] },
  ];

  assert.deepEqual(core.rankCandidates(rows, { ...core.DEFAULT_CONFIG, mode: 'balance', balanceMaxPrice: 0.05 }).map((row) => row.planType), ['balanced', 'cheap']);
  assert.deepEqual(core.rankCandidates(rows, { ...core.DEFAULT_CONFIG, mode: 'balance', balanceMaxPrice: 0.04 }).map((row) => row.planType), ['cheap']);
  assert.deepEqual(core.rankCandidates(rows, { ...core.DEFAULT_CONFIG, mode: 'balance', balanceMaxPrice: 0.03 }), []);
});

test('keeps bounded, sanitized runtime logs', () => {
  const logs = core.appendLogEntries([], {
    at: 1,
    scope: 'aihub',
    level: 'error',
    message: '请求失败 sk-secret-value',
  }, 2);
  const next = core.appendLogEntries(logs, { at: 2, scope: 'aihub', level: 'info', message: '已切换' }, 2);
  const bounded = core.appendLogEntries(next, { at: 3, scope: 'aihub', level: 'info', message: '第三条' }, 2);

  assert.equal(bounded.length, 2);
  assert.equal(bounded[0].message, '第三条');
  assert.equal(bounded[1].message.includes('sk-secret-value'), false);
  assert.match(core.formatLogLine(bounded[0]), /第三条/);
});

test('redacts bearer credentials and auth token values from logs', () => {
  const logs = core.appendLogEntries([], {
    message: 'Authorization: Bearer header.payload.signature auth_token: secret-token-value',
  });

  assert.equal(logs[0].message.includes('header.payload.signature'), false);
  assert.equal(logs[0].message.includes('secret-token-value'), false);
  assert.match(logs[0].message, /Bearer \[已隐藏\]/);
});

test('requires the same winner for the configured number of checks', () => {
  let state = core.createStabilityState();
  state = core.advanceStability(state, 14, 2);
  assert.equal(state.stable, false);
  state = core.advanceStability(state, 14, 2);
  assert.equal(state.stable, true);
  state = core.advanceStability(state, 20, 2);
  assert.equal(state.groupId, 20);
  assert.equal(state.count, 1);
  assert.equal(state.stable, false);
});

test('blocks auto switching during cooldown and when already on target', () => {
  const config = { ...core.DEFAULT_CONFIG, cooldownMinutes: 10 };
  assert.equal(core.canAutoSwitch({ now: 1_000, lastSwitchAt: 500, currentGroupId: 1, targetGroupId: 2, stable: true, config }), false);
  assert.equal(core.canAutoSwitch({ now: 601_000, lastSwitchAt: 500, currentGroupId: 2, targetGroupId: 2, stable: true, config }), false);
  assert.equal(core.canAutoSwitch({ now: 601_000, lastSwitchAt: 500, currentGroupId: 1, targetGroupId: 2, stable: true, config }), true);
});

test('applies fractional cooldowns without rounding to zero', () => {
  const config = { ...core.DEFAULT_CONFIG, cooldownMinutes: 0.1 };
  assert.equal(core.canAutoSwitch({ now: 6_499, lastSwitchAt: 500, currentGroupId: 1, targetGroupId: 2, stable: true, config }), false);
  assert.equal(core.canAutoSwitch({ now: 6_500, lastSwitchAt: 500, currentGroupId: 1, targetGroupId: 2, stable: true, config }), true);
});

test('explains why automatic switching is skipped', () => {
  const config = { ...core.DEFAULT_CONFIG, cooldownMinutes: 10 };
  const ready = {
    now: 601_000,
    lastSwitchAt: 500,
    currentGroupId: 1,
    targetGroupId: 2,
    stable: true,
    config,
  };

  assert.equal(core.getAutoSwitchBlockReason(ready), '');
  assert.equal(core.getAutoSwitchBlockReason({ ...ready, stable: false }), '推荐尚未稳定');
  assert.equal(core.getAutoSwitchBlockReason({ ...ready, currentGroupId: 2 }), '当前密钥已经在推荐分组');
  assert.equal(core.getAutoSwitchBlockReason({ ...ready, now: 1_000 }), '切换冷却中（剩余 10 分钟）');
  assert.equal(core.getAutoSwitchBlockReason({ ...ready, monitorStale: true, monitorFreshnessText: '4 分钟前' }), '监控数据已过期（4 分钟前）');
});

test('blocks manual switching when monitor data is stale', () => {
  const ready = { loading: false, error: '', authError: '', winner: { groupId: 2 }, key: { groupId: 1 }, stability: { stable: true, count: 2 }, requiredChecks: 2 };
  assert.equal(core.getSwitchBlockReason({ ...ready, monitorStale: true, monitorFreshnessText: '4 分钟前' }), '监控数据已过期（4 分钟前）');
});

test('projects key metadata without exposing complete API key values', () => {
  const projected = core.projectKeys([{ id: 7, name: 'main', key: 'sk-secret-value', group_id: 14, group: { name: 'A006-Plus' }, status: 'active' }]);
  assert.deepEqual(projected, [{ id: 7, name: 'main', groupId: 14, groupName: 'A006-Plus', status: 'active' }]);
  assert.equal(JSON.stringify(projected).includes('sk-secret-value'), false);
});

test('adds the current page auth token only to transient request headers', () => {
  assert.deepEqual(core.buildAuthHeaders('token-value'), { Authorization: 'Bearer token-value' });
  assert.deepEqual(core.buildAuthHeaders(''), {});
});

test('marks authenticated user API requests like the AIHub client', () => {
  assert.deepEqual(core.buildApiHeaders('/keys?page=1', 'token-value'), {
    Authorization: 'Bearer token-value',
    'X-User-UI-Request': '1',
  });
  assert.deepEqual(core.buildApiHeaders('/public/monitor/summary', ''), {});
  assert.deepEqual(core.buildApiHeaders('/auth/me?timezone=Asia%2FShanghai', 'token-value'), {
    Authorization: 'Bearer token-value',
    'X-User-UI-Request': '1',
  });
});

test('filters by successful monitor points or trailing consecutive points', () => {
  const rows = [
    { planType: 'two-successes', group_id: 1, priceMultiplier: 0.01, available: true, successRates: { '10m': 0.5 }, recentSampleCount: 4, recentSuccessCount: 2, recentConsecutiveSuccessCount: 1, warningReasons: [] },
    { planType: 'two-trailing', group_id: 2, priceMultiplier: 0.02, available: true, successRates: { '10m': 0.5 }, recentSampleCount: 4, recentSuccessCount: 2, recentConsecutiveSuccessCount: 2, warningReasons: [] },
  ];
  assert.deepEqual(core.rankCandidates(rows, { ...core.DEFAULT_CONFIG, availabilityMode: 'successes', minSuccessPoints10m: 2 }).map((row) => row.planType), ['two-successes', 'two-trailing']);
  assert.deepEqual(core.rankCandidates(rows, { ...core.DEFAULT_CONFIG, availabilityMode: 'consecutive', minConsecutiveSuccesses10m: 2 }).map((row) => row.planType), ['two-trailing']);
});

test('extracts and formats the current balance without exposing unrelated account data', () => {
  assert.equal(core.getBalanceAmount({ data: { balance: '2.42650019', email: 'private@example.com' } }), 2.42650019);
  assert.equal(core.getBalanceAmount({ data: { balance: -1 } }), null);
  assert.equal(core.getBalanceAmount({ data: { balance: 'unknown' } }), null);
  assert.equal(core.formatBalance(2.42650019), '2.4265');
  assert.equal(core.formatBalance(Number.NaN), '暂无数据');
});

test('merges paginated API key responses without duplicates', () => {
  const merged = core.mergeKeyPages([
    { items: [{ id: 1 }, { id: 2 }], pages: 2 },
    { items: [{ id: 2 }, { id: 3 }], pages: 2 },
  ]);
  assert.deepEqual(merged.map((key) => key.id), [1, 2, 3]);
});

test('refreshes keys when empty, forced, or older than five minutes', () => {
  const intervalMs = 5 * 60 * 1000;
  assert.equal(core.shouldRefreshKeys({ now: 1_000, lastFetchedAt: 0, keyCount: 0, intervalMs }), true);
  assert.equal(core.shouldRefreshKeys({ now: intervalMs + 1, lastFetchedAt: 1, keyCount: 2, intervalMs }), true);
  assert.equal(core.shouldRefreshKeys({ now: 10, lastFetchedAt: 1, keyCount: 2, intervalMs, force: true }), true);
  assert.equal(core.shouldRefreshKeys({ now: 10, lastFetchedAt: 1, keyCount: 2, intervalMs }), false);
});

test('logs periodic detection state only when it changes unless forced', () => {
  assert.equal(core.shouldLogTransition(null, 'price:14', false), true);
  assert.equal(core.shouldLogTransition('price:14', 'price:14', false), false);
  assert.equal(core.shouldLogTransition('price:14', 'price:14', true), true);
  assert.equal(core.shouldLogTransition('price:14', 'price:20', false), true);
});

test('blocks switching while loading or when key authentication failed', () => {
  const ready = {
    loading: false,
    authError: '',
    winner: { groupId: 14 },
    key: { groupId: 20 },
    stability: { stable: true, count: 2 },
    requiredChecks: 2,
  };

  assert.equal(core.getSwitchBlockReason(ready), '');
  assert.equal(core.getSwitchBlockReason({ ...ready, loading: true }), '正在检测');
  assert.equal(core.getSwitchBlockReason({ ...ready, loading: true, allowWhileLoading: true }), '');
  assert.equal(core.getSwitchBlockReason({ ...ready, error: '监控请求失败' }), '监控请求失败');
  assert.equal(core.getSwitchBlockReason({ ...ready, authError: '登录已失效' }), '登录已失效');
  assert.equal(core.getSwitchBlockReason({ ...ready, stability: { stable: false, count: 1 } }), '推荐尚未稳定（1/2 次）');
  assert.equal(core.getSwitchBlockReason({ ...ready, key: { groupId: 14 } }), '当前密钥已经在推荐分组');
});

test('builds current multiplier lookup by normalized group name', () => {
  const lookup = core.buildGroupMultiplierMap([
    { planType: ' A004-K12/BugTeam ', priceMultiplier: '0.04' },
    { name: 'A013-K12', priceMultiplier: 0.01 },
    { planType: 'invalid', priceMultiplier: 'unknown' },
  ]);

  assert.equal(lookup.get('a004-k12/bugteam'), 0.04);
  assert.equal(lookup.get('a013-k12'), 0.01);
  assert.equal(lookup.has('invalid'), false);
});

test('maps current group metrics by group id without filtering unavailable rows', () => {
  const metrics = core.buildGroupMetricMap([
    { group_id: 14, planType: 'same-name', priceMultiplier: '0.04', firstTokenLatencyMs: '1141', available: false },
    { group_id: 20, planType: 'same-name', priceMultiplier: 0.08, firstTokenLatencyMs: 320, available: true },
    { group_id: 21, priceMultiplier: null, firstTokenLatencyMs: null },
    { group_id: 'invalid', priceMultiplier: 0.01, firstTokenLatencyMs: 10 },
  ]);

  assert.deepEqual(metrics.get(14), { multiplier: 0.04, latencyMs: 1141 });
  assert.deepEqual(metrics.get(20), { multiplier: 0.08, latencyMs: 320 });
  assert.deepEqual(metrics.get(21), { multiplier: null, latencyMs: null });
  assert.equal(metrics.has('same-name'), false);
  assert.equal(metrics.size, 3);
});

test('indexes dropdown monitor rows by normalized name and multiplier', () => {
  const rows = [
    { planType: ' Same Group ', priceMultiplier: 0.04, available: true, firstTokenLatencyMs: 800 },
    { planType: 'same group', priceMultiplier: 0.08, available: false, firstTokenLatencyMs: 1600 },
    { planType: 'Unique', priceMultiplier: 0.1, available: true, firstTokenLatencyMs: 500 },
  ];
  const index = core.buildGroupDropdownMonitorIndex(rows);

  assert.equal(core.findGroupDropdownMonitor(index, 'Same Group', 0.08), rows[1]);
  assert.equal(core.findGroupDropdownMonitor(index, 'Unique', null), rows[2]);
  assert.equal(core.findGroupDropdownMonitor(index, 'same group', null), null);
});

test('uses the newest monitor row when a composite key is duplicated', () => {
  const oldRow = { planType: 'Duplicate', priceMultiplier: 0.1, checkedAt: '2026-07-23T00:00:00Z', available: false };
  const newRow = { planType: 'Duplicate', priceMultiplier: 0.1, checkedAt: '2026-07-23T01:00:00Z', available: true };
  const index = core.buildGroupDropdownMonitorIndex([oldRow, newRow, { planType: 'No Rate', priceMultiplier: null }]);

  assert.equal(core.findGroupDropdownMonitor(index, 'Duplicate', 0.1), newRow);
  assert.equal(index.byComposite.has('no rate|0.000000'), false);
});

test('parses the multiplier displayed by native group options', () => {
  assert.equal(core.parseGroupOptionMultiplier('0.06x 倍率'), 0.06);
  assert.equal(core.parseGroupOptionMultiplier('×0.012345'), 0.012345);
  assert.equal(core.parseGroupOptionMultiplier('暂无倍率'), null);
});

test('formats dropdown status and first token metrics', () => {
  assert.deepEqual(core.formatGroupDropdownMonitor({ available: true, enabled: true, warningReasons: [], firstTokenLatencyMs: 1227 }), {
    statusText: '可用',
    statusTone: 'available',
    latencyText: '首 Token 1227 ms',
    latencyValueText: '1227 ms',
  });
  assert.deepEqual(core.formatGroupDropdownMonitor({ available: true, enabled: true, warningReasons: ['warning'], firstTokenLatencyMs: 9.6 }), {
    statusText: '可用 · 有警告',
    statusTone: 'warning',
    latencyText: '首 Token 10 ms',
    latencyValueText: '10 ms',
  });
  assert.deepEqual(core.formatGroupDropdownMonitor({ available: false, enabled: true, firstTokenLatencyMs: null }), {
    statusText: '不可用',
    statusTone: 'unavailable',
    latencyText: '首 Token 暂无数据',
    latencyValueText: '',
  });
  assert.deepEqual(core.formatGroupDropdownMonitor({ available: true, enabled: false, firstTokenLatencyMs: 100 }), {
    statusText: '已停用',
    statusTone: 'disabled',
    latencyText: '首 Token 100 ms',
    latencyValueText: '100 ms',
  });
  assert.deepEqual(core.formatGroupDropdownMonitor(null), {
    statusText: '暂无监控',
    statusTone: 'unknown',
    latencyText: '首 Token 暂无数据',
    latencyValueText: '',
  });
});

test('formats target key options with current group metrics and safe placeholders', () => {
  const key = {
    id: 7,
    name: 'main',
    groupId: 14,
    groupName: 'A001-K12',
    key: 'sk-must-not-appear',
  };

  assert.equal(core.formatKeyOptionLabel(key, { multiplier: 0.05, latencyMs: 1141 }), 'main · A001-K12 · ×0.05 · 首 Token 1141 ms');
  assert.equal(core.formatKeyOptionLabel(key, null), 'main · A001-K12 · 倍率暂无数据 · 首 Token 暂无数据');
  const invalid = core.formatKeyOptionLabel(key, { multiplier: Number.NaN, latencyMs: -1 });
  assert.equal(invalid, 'main · A001-K12 · 倍率暂无数据 · 首 Token 暂无数据');
  assert.equal(invalid.includes('sk-must-not-appear'), false);
});

test('formats usage multipliers without unnecessary zeroes', () => {
  assert.equal(core.formatMultiplier(0.04), '×0.04');
  assert.equal(core.formatMultiplier(1), '×1');
  assert.equal(core.formatMultiplier(0.0123456), '×0.012346');
  assert.equal(core.formatMultiplier(Number.NaN), '');
});

test('enables the panel on every AIHub page only while logged in', () => {
  assert.deepEqual(core.getPageFeatures('/providers', true), { panel: true, usage: false, keyGroups: false });
  assert.deepEqual(core.getPageFeatures('/keys?page=1', true), { panel: true, usage: false, keyGroups: true });
  assert.deepEqual(core.getPageFeatures('/usage', true), { panel: true, usage: true, keyGroups: false });
  assert.deepEqual(core.getPageFeatures('/dashboard', true), { panel: true, usage: false, keyGroups: false });
  assert.deepEqual(core.getPageFeatures('/usage', false), { panel: false, usage: false, keyGroups: false });
});
