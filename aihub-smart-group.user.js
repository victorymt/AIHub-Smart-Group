// ==UserScript==
// @name         AIHub Smart Group
// @name:zh-CN   AIHub 智能分组
// @namespace    local.aihub.smart-group
// @version      0.7.0
// @description  Recommend reliable low-cost groups on AIHub.
// @description:zh-CN 按价格、速度和可用性推荐 AIHub 分组
// @license      MIT
// @homepageURL   https://github.com/jwwsjlm/AIHub-Smart-Group
// @supportURL    https://github.com/jwwsjlm/AIHub-Smart-Group/issues
// @match        https://aihub.top/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

/* global module */

(function (factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (typeof window !== 'undefined' && typeof document !== 'undefined') exported.start();
})(function () {
  'use strict';

  const ROOT_ID = 'aihub-smart-group-panel';
  const TOGGLE_ID = 'aihub-smart-group-toggle';
  const SCRIPT_VERSION = '0.7.0';
  const STORAGE_PREFIX = 'aihub-smart-group:';
  const PENDING_PROVIDER_GROUP_KEY = `${STORAGE_PREFIX}pending-provider-group`;
  const AVAILABILITY_CHART_RANGE_MS = 6 * 60 * 60 * 1000;
  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const GROUP_MODE_LABELS = Object.freeze({
    price: '价格',
    balance: '平衡',
    speed: '速度',
    smart: '智能',
  });
  const DEFAULT_CONFIG = Object.freeze({
    minSuccess10m: 0.10,
    requireNoWarnings: true,
    consecutiveChecks: 2,
    pollIntervalSeconds: 30,
    cooldownMinutes: 10,
    autoSwitch: false,
    mode: 'price',
    balanceMaxPrice: 0.1,
    excludedGroupKeywords: '',
    maxMonitorAgeSeconds: 600,
    availabilityMode: 'percent',
    minSuccessPoints10m: 1,
    minConsecutiveSuccesses10m: 2,
    targetModel: 'any',
    modelDetectionPolicy: 'observe',
    minCacheHitRate: 0,
  });

  function numberOr(value, fallback) {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeExcludedGroupKeywords(value) {
    const source = Array.isArray(value) ? value.join('|') : String(value ?? '');
    const seen = new Set();
    return source.split('|')
      .map((keyword) => keyword.trim().toLocaleLowerCase())
      .filter((keyword) => {
        if (!keyword || seen.has(keyword)) return false;
        seen.add(keyword);
        return true;
      })
      .join('|');
  }

  function normalizeConfig(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    return {
      minSuccess10m: clamp(numberOr(source.minSuccess10m, DEFAULT_CONFIG.minSuccess10m), 0, 1),
      requireNoWarnings: source.requireNoWarnings !== false,
      consecutiveChecks: Math.round(clamp(numberOr(source.consecutiveChecks, DEFAULT_CONFIG.consecutiveChecks), 1, 5)),
      pollIntervalSeconds: Math.round(clamp(numberOr(source.pollIntervalSeconds, DEFAULT_CONFIG.pollIntervalSeconds), 10, 3600)),
      cooldownMinutes: clamp(numberOr(source.cooldownMinutes, DEFAULT_CONFIG.cooldownMinutes), 0, 1440),
      autoSwitch: source.autoSwitch === true,
      mode: normalizeGroupMode(source.mode),
      balanceMaxPrice: clamp(numberOr(source.balanceMaxPrice, DEFAULT_CONFIG.balanceMaxPrice), 0, 1000),
      excludedGroupKeywords: normalizeExcludedGroupKeywords(source.excludedGroupKeywords),
      maxMonitorAgeSeconds: DEFAULT_CONFIG.maxMonitorAgeSeconds,
      availabilityMode: normalizeAvailabilityMode(source.availabilityMode),
      minSuccessPoints10m: Math.round(clamp(numberOr(source.minSuccessPoints10m, DEFAULT_CONFIG.minSuccessPoints10m), 1, 60)),
      minConsecutiveSuccesses10m: Math.round(clamp(numberOr(source.minConsecutiveSuccesses10m, DEFAULT_CONFIG.minConsecutiveSuccesses10m), 1, 60)),
      targetModel: normalizeTargetModel(source.targetModel),
      modelDetectionPolicy: normalizeModelDetectionPolicy(source.modelDetectionPolicy),
      minCacheHitRate: clamp(numberOr(source.minCacheHitRate, DEFAULT_CONFIG.minCacheHitRate), 0, 1),
    };
  }

  function normalizeGroupMode(value) {
    return Object.prototype.hasOwnProperty.call(GROUP_MODE_LABELS, value) ? value : 'price';
  }

  function normalizeTargetModel(value) {
    return value === 'sol' || value === 'terra' || value === 'luna' ? value : 'any';
  }

  function normalizeModelDetectionPolicy(value) {
    return value === 'standard' || value === 'strict' ? value : 'observe';
  }

  function normalizePanelTab(value) {
    return value === 'logs' ? 'logs' : 'settings';
  }

  function toggleSidePanelState(open, currentTab, requestedTab) {
    const tab = normalizePanelTab(requestedTab);
    return {
      open: !(open === true && normalizePanelTab(currentTab) === tab),
      tab,
    };
  }

  function normalizeAvailabilityMode(value) {
    return value === 'successes' || value === 'consecutive' ? value : 'percent';
  }

  function getBalanceAmount(payload) {
    const value = Number(payload?.data?.balance ?? payload?.balance);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function formatBalance(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0
      ? amount.toFixed(6).replace(/\.?0+$/, '')
      : '暂无数据';
  }

  function normalizeCacheHitRate(value) {
    if (value == null || value === '') return null;
    const text = String(value).trim();
    const match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(%)?$/);
    if (!match) return null;
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number < 0) return null;
    return clamp((match[2] || number > 1) ? number / 100 : number, 0, 1);
  }

  function formatCacheHitRate(value) {
    const rate = normalizeCacheHitRate(value);
    return rate === null ? '缓存暂无数据' : `缓存 ${formatPercent(rate)}`;
  }

  function getModelHealthInfo(value) {
    const source = value && typeof value === 'object' ? value : null;
    if (!source) return { label: '模型状态未知', tone: 'muted' };
    const labels = { sol: 'Sol', terra: 'Terra', luna: 'Luna' };
    const groups = { healthy: [], failed: [], insufficient: [] };
    for (const key of Object.keys(labels)) {
      const status = String(source[key] || 'insufficient').toLocaleLowerCase();
      (groups[status] || groups.insufficient).push(labels[key]);
    }
    const parts = [];
    if (groups.healthy.length) parts.push(`${groups.healthy.join('/')} 健康`);
    if (groups.failed.length) parts.push(`${groups.failed.join('/')} 异常`);
    if (groups.insufficient.length) parts.push(`${groups.insufficient.join('/')} 未知`);
    const tone = groups.healthy.length === 3 ? 'good' : groups.healthy.length ? 'warning' : groups.failed.length ? 'bad' : 'muted';
    return { label: parts.join(' · '), tone };
  }

  function getModelDetectionInfo(value) {
    if (value?.applicable === false) return { status: 'not_applicable', label: '模型检测不适用', tone: 'muted' };
    const status = String(value?.status || 'not_tested').toLocaleLowerCase();
    const labels = {
      passed: '检测通过',
      juice_passed: 'Juice 检测通过',
      suspected: '模型存疑',
      insufficient_evidence: '检测证据不足',
      detection_failed: '模型检测失败',
      not_tested: '未进行模型检测',
      not_configured: '模型检测未配置',
      queued: '模型检测排队中',
      creating: '模型检测排队中',
      running: '模型检测中',
    };
    const tone = status === 'passed' || status === 'juice_passed'
      ? 'good'
      : status === 'detection_failed'
        ? 'bad'
        : status === 'suspected' || status === 'insufficient_evidence'
          ? 'warning'
          : 'muted';
    return { status, label: labels[status] || `模型检测：${status}`, tone };
  }

  function getProviderSignalSummary(row) {
    const cacheHitRate = normalizeCacheHitRate(row?.cacheHitRate ?? row?.cache_hit_rate);
    return [
      { label: formatCacheHitRate(cacheHitRate), tone: cacheHitRate === null ? 'muted' : 'info' },
      getModelHealthInfo(row?.modelHealth ?? row?.model_health),
      getModelDetectionInfo(row?.modelDetection ?? row?.model_detection),
    ];
  }

  function modelHealthPassesTarget(modelHealth, targetModel = 'any') {
    const target = normalizeTargetModel(targetModel);
    return target === 'any' || String(modelHealth?.[target] || '').toLocaleLowerCase() === 'healthy';
  }

  function isModelDetectionExpired(modelDetection, now = Date.now()) {
    const expiresAt = modelDetection?.expires_at ?? modelDetection?.expiresAt;
    if (expiresAt == null || expiresAt === '') return false;
    const timestamp = typeof expiresAt === 'number' ? expiresAt : Date.parse(String(expiresAt));
    if (!Number.isFinite(timestamp)) return false;
    return timestamp <= Number(now);
  }

  function modelDetectionPassesPolicy(modelDetection, policy = 'observe', now = Date.now()) {
    const normalizedPolicy = normalizeModelDetectionPolicy(policy);
    if (normalizedPolicy === 'observe') return true;
    if (modelDetection?.applicable === false) return normalizedPolicy !== 'strict';
    const status = String(modelDetection?.status || 'not_tested').toLocaleLowerCase();
    if (normalizedPolicy === 'standard') return status !== 'suspected' && status !== 'detection_failed';
    return (status === 'passed' || status === 'juice_passed') && !isModelDetectionExpired(modelDetection, now);
  }

  function getModelHealthScore(modelHealth) {
    const source = modelHealth && typeof modelHealth === 'object' ? modelHealth : null;
    if (!source) return 0.4;
    const statuses = ['sol', 'terra', 'luna'].map((key) => String(source[key] || 'insufficient').toLocaleLowerCase());
    return statuses.reduce((total, status) => total + (status === 'healthy' ? 1 : status === 'failed' ? 0 : 0.5), 0) / 3;
  }

  function getModelDetectionScore(modelDetection, now = Date.now()) {
    if (!modelDetection || modelDetection.applicable === false) return 0.4;
    const status = String(modelDetection.status || 'not_tested').toLocaleLowerCase();
    if (isModelDetectionExpired(modelDetection, now)) return 0.3;
    if (status === 'passed' || status === 'juice_passed') return 1;
    if (status === 'insufficient_evidence') return 0.6;
    if (status === 'suspected') return 0.2;
    if (status === 'detection_failed') return 0;
    return 0.4;
  }

  function getSmartTTFTScore(candidate) {
    const ttft = nonNegativeNumberOrNull(candidate?.userAverageTTFTMs ?? candidate?.user_avg_ttft_ms ?? candidate?.probeTTFTMs ?? candidate?.probe_ttft_ms ?? candidate?.latency);
    return ttft === null ? 0 : 1 / (1 + (ttft / 1000));
  }

  function getSmartOutputScore(candidate) {
    const outputTokensPerSecond = nonNegativeNumberOrNull(candidate?.outputTokensPerSecond ?? candidate?.output_tps);
    return outputTokensPerSecond === null ? 0 : outputTokensPerSecond / (outputTokensPerSecond + 100);
  }

  function getSmartCandidateScore(candidate, now = Date.now()) {
    const availability = Number.isFinite(Number(candidate?.success10m)) ? clamp(Number(candidate.success10m), 0, 1) : 0;
    const cache = normalizeCacheHitRate(candidate?.cacheHitRate ?? candidate?.cache_hit_rate);
    const confidence = candidate?.userHasData || candidate?.user_has_data
      ? clamp((Number(candidate.userSampleCount ?? candidate.user_sample_count) || 0) / 100, 0, 1)
      : 0;
    return (
      availability * 0.30
      + getSmartTTFTScore(candidate) * 0.20
      + (cache === null ? 0 : cache) * 0.15
      + getSmartOutputScore(candidate) * 0.10
      + getModelHealthScore(candidate?.modelHealth ?? candidate?.model_health) * 0.10
      + getModelDetectionScore(candidate?.modelDetection ?? candidate?.model_detection, now) * 0.10
      + confidence * 0.05
    );
  }

  function getExcludedGroupInfo(rows, keywordInput) {
    const keywords = normalizeExcludedGroupKeywords(keywordInput).split('|').filter(Boolean);
    const matches = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = String(row?.planType || row?.name || '').trim();
      const normalizedName = name.toLocaleLowerCase();
      if (!name || !keywords.some((keyword) => normalizedName.includes(keyword))) continue;
      const identity = `${row?.group_id ?? ''}:${normalizedName}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      matches.push({ row, name });
    }
    return { keywords, matches };
  }

  function analyzeCandidates(rows, config = DEFAULT_CONFIG) {
    const normalizedConfig = normalizeConfig(config);
    const excludedKeywords = normalizedConfig.excludedGroupKeywords.split('|').filter(Boolean);
    const sourceRows = Array.isArray(rows) ? rows : [];
    const counts = { total: sourceRows.length, invalid: 0, unavailable: 0, lowSuccess: 0, warnings: 0, keywords: 0, modelHealth: 0, modelDetection: 0, cache: 0, eligible: 0 };
    const candidates = [];
    for (const row of sourceRows) {
      const groupId = Number(row?.group_id);
      const price = Number(row?.priceMultiplier);
      if (!row || !Number.isInteger(groupId) || groupId <= 0 || !Number.isFinite(price) || price < 0) {
        counts.invalid += 1;
        continue;
      }
      if (row.enabled === false || row.visibleInHall === false || row.available !== true) {
        counts.unavailable += 1;
        continue;
      }
      const success10m = Number(row.successRates?.['10m']);
      const recentSuccessCount = Number(row.recentSuccessCount);
      const recentConsecutiveSuccessCount = Number(row.recentConsecutiveSuccessCount);
      const availabilityPasses = normalizedConfig.availabilityMode === 'successes'
        ? Number.isFinite(recentSuccessCount) && recentSuccessCount >= normalizedConfig.minSuccessPoints10m
        : normalizedConfig.availabilityMode === 'consecutive'
          ? Number.isFinite(recentConsecutiveSuccessCount) && recentConsecutiveSuccessCount >= normalizedConfig.minConsecutiveSuccesses10m
          : Number.isFinite(success10m) && success10m >= normalizedConfig.minSuccess10m;
      if (!availabilityPasses) {
        counts.lowSuccess += 1;
        continue;
      }
      if (normalizedConfig.requireNoWarnings && Array.isArray(row.warningReasons) && row.warningReasons.length > 0) {
        counts.warnings += 1;
        continue;
      }
      const name = String(row.planType || row.name || `Group ${row.group_id}`);
      if (excludedKeywords.some((keyword) => name.toLocaleLowerCase().includes(keyword))) {
        counts.keywords += 1;
        continue;
      }
      const modelHealth = row.modelHealth ?? row.model_health ?? null;
      const modelDetection = row.modelDetection ?? row.model_detection ?? null;
      const cacheHitRate = normalizeCacheHitRate(row.cacheHitRate ?? row.cache_hit_rate);
      if (!modelHealthPassesTarget(modelHealth, normalizedConfig.targetModel)) {
        counts.modelHealth += 1;
        continue;
      }
      if (!modelDetectionPassesPolicy(modelDetection, normalizedConfig.modelDetectionPolicy)) {
        counts.modelDetection += 1;
        continue;
      }
      if (normalizedConfig.minCacheHitRate > 0 && (cacheHitRate === null || cacheHitRate < normalizedConfig.minCacheHitRate)) {
        counts.cache += 1;
        continue;
      }
      candidates.push({
        ...row,
        groupId,
        price,
        success10m,
        latency: Number.isFinite(Number(row.firstTokenLatencyMs)) ? Number(row.firstTokenLatencyMs) : Number.POSITIVE_INFINITY,
        name,
        cacheHitRate,
        modelHealth,
        modelDetection,
      });
      counts.eligible += 1;
    }
    return { candidates, counts };
  }

  function getEligibleCandidates(rows, normalizedConfig) {
    return analyzeCandidates(rows, normalizedConfig).candidates;
  }

  function comparePrice(left, right) {
    return left.price - right.price
      || right.success10m - left.success10m
      || left.latency - right.latency
      || left.name.localeCompare(right.name);
  }

  function compareSpeed(left, right) {
    return left.latency - right.latency
      || left.price - right.price
      || right.success10m - left.success10m
      || left.name.localeCompare(right.name);
  }

  function rankCandidates(rows, config = DEFAULT_CONFIG) {
    const normalizedConfig = normalizeConfig(config);
    const candidates = getEligibleCandidates(rows, normalizedConfig);
    if (normalizedConfig.mode === 'speed') return candidates.sort(compareSpeed);
    if (normalizedConfig.mode === 'balance') return candidates.filter((candidate) => candidate.price <= normalizedConfig.balanceMaxPrice).sort(compareSpeed);
    if (normalizedConfig.mode === 'smart') {
      const scoreAt = Date.now();
      return candidates
        .filter((candidate) => candidate.price <= normalizedConfig.balanceMaxPrice)
        .map((candidate) => ({ ...candidate, smartScore: getSmartCandidateScore(candidate, scoreAt) }))
        .sort((left, right) => right.smartScore - left.smartScore || left.price - right.price || left.latency - right.latency || left.name.localeCompare(right.name));
    }
    return candidates.sort(comparePrice);
  }

  function getCandidateRankingRule(config = DEFAULT_CONFIG) {
    const normalizedConfig = normalizeConfig(config);
    if (normalizedConfig.mode === 'speed') return '首 Token 从快到慢';
    if (normalizedConfig.mode === 'balance') return `倍率 ≤ ${formatMultiplier(normalizedConfig.balanceMaxPrice)} · 首 Token 从快到慢`;
    if (normalizedConfig.mode === 'smart') return `倍率 ≤ ${formatMultiplier(normalizedConfig.balanceMaxPrice)} · 综合评分从高到低`;
    return '倍率从低到高';
  }

  function findProviderGroupRow(root, groupName) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const targetName = normalizeGroupName(groupName);
    if (!targetName) return null;
    for (const row of root.querySelectorAll('.decision-entry, .monitor-api-row:not(.monitor-api-head)')) {
      const name = row.querySelector?.('.group-cell strong, .monitor-plan-cell')?.textContent;
      if (normalizeGroupName(name) === targetName) return row;
    }
    return null;
  }

  function findProviderRefreshButton(root) {
    if (!root || typeof root.querySelector !== 'function') return null;
    const legacyButton = root.querySelector('.monitor-refresh-button');
    if (legacyButton) return legacyButton;
    if (typeof root.querySelectorAll !== 'function') return null;
    return [...root.querySelectorAll('button.monitor-icon-button')].find((button) => {
      const label = `${button?.title || ''} ${button?.getAttribute?.('aria-label') || ''} ${button?.textContent || ''}`;
      return /刷新|refresh/i.test(label);
    }) || null;
  }

  function isProviderRefreshButtonBusy(button) {
    return Boolean(button?.disabled || button?.querySelector?.('.animate-spin') || /刷新中|检测中|refreshing/i.test(String(button?.textContent || '')));
  }

  function parsePendingProviderLocation(value, now = Date.now()) {
    try {
      const pending = JSON.parse(String(value || ''));
      const name = String(pending?.name || '').trim();
      const expiresAt = Number(pending?.expiresAt);
      return name && Number.isFinite(expiresAt) && expiresAt >= now ? { name, expiresAt } : null;
    } catch {
      return null;
    }
  }

  function formatRelativeAge(ageMs) {
    if (!Number.isFinite(ageMs)) return '时间未知';
    const seconds = Math.max(0, Math.floor(ageMs / 1000));
    if (seconds < 5) return '刚刚';
    if (seconds < 60) return `${seconds} 秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时前`;
  }

  function getMonitorFreshness(generatedAt, now = Date.now(), maxAgeSeconds = DEFAULT_CONFIG.maxMonitorAgeSeconds) {
    const parsed = typeof generatedAt === 'number' ? generatedAt : Date.parse(generatedAt);
    if (!Number.isFinite(parsed)) return { generatedAt: null, ageMs: null, stale: true, label: '时间未知' };
    const ageMs = Math.max(0, Number(now) - parsed);
    return {
      generatedAt: parsed,
      ageMs,
      stale: ageMs > Math.max(0, Number(maxAgeSeconds) || 0) * 1000,
      label: formatRelativeAge(ageMs),
    };
  }

  function getLatestMonitorSampleAt(seriesPayload) {
    let latest = null;
    for (const samples of Object.values(seriesPayload?.seriesByApiId || {})) {
      for (const sample of Array.isArray(samples) ? samples : []) {
        const timestamp = Number(sample?.[0]);
        if (Number.isFinite(timestamp) && (latest === null || timestamp > latest)) latest = timestamp;
      }
    }
    return latest;
  }

  function formatRemainingTime(remainingMs) {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    if (totalSeconds < 60) return `${totalSeconds} 秒`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  }

  function getCooldownInfo(lastSwitchAt, cooldownMinutes, now = Date.now()) {
    const cooldownMs = Math.max(0, Number(cooldownMinutes) || 0) * 60 * 1000;
    const lastAt = Number(lastSwitchAt);
    const remainingMs = Number.isFinite(lastAt) ? Math.max(0, lastAt + cooldownMs - Number(now)) : 0;
    return { remainingMs, active: remainingMs > 0, label: remainingMs > 0 ? `剩余 ${formatRemainingTime(remainingMs)}` : '冷却已结束' };
  }

  function attachRecentAvailability(rows, seriesPayload, windowMs = 10 * 60 * 1000) {
    const generatedAt = Date.parse(seriesPayload?.generatedAt);
    const now = Number.isFinite(generatedAt) ? generatedAt : Date.now();
    const cutoff = now - Math.max(1, Number(windowMs) || 1);
    const seriesByApiId = seriesPayload?.seriesByApiId || {};
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const samples = Array.isArray(seriesByApiId[row?.id]) ? seriesByApiId[row.id] : [];
      const recent = samples.filter((sample) => {
        const at = Number(sample?.[0]);
        return Number.isFinite(at) && at >= cutoff && at <= now && (sample?.[1] === 0 || sample?.[1] === 1);
      });
      const successes = recent.filter((sample) => sample[1] === 1).length;
      const orderedRecent = recent.slice().sort((left, right) => Number(left[0]) - Number(right[0]));
      let trailingSuccesses = 0;
      for (let index = orderedRecent.length - 1; index >= 0 && orderedRecent[index][1] === 1; index -= 1) trailingSuccesses += 1;
      return {
        ...row,
        successRates: {
          ...(row?.successRates || {}),
          '10m': recent.length ? successes / recent.length : Number.NaN,
        },
        recentSampleCount: recent.length,
        recentSuccessCount: successes,
        recentConsecutiveSuccessCount: trailingSuccesses,
      };
    });
  }

  function buildAvailabilityChartModel(seriesPayload, apiId) {
    const width = 320;
    const height = 40;
    const left = 4;
    const right = width - 4;
    const availableY = 9;
    const unavailableY = height - 9;
    const source = seriesPayload?.seriesByApiId?.[apiId];
    const samples = (Array.isArray(source) ? source : [])
      .map((sample) => ({
        at: Number(sample?.[0]),
        available: sample?.[1] === 1 ? true : sample?.[1] === 0 ? false : null,
      }))
      .filter((sample) => Number.isFinite(sample.at) && sample.available !== null)
      .sort((leftSample, rightSample) => leftSample.at - rightSample.at);
    const generatedAt = Date.parse(seriesPayload?.generatedAt);
    const latestSampleAt = samples.length ? samples[samples.length - 1].at : Number.NaN;
    const endAt = Number.isFinite(generatedAt)
      ? generatedAt
      : (Number.isFinite(latestSampleAt) ? latestSampleAt : Date.now());
    const startAt = endAt - AVAILABILITY_CHART_RANGE_MS;
    const points = samples
      .filter((sample) => sample.at >= startAt && sample.at <= endAt)
      .map((sample) => ({
        ...sample,
        x: left + ((sample.at - startAt) / AVAILABILITY_CHART_RANGE_MS) * (right - left),
        y: sample.available ? availableY : unavailableY,
      }));
    let path = '';
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const x = point.x.toFixed(1);
      const y = point.y.toFixed(1);
      if (!path) {
        path = `M${x},${y}`;
        continue;
      }
      path += ` H${x}`;
      const previous = points[index - 1];
      if (previous?.y !== point.y) path += ` V${y}`;
    }
    const successCount = points.filter((point) => point.available).length;
    return {
      width,
      height,
      startAt,
      endAt,
      points,
      path,
      successCount,
      total: points.length,
      successRate: points.length ? successCount / points.length : Number.NaN,
    };
  }

  function createSvgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NAMESPACE, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function renderAvailabilityChart(seriesPayload, apiId, groupName) {
    const model = buildAvailabilityChartModel(seriesPayload, apiId);
    const shell = document.createElement('div');
    shell.className = 'asg-availability-chart';
    const head = document.createElement('div');
    head.className = 'asg-availability-head';
    const title = document.createElement('span');
    title.className = 'asg-availability-title';
    title.textContent = '6h 可用性';
    const summary = document.createElement('span');
    summary.className = 'asg-availability-summary';
    summary.textContent = model.total
      ? `${model.successCount}/${model.total} 点 · ${formatPercent(model.successRate)}`
      : '暂无数据';
    head.append(title, summary);
    shell.appendChild(head);
    if (!model.total) return shell;

    const svg = createSvgElement('svg', {
      class: 'asg-availability-svg',
      viewBox: `0 0 ${model.width} ${model.height}`,
      role: 'img',
      'aria-label': `${groupName} 近 6 小时可用性，成功 ${model.successCount}/${model.total} 次`,
      preserveAspectRatio: 'none',
    });
    svg.append(
      createSvgElement('line', { class: 'asg-availability-guide', x1: 4, x2: model.width - 4, y1: 9, y2: 9 }),
      createSvgElement('line', { class: 'asg-availability-guide', x1: 4, x2: model.width - 4, y1: model.height - 9, y2: model.height - 9 }),
      createSvgElement('path', { class: 'asg-availability-line', d: model.path }),
    );
    for (const point of model.points) {
      const circle = createSvgElement('circle', {
        class: `asg-availability-point ${point.available ? 'asg-availability-point-ok' : 'asg-availability-point-failed'}`,
        cx: point.x.toFixed(1),
        cy: point.y.toFixed(1),
        r: 2.5,
      });
      const tooltip = createSvgElement('title');
      tooltip.textContent = `${new Date(point.at).toLocaleString()} · ${point.available ? '可用' : '不可用'}`;
      circle.appendChild(tooltip);
      svg.appendChild(circle);
    }
    const axis = document.createElement('div');
    axis.className = 'asg-availability-axis';
    const start = document.createElement('span');
    start.textContent = '6 小时前';
    const end = document.createElement('span');
    end.textContent = '现在';
    axis.append(start, end);
    shell.append(svg, axis);
    return shell;
  }

  function normalizeGroupName(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
  }

  function buildGroupMultiplierMap(rows) {
    const result = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = normalizeGroupName(row?.planType || row?.name);
      const multiplier = Number(row?.priceMultiplier);
      if (name && Number.isFinite(multiplier) && multiplier >= 0) result.set(name, multiplier);
    }
    return result;
  }

  function nonNegativeNumberOrNull(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function buildGroupMetricMap(rows) {
    const result = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const groupId = Number(row?.group_id);
      if (!Number.isInteger(groupId) || groupId <= 0) continue;
      result.set(groupId, {
        multiplier: nonNegativeNumberOrNull(row?.priceMultiplier),
        latencyMs: nonNegativeNumberOrNull(row?.firstTokenLatencyMs),
      });
    }
    return result;
  }

  function normalizeGroupMonitorMultiplier(value) {
    const multiplier = nonNegativeNumberOrNull(value);
    return multiplier === null ? '' : multiplier.toFixed(6);
  }

  function groupDropdownMonitorKey(name, multiplier) {
    const normalizedName = normalizeGroupName(name);
    const normalizedMultiplier = normalizeGroupMonitorMultiplier(multiplier);
    return normalizedName && normalizedMultiplier ? `${normalizedName}|${normalizedMultiplier}` : '';
  }

  function newerMonitorRow(current, candidate) {
    if (!current) return candidate;
    const currentAt = Date.parse(current.checkedAt);
    const candidateAt = Date.parse(candidate.checkedAt);
    return Number.isFinite(candidateAt) && (!Number.isFinite(currentAt) || candidateAt > currentAt) ? candidate : current;
  }

  function buildGroupDropdownMonitorIndex(rows) {
    const byComposite = new Map();
    const byName = new Map();
    const ambiguousNames = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = normalizeGroupName(row?.planType || row?.name);
      if (!name) continue;
      const compositeKey = groupDropdownMonitorKey(name, row?.priceMultiplier);
      if (compositeKey) byComposite.set(compositeKey, newerMonitorRow(byComposite.get(compositeKey), row));
      if (byName.has(name)) {
        ambiguousNames.add(name);
        byName.delete(name);
      } else if (!ambiguousNames.has(name)) {
        byName.set(name, row);
      }
    }
    return { byComposite, byName, ambiguousNames };
  }

  function findGroupDropdownMonitor(index, name, multiplier) {
    const compositeKey = groupDropdownMonitorKey(name, multiplier);
    if (compositeKey && index?.byComposite instanceof Map && index.byComposite.has(compositeKey)) {
      return index.byComposite.get(compositeKey);
    }
    const normalizedName = normalizeGroupName(name);
    return normalizedName && index?.byName instanceof Map ? index.byName.get(normalizedName) || null : null;
  }

  function parseGroupOptionMultiplier(value) {
    const text = String(value || '');
    const match = text.match(/(?:×\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*x(?:\s*倍率)?)/i);
    if (!match) return null;
    const multiplier = Number(match[1] ?? match[2]);
    return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : null;
  }

  function formatGroupDropdownMonitor(row) {
    const latency = nonNegativeNumberOrNull(row?.firstTokenLatencyMs);
    const latencyValueText = row && latency !== null ? `${Math.round(latency)} ms` : '';
    const latencyText = row && latency !== null
      ? `首 Token ${latencyValueText}`
      : '首 Token 暂无数据';
    if (!row) return { statusText: '暂无监控', statusTone: 'unknown', latencyText, latencyValueText };
    if (row.enabled === false) return { statusText: '已停用', statusTone: 'disabled', latencyText, latencyValueText };
    if (row.available === true && Array.isArray(row.warningReasons) && row.warningReasons.length) {
      return { statusText: '可用 · 有警告', statusTone: 'warning', latencyText, latencyValueText };
    }
    if (row.available === true) return { statusText: '可用', statusTone: 'available', latencyText, latencyValueText };
    if (row.available === false) return { statusText: '不可用', statusTone: 'unavailable', latencyText, latencyValueText };
    return { statusText: '暂无监控', statusTone: 'unknown', latencyText, latencyValueText };
  }

  function getGroupDropdownToneClass(tone) {
    const safeTone = ['available', 'warning', 'unavailable', 'disabled', 'error'].includes(tone) ? tone : '';
    return safeTone ? `asg-key-group-badge-${safeTone}` : '';
  }

  function formatKeyOptionLabel(key, metric) {
    const name = String(key?.name || `Key ${key?.id ?? ''}`).trim();
    const groupName = String(key?.groupName || '未分组').trim();
    const multiplier = nonNegativeNumberOrNull(metric?.multiplier);
    const latencyMs = nonNegativeNumberOrNull(metric?.latencyMs);
    const multiplierText = multiplier === null ? '倍率暂无数据' : formatMultiplier(multiplier);
    const latencyText = latencyMs === null ? '首 Token 暂无数据' : `首 Token ${formatLatency(latencyMs)}`;
    return `${name} · ${groupName} · ${multiplierText} · ${latencyText}`;
  }

  function formatMultiplier(value) {
    const multiplier = Number(value);
    if (!Number.isFinite(multiplier) || multiplier < 0) return '';
    return `×${multiplier.toFixed(6).replace(/\.?0+$/, '')}`;
  }

  function getPageFeatures(pathname, loggedIn) {
    const path = String(pathname || '').split('?')[0];
    if (!loggedIn) return { panel: false, usage: false, keyGroups: false };
    return {
      panel: true,
      usage: path === '/usage' || path.startsWith('/usage/'),
      keyGroups: path === '/keys' || path.startsWith('/keys/'),
    };
  }

  function createStabilityState() {
    return { groupId: null, count: 0, stable: false };
  }

  function advanceStability(state, groupId, requiredChecks) {
    const required = Math.max(1, Math.round(Number(requiredChecks) || 1));
    const numericGroupId = Number.isInteger(Number(groupId)) ? Number(groupId) : null;
    if (numericGroupId === null) return createStabilityState();
    const sameGroup = state && state.groupId === numericGroupId;
    const count = sameGroup ? Number(state.count || 0) + 1 : 1;
    return { groupId: numericGroupId, count, stable: count >= required };
  }

  function canAutoSwitch(options) {
    return getAutoSwitchBlockReason(options) === '';
  }

  function getAutoSwitchBlockReason({ now, lastSwitchAt, currentGroupId, targetGroupId, stable, config, monitorStale, monitorFreshnessText }) {
    if (monitorStale) return `监控数据已过期（${monitorFreshnessText || '时间未知'}）`;
    if (!stable) return '推荐尚未稳定';
    if (targetGroupId == null) return '暂无推荐分组';
    if (currentGroupId === targetGroupId) return '当前密钥已经在推荐分组';
    const cooldown = getCooldownInfo(lastSwitchAt, normalizeConfig(config).cooldownMinutes, now);
    if (cooldown.active) return `切换冷却中（${cooldown.label}）`;
    return '';
  }

  function shouldLogTransition(previous, current, forced = false) {
    return forced || previous !== current;
  }

  function getSwitchBlockReason({ loading, allowWhileLoading, error, authError, monitorStale, monitorFreshnessText, winner, key, stability, requiredChecks }) {
    if (loading && !allowWhileLoading) return '正在检测';
    if (error) return String(error);
    if (authError) return String(authError);
    if (monitorStale) return `监控数据已过期（${monitorFreshnessText || '时间未知'}）`;
    if (!winner) return '暂无符合条件的推荐分组';
    if (!key) return '请先读取并选择目标密钥';
    if (!stability?.stable) return `推荐尚未稳定（${Number(stability?.count) || 0}/${requiredChecks} 次）`;
    if (key.groupId === winner.groupId) return '当前密钥已经在推荐分组';
    return '';
  }

  function projectKeys(keys) {
    return (Array.isArray(keys) ? keys : [])
      .filter((key) => key && key.id != null)
      .map((key) => ({
        id: key.id,
        name: String(key.name || `Key ${key.id}`),
        groupId: key.group_id == null ? null : Number(key.group_id),
        groupName: String(key.group?.name || key.group_name || '未分组'),
        status: String(key.status || ''),
      }));
  }

  function buildAuthHeaders(token) {
    const trimmed = typeof token === 'string' ? token.trim() : '';
    return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
  }

  function buildApiHeaders(path, token) {
    const headers = buildAuthHeaders(token);
    if (/^\/(?:auth\/me(?:\?|$)|keys(?:\/|\?|$)|groups\/(?:available|rates)(?:\?|$)|usage(?:\/|\?|$)|redeem(?:\/|\?|$)|subscriptions(?:\/|\?|$))/.test(path)) {
      headers['X-User-UI-Request'] = '1';
    }
    return headers;
  }

  function mergeKeyPages(pages) {
    const byId = new Map();
    for (const page of Array.isArray(pages) ? pages : []) {
      const items = Array.isArray(page)
        ? page
        : (Array.isArray(page?.items)
          ? page.items
          : (Array.isArray(page?.data?.items) ? page.data.items : (Array.isArray(page?.data) ? page.data : [])));
      for (const key of items) {
        if (key && key.id != null && !byId.has(key.id)) byId.set(key.id, key);
      }
    }
    return [...byId.values()];
  }

  function shouldRefreshKeys({ now = Date.now(), lastFetchedAt, keyCount, force = false, intervalMs = 5 * 60 * 1000 }) {
    const fetchedAt = Number(lastFetchedAt);
    return force === true
      || Number(keyCount) === 0
      || !Number.isFinite(fetchedAt)
      || fetchedAt <= 0
      || Number(now) - fetchedAt >= Math.max(0, Number(intervalMs) || 0);
  }

  function storageGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(STORAGE_PREFIX + key, fallback);
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STORAGE_PREFIX + key, value);
        return;
      }
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage is optional; a failed write must not interrupt monitoring.
    }
  }

  function sanitizeLogText(value) {
    return String(value ?? '')
      .replace(/(Bearer\s+)[^\s,'"]+/gi, '$1[已隐藏]')
      .replace(/((?:auth[_-]?token|access[_-]?token|token)\s*[=:]\s*)[^\s,'"]+/gi, '$1[已隐藏]')
      .replace(/(?:sk-|key-)[^\s,'"]{8,}/gi, '[已隐藏]')
      .slice(0, 180);
  }

  function appendLogEntries(logs, entry, limit = 100) {
    const safeEntry = {
      at: Number(entry?.at) || Date.now(),
      scope: String(entry?.scope || 'general'),
      level: String(entry?.level || 'info'),
      message: sanitizeLogText(entry?.message),
    };
    return [safeEntry, ...(Array.isArray(logs) ? logs : [])]
      .slice(0, Math.max(1, Number(limit) || 100));
  }

  function formatLogLine(entry) {
    const time = new Date(Number(entry?.at) || Date.now()).toLocaleString();
    return `[${time}] ${entry?.level === 'error' ? '错误' : entry?.level === 'warn' ? '警告' : '信息'}：${sanitizeLogText(entry?.message)}`;
  }

  function readScopeLogs(scope) {
    return storageGet('runtime-logs', []).filter((entry) => entry?.scope === scope).slice(0, 30);
  }

  function writeRuntimeLog(scope, level, message) {
    const logs = appendLogEntries(storageGet('runtime-logs', []), { scope, level, message });
    storageSet('runtime-logs', logs);
    return logs;
  }

  function getAuthToken() {
    try {
      // Tampermonkey may expose page storage through the isolated world or
      // through unsafeWindow depending on its sandbox settings.
      const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      return pageWindow.localStorage.getItem('auth_token')
        || localStorage.getItem('auth_token')
        || '';
    } catch {
      return '';
    }
  }

  function getPageWindow() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  }

  async function apiRequest(path, options = {}) {
    const headers = {
      Accept: 'application/json',
      ...buildApiHeaders(path, getAuthToken()),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    };
    const response = await getPageWindow().fetch(`/api/v1${path}`, {
      credentials: 'include',
      ...options,
      headers,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const detail = payload && (payload.detail || payload.message);
      const error = new Error(detail ? String(detail) : `请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function normalizeProviderRow(row) {
    const source = row && typeof row === 'object' ? row : {};
    const rawSuccessRates = source.successRates ?? source.success_rates ?? {};
    const fallbackSuccessRate = Number(source.sla);
    const successRates = {};
    for (const range of ['5m', '6h', '24h', '7d', '30d']) {
      const value = Number(rawSuccessRates?.[range]);
      successRates[range] = Number.isFinite(value)
        ? value
        : (Number.isFinite(fallbackSuccessRate) ? fallbackSuccessRate : Number.NaN);
    }
    if (Object.prototype.hasOwnProperty.call(rawSuccessRates, '10m')) successRates['10m'] = Number(rawSuccessRates['10m']);

    const groupId = Number(source.group_id ?? source.groupId);
    const rawCacheHitRate = source.cacheHitRate ?? source.cache_hit_rate;
    return {
      ...source,
      id: String(source.id ?? (Number.isFinite(groupId) ? groupId : '')),
      group_id: groupId,
      planType: String(source.planType ?? source.code ?? source.name ?? '').trim(),
      priceMultiplier: Number(source.priceMultiplier ?? source.rate_multiplier),
      enabled: source.enabled !== false,
      available: source.available === true,
      visibleInHall: source.visibleInHall ?? source.visible_in_hall ?? source.available === true,
      firstTokenLatencyMs: nonNegativeNumberOrNull(source.firstTokenLatencyMs ?? source.probe_ttft_ms ?? source.probeTTFTMs ?? source.avg_ttft_ms),
      successRates,
      checkedAt: source.checkedAt ?? source.last_probed_at ?? null,
      warningReasons: Array.isArray(source.warningReasons) ? source.warningReasons : [],
      cacheHitRate: normalizeCacheHitRate(rawCacheHitRate),
      cacheHitRateText: typeof rawCacheHitRate === 'string' ? rawCacheHitRate : formatCacheHitRate(rawCacheHitRate).replace(/^缓存\s*/, ''),
      modelHealth: source.modelHealth ?? source.model_health ?? null,
      modelDetection: source.modelDetection ?? source.model_detection ?? null,
      responseValid: source.responseValid ?? source.response_valid ?? null,
      probeTTFTMs: nonNegativeNumberOrNull(source.probe_ttft_ms ?? source.probeTTFTMs ?? source.firstTokenLatencyMs),
      userAverageTTFTMs: nonNegativeNumberOrNull(source.user_avg_ttft_ms ?? source.userAverageTTFTMs),
      userSampleCount: nonNegativeNumberOrNull(source.user_sample_count ?? source.userSampleCount),
      userHasData: source.user_has_data === true || source.userHasData === true,
      outputTokensPerSecond: nonNegativeNumberOrNull(source.outputTokensPerSecond ?? source.output_tps),
    };
  }

  function normalizeProviderSummary(payload) {
    const data = payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')
      ? payload.data
      : payload;
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(payload?.apis)
          ? payload.apis
          : [];
    return {
      generatedAt: data?.generated_at ?? data?.generatedAt ?? payload?.generated_at ?? payload?.generatedAt ?? null,
      monitoringActive: payload?.monitoringActive ?? true,
      apis: items.map(normalizeProviderRow),
    };
  }

  function normalizeProviderSeries(payload) {
    const data = payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')
      ? payload.data
      : payload;
    if (data?.seriesByApiId && typeof data.seriesByApiId === 'object') {
      return {
        generatedAt: data.generatedAt ?? null,
        range: data.range ?? '6h',
        seriesByApiId: data.seriesByApiId,
        userTTFTByApiId: data.userTTFTByApiId ?? {},
      };
    }
    const seriesByApiId = {};
    const userTTFTByApiId = {};
    for (const item of Array.isArray(data?.items) ? data.items : []) {
      const id = String(item?.group_id ?? '');
      if (!id) continue;
      seriesByApiId[id] = Array.isArray(item.probe) ? item.probe : [];
      userTTFTByApiId[id] = Array.isArray(item.user_ttft) ? item.user_ttft : [];
    }
    return {
      generatedAt: data?.generated_at ?? data?.generatedAt ?? null,
      range: data?.range ?? '6h',
      seriesByApiId,
      userTTFTByApiId,
    };
  }

  async function fetchMonitorSummary() {
    try {
      return normalizeProviderSummary(await apiRequest('/public/providers'));
    } catch (error) {
      if (error?.status !== 404) throw error;
      return normalizeProviderSummary(await apiRequest('/public/monitor/summary'));
    }
  }

  async function fetchMonitorSeries() {
    try {
      return normalizeProviderSeries(await apiRequest('/public/providers/series?range=6h'));
    } catch (error) {
      if (error?.status !== 404) throw error;
      return normalizeProviderSeries(await apiRequest('/public/monitor/series/6h'));
    }
  }

  async function fetchCurrentBalance() {
    return apiRequest('/auth/me?timezone=Asia%2FShanghai');
  }

  async function fetchAllKeys() {
    const pages = [];
    let page = 1;
    let totalPages = 1;
    do {
      const query = new URLSearchParams({ page: String(page), page_size: '100', sort_by: 'created_at', sort_order: 'desc' });
      const result = await apiRequest(`/keys?${query}`);
      pages.push(result);
      totalPages = Math.max(1, Number(result?.pages) || 1);
      page += 1;
    } while (page <= totalPages);
    return projectKeys(mergeKeyPages(pages));
  }

  async function updateKeyGroup(keyId, groupId) {
    return apiRequest(`/keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT',
      body: JSON.stringify({ group_id: Number(groupId) }),
    });
  }

  const STYLE = `
    #${ROOT_ID}{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:2147483647;display:flex;flex-direction:column;width:min(480px,calc(100vw - 32px));height:min(700px,calc(100vh - 32px));color:#172033;background:#fff;border:1px solid #d0d5dd;border-radius:10px;box-shadow:0 18px 48px rgba(16,24,40,.22);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden;isolation:isolate}
    #${ROOT_ID}[data-side-open=true]{width:min(820px,calc(100vw - 32px))}
    #${ROOT_ID}[hidden]{display:none}
    #${ROOT_ID} *{box-sizing:border-box}
    #${ROOT_ID} .asg-head{display:flex;flex:none;align-items:center;justify-content:space-between;min-height:48px;padding:8px 10px 8px 16px;background:#f8fafc;border-bottom:1px solid #e4e7ec}
    #${ROOT_ID} .asg-head-title{display:flex;align-items:center;gap:8px;min-width:0}
    #${ROOT_ID} .asg-head-title strong{overflow:hidden;font-size:14px;text-overflow:ellipsis;white-space:nowrap}
    #${ROOT_ID} .asg-head-title span{flex:none;padding:2px 6px;color:#667085;background:#eef2f6;border-radius:4px;font-size:10px;font-weight:600}
    #${ROOT_ID} .asg-head-actions{display:flex;flex:none;align-items:center;gap:5px}
    #${ROOT_ID} .asg-head-tabs{display:flex;align-items:center;gap:2px;padding:2px;background:#eef2f6;border-radius:7px}
    #${ROOT_ID} .asg-head-tab{min-height:28px;border:0;padding:4px 9px;background:transparent;color:#667085;font-size:12px;font-weight:600}
    #${ROOT_ID} .asg-head-tab:hover:not(:disabled){background:rgba(255,255,255,.7);border-color:transparent}
    #${ROOT_ID} .asg-head-tab[aria-selected=true]{background:#fff;color:#1456d9;box-shadow:0 1px 2px rgba(16,24,40,.1)}
    #${ROOT_ID} button{min-height:32px;font:inherit;cursor:pointer;border:1px solid #cfd5df;border-radius:6px;background:#fff;color:#172033;padding:5px 10px;transition:background-color .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease}
    #${ROOT_ID} button:hover:not(:disabled){background:#f2f4f7;border-color:#b7c0ce}
    #${ROOT_ID} button:disabled{cursor:not-allowed;opacity:.5}
    #${ROOT_ID} button:focus-visible,#${ROOT_ID} select:focus-visible,#${ROOT_ID} input:focus-visible,#${ROOT_ID} summary:focus-visible{outline:2px solid #2e6fe8;outline-offset:2px}
    #${ROOT_ID} .asg-icon{display:grid;place-items:center;width:32px;height:32px;min-height:32px;border:0;padding:0;font-size:20px;line-height:1}
    #${ROOT_ID} .asg-body{display:grid;grid-template-columns:minmax(0,1fr);flex:1;min-height:0;overflow:hidden}
    #${ROOT_ID}[data-side-open=true] .asg-body{grid-template-columns:minmax(0,1.15fr) minmax(330px,.85fr)}
    #${ROOT_ID} .asg-main-column,#${ROOT_ID} .asg-side-column{min-width:0;min-height:0;overflow:auto;padding:14px 16px;scrollbar-gutter:stable}
    #${ROOT_ID} .asg-main-column::-webkit-scrollbar,#${ROOT_ID} .asg-side-column::-webkit-scrollbar,#${ROOT_ID} .asg-list::-webkit-scrollbar{width:8px;height:8px}
    #${ROOT_ID} .asg-main-column::-webkit-scrollbar-thumb,#${ROOT_ID} .asg-side-column::-webkit-scrollbar-thumb,#${ROOT_ID} .asg-list::-webkit-scrollbar-thumb{background:#cbd2dc;border:2px solid transparent;border-radius:8px;background-clip:padding-box}
    #${ROOT_ID} .asg-side-column{border-left:1px solid #e4e7ec;background:#fbfcfe}
    #${ROOT_ID} .asg-status-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;padding-bottom:9px;border-bottom:1px solid #eef0f3}
    #${ROOT_ID} .asg-status{display:flex;align-items:center;min-width:0;color:#667085;font-size:12px}
    #${ROOT_ID} .asg-status::before{flex:none;width:7px;height:7px;margin-right:7px;background:#12b76a;border-radius:50%;content:""}
    #${ROOT_ID} .asg-status.asg-error::before{background:#f04438}
    #${ROOT_ID} .asg-status.asg-error{background:transparent;border-color:transparent}
    #${ROOT_ID} .asg-balance{flex:none;color:#15803d;font-size:12px;font-weight:600;text-align:right;white-space:nowrap}
    #${ROOT_ID} .asg-balance.asg-balance-error{color:#b54708;font-weight:500}
    #${ROOT_ID} .asg-recommend{padding:11px 12px;background:#f4f8ff;border:1px solid #cfe0ff;border-radius:8px;margin:10px 0 12px}
    #${ROOT_ID} .asg-recommend.asg-recommend-stale{background:#fff4f2;border-color:#fecdca}
    #${ROOT_ID} .asg-recommend strong{font-size:15px;line-height:1.35}
    #${ROOT_ID} .asg-muted{color:#667085}
    #${ROOT_ID} .asg-metrics{display:flex;flex-wrap:wrap;gap:6px 12px;color:#475467;font-size:12px;margin-top:4px}
    #${ROOT_ID} .asg-provider-signals,#${ROOT_ID} .asg-candidate-signals{display:flex;align-items:center;gap:4px 10px;min-width:0;margin-top:5px;overflow:hidden}
    #${ROOT_ID} .asg-provider-signals{flex-wrap:wrap}
    #${ROOT_ID} .asg-provider-signal{flex:none;font-size:10px;font-weight:600;white-space:nowrap}
    #${ROOT_ID} .asg-signal-good{color:#067647}
    #${ROOT_ID} .asg-signal-info{color:#175cd3}
    #${ROOT_ID} .asg-signal-warning{color:#b54708}
    #${ROOT_ID} .asg-signal-bad{color:#b42318}
    #${ROOT_ID} .asg-signal-muted{color:#667085}
    #${ROOT_ID} .asg-availability-chart{margin-top:8px;padding-top:7px;border-top:1px solid #dce6f7}
    #${ROOT_ID} .asg-availability-head,#${ROOT_ID} .asg-availability-axis{display:flex;align-items:center;justify-content:space-between;gap:8px}
    #${ROOT_ID} .asg-availability-title{color:#344054;font-size:11px;font-weight:600}
    #${ROOT_ID} .asg-availability-summary,#${ROOT_ID} .asg-availability-axis{color:#667085;font-size:10px}
    #${ROOT_ID} .asg-availability-svg{display:block;width:100%;height:48px;margin-top:3px;overflow:visible}
    #${ROOT_ID} .asg-availability-guide{stroke:#d0d5dd;stroke-width:1;stroke-dasharray:2 3;vector-effect:non-scaling-stroke}
    #${ROOT_ID} .asg-availability-line{fill:none;stroke:#667085;stroke-width:1.25;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
    #${ROOT_ID} .asg-availability-point{stroke:#fff;stroke-width:1;vector-effect:non-scaling-stroke}
    #${ROOT_ID} .asg-availability-point-ok{fill:#12b76a}
    #${ROOT_ID} .asg-availability-point-failed{fill:#f04438}
    #${ROOT_ID} .asg-recommend-meta{margin-top:5px;color:#667085;font-size:11px;line-height:1.45;overflow-wrap:anywhere}
    #${ROOT_ID} .asg-monitor-age{margin-top:4px;color:#15803d;font-size:11px}
    #${ROOT_ID} .asg-monitor-age.asg-stale{color:#b42318;font-weight:600}
    #${ROOT_ID} label{display:block;color:#475467;font-size:12px;margin:9px 0 5px}
    #${ROOT_ID} [data-availability-setting][hidden]{display:none !important}
    #${ROOT_ID} select,#${ROOT_ID} input[type=number],#${ROOT_ID} input[type=text]{width:100%;min-height:34px;border:1px solid #cfd5df;border-radius:6px;padding:6px 8px;background:#fff;color:#172033;font:inherit;transition:border-color .15s ease,box-shadow .15s ease}
    #${ROOT_ID} select:hover,#${ROOT_ID} input[type=number]:hover,#${ROOT_ID} input[type=text]:hover{border-color:#98a2b3}
    #${ROOT_ID} input[type=checkbox]{accent-color:#1456d9}
    #${ROOT_ID} .asg-key-details[hidden]{display:none}
    #${ROOT_ID} .asg-key-details{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 12px;margin-top:7px;padding:9px 10px;background:#f8fafc;border:1px solid #e4e7ec;border-radius:6px}
    #${ROOT_ID} .asg-key-detail{min-width:0}
    #${ROOT_ID} .asg-key-detail span{display:block;color:#667085;font-size:10px}
    #${ROOT_ID} .asg-key-detail strong{display:block;margin-top:1px;font-size:12px;line-height:1.35;overflow-wrap:anywhere}
    #${ROOT_ID} .asg-key-metric{color:#15803d}
    #${ROOT_ID} .asg-actions{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;margin-top:10px}
    #${ROOT_ID} .asg-actions button:last-child{flex:1;background:#1456d9;color:#fff;border-color:#1456d9}
    #${ROOT_ID} .asg-actions button:last-child:hover:not(:disabled){background:#0f46b6;border-color:#0f46b6}
    #${ROOT_ID} .asg-auto{display:flex;align-items:center;gap:6px;margin-top:9px;color:#475467}
    #${ROOT_ID} .asg-auto input{margin:0}
    #${ROOT_ID} .asg-guide{margin-top:8px;color:#475467;font-size:12px}
    #${ROOT_ID} .asg-guide ol{margin:6px 0 0;padding-left:20px}
    #${ROOT_ID} details{margin-top:9px;border-top:1px solid #e4e7ec;padding-top:7px}
    #${ROOT_ID} summary{cursor:pointer;color:#475467}
    #${ROOT_ID} .asg-side-head{position:sticky;top:-14px;z-index:1;display:flex;align-items:center;justify-content:space-between;min-height:46px;margin:-14px -16px 0;padding:7px 10px 7px 16px;background:#f8fafc;border-bottom:1px solid #e4e7ec}
    #${ROOT_ID} .asg-side-head strong{color:#344054;font-size:13px}
    #${ROOT_ID} .asg-side-close{display:grid;place-items:center;width:32px;height:32px;min-height:32px;border:0;padding:0;background:transparent;font-size:18px;line-height:1}
    #${ROOT_ID} .asg-side-view[hidden]{display:none}
    #${ROOT_ID} .asg-settings-body{margin-top:8px}
    #${ROOT_ID} .asg-settings-section{padding:9px 0}
    #${ROOT_ID} .asg-settings-section+.asg-settings-section{border-top:1px solid #eef0f3}
    #${ROOT_ID} .asg-settings-head{display:flex;align-items:baseline;gap:12px;margin-bottom:6px;min-width:0}
    #${ROOT_ID} .asg-settings-title{flex:none;color:#344054;font-size:12px;font-weight:700}
    #${ROOT_ID} .asg-settings-inline-label{min-width:0;margin:0;color:#475467;font-size:12px;line-height:1.3;overflow-wrap:anywhere}
    #${ROOT_ID} .asg-settings-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:9px 10px}
    #${ROOT_ID} .asg-settings-grid label{margin:0}
    #${ROOT_ID} .asg-settings-grid input[type=number],#${ROOT_ID} .asg-settings-grid input[type=text]{margin-top:3px}
    #${ROOT_ID} .asg-setting-wide{grid-column:1/-1}
    #${ROOT_ID} .asg-setting-compact{min-width:0}
    #${ROOT_ID} .asg-settings-grid .asg-auto{margin:1px 0 0}
    #${ROOT_ID} .asg-balance-setting{grid-column:1/-1}
    #${ROOT_ID} .asg-balance-preview,#${ROOT_ID} .asg-balance-reason,#${ROOT_ID} .asg-setting-preview{display:block;margin-top:4px;color:#15803d;font-size:11px;line-height:1.4;overflow-wrap:anywhere}
    #${ROOT_ID} .asg-preview-pending{color:#b54708}
    #${ROOT_ID} .asg-save{width:100%;margin-top:8px;background:#1456d9;color:#fff;border-color:#1456d9;font-weight:600}
    #${ROOT_ID} .asg-save:hover:not(:disabled){background:#0f46b6}
    #${ROOT_ID} .asg-log-actions{display:flex;justify-content:flex-end;margin-top:7px}
    #${ROOT_ID} .asg-logs{margin:6px 0 0;padding:0;list-style:none;border-top:1px solid #eef0f3}
    #${ROOT_ID} .asg-logs li{padding:5px 0;border-bottom:1px solid #eef0f3;font-size:11px;overflow-wrap:anywhere}
    #${ROOT_ID} .asg-logs .asg-log-error{color:#b42318}
    #${ROOT_ID} .asg-ranking{margin-top:11px;border-top:1px solid #e4e7ec}
    #${ROOT_ID} .asg-ranking-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:9px 0 6px}
    #${ROOT_ID} .asg-ranking-title{color:#344054;font-size:12px;font-weight:600}
    #${ROOT_ID} .asg-ranking-rule{min-width:0;color:#667085;font-size:10px;text-align:right;overflow-wrap:anywhere}
    #${ROOT_ID} .asg-list{margin:0;padding:0;list-style:none;max-height:min(240px,32vh);overflow:auto;border-top:1px solid #eef0f3;scrollbar-gutter:stable}
    #${ROOT_ID} .asg-list li{border-bottom:1px solid #eef0f3}
    #${ROOT_ID} .asg-list li.asg-candidate-best{background:#f4f8ff}
    #${ROOT_ID} .asg-candidate-locate{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;min-height:48px;padding:7px 4px;border:0;border-radius:0;background:transparent;color:inherit;text-align:left}
    #${ROOT_ID} .asg-candidate-locate:hover{background:#f8fafc!important}
    #${ROOT_ID} .asg-candidate-best .asg-candidate-locate{background:#f4f8ff}
    #${ROOT_ID} .asg-candidate-best .asg-candidate-locate:hover{background:#edf4ff!important}
    #${ROOT_ID} .asg-candidate-locate:focus-visible{outline:2px solid #1456d9;outline-offset:-2px}
    #${ROOT_ID} .asg-candidate-rank{color:#667085;font-size:11px;font-variant-numeric:tabular-nums}
    #${ROOT_ID} .asg-candidate-main{min-width:0}
    #${ROOT_ID} .asg-candidate-name-row{display:flex;align-items:center;gap:5px;min-width:0}
    #${ROOT_ID} .asg-candidate-name{min-width:0;overflow:hidden;color:#344054;font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
    #${ROOT_ID} .asg-candidate-badge{flex:none;color:#1456d9;font-size:10px;font-weight:600;white-space:nowrap}
    #${ROOT_ID} .asg-candidate-detail{margin-top:1px;overflow:hidden;color:#667085;font-size:10px;text-overflow:ellipsis;white-space:nowrap}
    #${ROOT_ID} .asg-candidate-signals{margin-top:1px;text-overflow:ellipsis;white-space:nowrap}
    #${ROOT_ID} .asg-candidate-signals .asg-provider-signal{font-size:9px}
    #${ROOT_ID} .asg-candidate-metrics{text-align:right;white-space:nowrap}
    #${ROOT_ID} .asg-candidate-price{display:block;color:#15803d;font-size:12px;font-weight:700}
    #${ROOT_ID} .asg-candidate-latency{display:block;margin-top:1px;color:#475467;font-size:10px}
    #${ROOT_ID} .asg-candidate-score{display:block;margin-top:1px;color:#1456d9;font-size:10px;font-weight:600}
    #${ROOT_ID} .asg-candidate-empty{padding:7px 3px;color:#667085;text-align:center}
    #${ROOT_ID} .asg-error{color:#b42318;background:#fff4f2;border-color:#fecdca}
    .dark #${ROOT_ID}{color:#f2f4f7;background:#101828;border-color:#344054;box-shadow:0 18px 48px rgba(0,0,0,.48)}
    .dark #${ROOT_ID} .asg-head,.dark #${ROOT_ID} .asg-side-column,.dark #${ROOT_ID} .asg-side-head{background:#182230;border-color:#344054}
    .dark #${ROOT_ID} .asg-head-title span{color:#d0d5dd;background:#344054}
    .dark #${ROOT_ID} .asg-head-tabs{background:#344054}
    .dark #${ROOT_ID} .asg-head-tab{color:#98a2b3;background:transparent;border-color:transparent}
    .dark #${ROOT_ID} .asg-head-tab:hover:not(:disabled){background:#475467}
    .dark #${ROOT_ID} .asg-head-tab[aria-selected=true]{color:#84adff;background:#101828;box-shadow:none}
    .dark #${ROOT_ID} button,.dark #${ROOT_ID} select,.dark #${ROOT_ID} input[type=number],.dark #${ROOT_ID} input[type=text]{color:#f2f4f7;background:#101828;border-color:#475467;color-scheme:dark}
    .dark #${ROOT_ID} button:hover:not(:disabled){background:#344054;border-color:#667085}
    .dark #${ROOT_ID} .asg-status-row,.dark #${ROOT_ID} .asg-key-details,.dark #${ROOT_ID} .asg-settings-section+.asg-settings-section,.dark #${ROOT_ID} details,.dark #${ROOT_ID} .asg-ranking,.dark #${ROOT_ID} .asg-list,.dark #${ROOT_ID} .asg-list li,.dark #${ROOT_ID} .asg-logs,.dark #${ROOT_ID} .asg-logs li{border-color:#344054}
    .dark #${ROOT_ID} .asg-key-details{background:#182230}
    .dark #${ROOT_ID} .asg-recommend{background:rgba(20,86,217,.2);border-color:#315c9d}
    .dark #${ROOT_ID} .asg-recommend.asg-recommend-stale{background:rgba(180,35,24,.18);border-color:#912018}
    .dark #${ROOT_ID} .asg-candidate-best,.dark #${ROOT_ID} .asg-candidate-best .asg-candidate-locate{background:rgba(20,86,217,.2)}
    .dark #${ROOT_ID} .asg-candidate-locate:hover,.dark #${ROOT_ID} .asg-candidate-best .asg-candidate-locate:hover{background:#1d2939!important}
    .dark #${ROOT_ID} .asg-muted,.dark #${ROOT_ID} .asg-status,.dark #${ROOT_ID} .asg-availability-summary,.dark #${ROOT_ID} .asg-availability-axis,.dark #${ROOT_ID} .asg-recommend-meta,.dark #${ROOT_ID} .asg-key-detail span,.dark #${ROOT_ID} .asg-ranking-rule,.dark #${ROOT_ID} .asg-candidate-rank,.dark #${ROOT_ID} .asg-candidate-detail,.dark #${ROOT_ID} .asg-candidate-empty{color:#98a2b3}
    .dark #${ROOT_ID} label,.dark #${ROOT_ID} summary,.dark #${ROOT_ID} .asg-auto,.dark #${ROOT_ID} .asg-settings-inline-label,.dark #${ROOT_ID} .asg-metrics,.dark #${ROOT_ID} .asg-candidate-latency{color:#d0d5dd}
    .dark #${ROOT_ID} .asg-candidate-score{color:#84adff}
    .dark #${ROOT_ID} .asg-side-head strong,.dark #${ROOT_ID} .asg-settings-title,.dark #${ROOT_ID} .asg-ranking-title,.dark #${ROOT_ID} .asg-candidate-name,.dark #${ROOT_ID} .asg-availability-title{color:#e4e7ec}
    .dark #${ROOT_ID} .asg-balance,.dark #${ROOT_ID} .asg-key-metric,.dark #${ROOT_ID} .asg-candidate-price,.dark #${ROOT_ID} .asg-monitor-age,.dark #${ROOT_ID} .asg-balance-preview,.dark #${ROOT_ID} .asg-balance-reason,.dark #${ROOT_ID} .asg-setting-preview{color:#6ce9a6}
    .dark #${ROOT_ID} .asg-save{color:#fff;background:#1456d9;border-color:#1456d9}
    .dark #${ROOT_ID} .asg-save:hover:not(:disabled){background:#2e6fe8;border-color:#2e6fe8}
    .dark #${ROOT_ID} .asg-error{color:#fda29b;background:rgba(180,35,24,.18);border-color:#912018}
    .dark #${ROOT_ID} .asg-status.asg-error{background:transparent;border-color:transparent}
    .dark #${ROOT_ID} .asg-signal-good{color:#6ce9a6}
    .dark #${ROOT_ID} .asg-signal-info{color:#84adff}
    .dark #${ROOT_ID} .asg-signal-warning{color:#fec84b}
    .dark #${ROOT_ID} .asg-signal-bad{color:#fda29b}
    .dark #${ROOT_ID} .asg-signal-muted{color:#98a2b3}
    .dark #${ROOT_ID} .asg-availability-guide{stroke:#475467}
    .dark #${ROOT_ID} .asg-availability-line{stroke:#98a2b3}
    .monitor-api-row.asg-provider-locate-target{background:#eaf1ff!important;outline:2px solid #1456d9;outline-offset:-2px}
    .decision-entry.asg-provider-locate-target{outline:2px solid #1456d9;outline-offset:-2px}
    .decision-entry.asg-provider-locate-target>.decision-row{background:#eaf1ff!important}
    .dark .monitor-api-row.asg-provider-locate-target{background:rgba(20,86,217,.18)!important;outline-color:#60a5fa}
    .dark .decision-entry.asg-provider-locate-target{outline-color:#60a5fa}
    .dark .decision-entry.asg-provider-locate-target>.decision-row{background:rgba(20,86,217,.18)!important}
    #${TOGGLE_ID}{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:2147483647;width:44px;height:44px;padding:0;border:1px solid #1456d9;border-radius:50%;background:#1456d9;color:#fff;box-shadow:0 8px 24px rgba(16,24,40,.2);font:700 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
    #${TOGGLE_ID}[hidden]{display:none}
    #${TOGGLE_ID}:hover{background:#0f46b6}
    @media (max-width:759px){
      #${ROOT_ID},#${ROOT_ID}[data-side-open=true]{width:min(360px,calc(100vw - 32px))}
      #${ROOT_ID} .asg-body{
        display:flex;
        flex-direction:column;
        overflow:auto;
        -webkit-overflow-scrolling:touch;
      }
      #${ROOT_ID} .asg-main-column,
      #${ROOT_ID} .asg-side-column{
        flex:0 0 auto;
        min-height:auto;
        overflow:visible;
      }
      #${ROOT_ID} .asg-side-column{
        border-top:1px solid #e4e7ec;
        border-left:0;
      }
      #${ROOT_ID} .asg-side-head{
        position:static;
        top:auto;
        z-index:auto;
        margin:-14px -16px 0;
      }
    }
    @media (max-width:399px){
      #${ROOT_ID} .asg-head{padding-left:12px}
      #${ROOT_ID} .asg-head-title span{display:none}
      #${ROOT_ID} .asg-head-actions{gap:2px}
      #${ROOT_ID} .asg-head-tab{padding-inline:7px}
    }
  `;

  const USAGE_STYLE = `
    .asg-usage-multiplier{margin-inline-start:6px;color:#15803d;font-weight:600;white-space:nowrap}
  `;

  const KEY_GROUP_STYLE = `
    .asg-key-group-option .asg-key-group-row{align-items:center!important;gap:10px}
    .asg-key-group-main{display:flex!important;flex:1 1 auto;flex-direction:row!important;align-items:center!important;gap:7px;min-width:0}
    .asg-key-group-main>.groupOptionItemBadge{min-width:0}
    .groupOptionItemBadge.asg-key-group-badge-available{color:#15803d!important;background:#ecfdf3!important}
    .groupOptionItemBadge.asg-key-group-badge-warning{color:#b54708!important;background:#fffaeb!important}
    .groupOptionItemBadge.asg-key-group-badge-unavailable,.groupOptionItemBadge.asg-key-group-badge-error{color:#b42318!important;background:#fff1f0!important}
    .groupOptionItemBadge.asg-key-group-badge-disabled{color:#667085!important;background:#f2f4f7!important}
    .asg-key-group-rate-shell{flex:0 0 auto;min-width:max-content;padding-top:0!important}
    .asg-key-group-rate{display:flex!important;flex-direction:row!important;align-items:center!important;gap:8px;white-space:nowrap}
    .asg-key-group-status,.asg-key-group-latency{display:inline-flex;flex:0 0 auto;align-items:center;margin:0;font-size:11px;line-height:1.25;white-space:nowrap}
    .asg-key-group-status{font-weight:600}
    .asg-key-group-status::before{display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:currentColor;content:"";vertical-align:1px}
    .asg-key-group-status-available{color:#15803d}
    .asg-key-group-status-warning{color:#b54708}
    .asg-key-group-status-unavailable,.asg-key-group-status-error{color:#b42318}
    .asg-key-group-status-disabled,.asg-key-group-status-unknown{color:#667085}
    .asg-key-group-latency{color:#667085;font-weight:500;text-align:right}
    .asg-key-group-latency-value{margin-left:3px;color:#15803d;font-weight:700}
    .dark .asg-key-group-status-available{color:#4ade80}
    .dark .asg-key-group-status-warning{color:#fbbf24}
    .dark .asg-key-group-status-unavailable,.dark .asg-key-group-status-error{color:#f87171}
    .dark .asg-key-group-status-disabled,.dark .asg-key-group-status-unknown,.dark .asg-key-group-latency{color:#98a2b3}
    .dark .asg-key-group-latency-value{color:#4ade80}
    .dark .groupOptionItemBadge.asg-key-group-badge-available{color:#4ade80!important;background:rgba(34,197,94,.12)!important}
    .dark .groupOptionItemBadge.asg-key-group-badge-warning{color:#fbbf24!important;background:rgba(245,158,11,.12)!important}
    .dark .groupOptionItemBadge.asg-key-group-badge-unavailable,.dark .groupOptionItemBadge.asg-key-group-badge-error{color:#f87171!important;background:rgba(239,68,68,.12)!important}
    .dark .groupOptionItemBadge.asg-key-group-badge-disabled{color:#98a2b3!important;background:rgba(152,162,179,.12)!important}
  `;

  function addStyle(css) {
    if (typeof GM_addStyle === 'function') GM_addStyle(css);
    else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  function formatPercent(value) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '-';
  }

  function formatLatency(value) {
    return Number.isFinite(value) ? `${Math.round(value)} ms` : '-';
  }

  function formatSmartScore(value) {
    return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)} 分` : '-';
  }

  function renderProviderSignals(row, compact = false) {
    const container = document.createElement('div');
    container.className = compact ? 'asg-candidate-signals' : 'asg-provider-signals';
    const signals = getProviderSignalSummary(row);
    for (const signal of signals) {
      const item = document.createElement('span');
      item.className = `asg-provider-signal asg-signal-${signal.tone}`;
      item.textContent = signal.label;
      container.appendChild(item);
    }
    container.title = signals.map((signal) => signal.label).join(' · ');
    return container;
  }

  class Controller {
    constructor(options = {}) {
      this.config = normalizeConfig(storageGet('config', DEFAULT_CONFIG));
      this.selectedKeyId = storageGet('selectedKeyId', null);
      this.lastSwitch = storageGet('lastSwitch', { at: null, keyId: null, groupId: null });
      this.stability = createStabilityState();
      this.rows = [];
      this.ranked = [];
      this.monitorSeries = null;
      this.keys = [];
      this.loading = false;
      this.lastUpdated = null;
      this.error = '';
      this.authError = '';
      this.balance = null;
      this.balanceError = '';
      this.keyCount = null;
      this.minimized = storageGet('minimized', false) === true;
      this.sideTab = normalizePanelTab(storageGet('sideTab', 'settings'));
      this.sideOpen = false;
      this.timer = null;
      this.uiTimer = null;
      this.providerLocateTimer = null;
      this.providerRefreshTimer = null;
      this.providerRefreshLoading = false;
      this.providerRefreshStartedAt = 0;
      this.providerRefreshSawBusy = false;
      this.panel = null;
      this.toggleButton = null;
      this.active = false;
      this.monitorGeneratedAt = null;
      this.monitorFreshness = getMonitorFreshness(null, Date.now(), this.config.maxMonitorAgeSeconds);
      this.candidateDiagnostics = analyzeCandidates([], this.config);
      this.lastKeysFetchedAt = 0;
      this.lastDetectionLogSignature = null;
      this.lastMonitorStaleLogState = null;
      this.lastAuthLogSignature = '';
      this.lastErrorLogSignature = '';
      this.lastAutoSkipLogSignature = '';
      this.onAuthInvalid = typeof options.onAuthInvalid === 'function' ? options.onAuthInvalid : null;
    }

    start(registerMenu = true) {
      this.active = true;
      const existing = document.getElementById(ROOT_ID);
      if (existing?.dataset.version === SCRIPT_VERSION) return;
      existing?.remove();
      document.getElementById(TOGGLE_ID)?.remove();
      addStyle(STYLE);
      this.renderShell();
      this.bindEvents();
      if (registerMenu && typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('显示 AIHub 智能分组', () => this.setMinimized(false));
      this.refresh();
      this.timer = window.setInterval(() => this.refresh(), this.config.pollIntervalSeconds * 1000);
      this.uiTimer = window.setInterval(() => this.renderTimeSensitiveState(), 1000);
      this.resumePendingProviderLocation();
    }

    stop() {
      this.active = false;
      if (this.timer) window.clearInterval(this.timer);
      if (this.uiTimer) window.clearInterval(this.uiTimer);
      if (this.providerLocateTimer) window.clearTimeout(this.providerLocateTimer);
      if (this.providerRefreshTimer) window.clearTimeout(this.providerRefreshTimer);
      this.timer = null;
      this.uiTimer = null;
      this.providerLocateTimer = null;
      this.providerRefreshTimer = null;
      document.querySelector('.asg-provider-locate-target')?.classList.remove('asg-provider-locate-target');
      this.panel?.remove();
      this.toggleButton?.remove();
      this.panel = null;
      this.toggleButton = null;
    }

    renderShell() {
      const panel = document.createElement('section');
      panel.id = ROOT_ID;
      panel.dataset.version = SCRIPT_VERSION;
      panel.innerHTML = `
        <div class="asg-head">
          <div class="asg-head-title"><strong>AIHub 智能分组</strong><span>v${SCRIPT_VERSION}</span></div>
          <div class="asg-head-actions">
            <div class="asg-head-tabs" role="tablist" aria-label="面板工具">
              <button type="button" class="asg-head-tab" role="tab" id="asg-settings-tab" aria-controls="asg-settings-view" aria-selected="false" aria-expanded="false" data-panel-tab="settings">设置</button>
              <button type="button" class="asg-head-tab" role="tab" id="asg-logs-tab" aria-controls="asg-logs-view" aria-selected="false" aria-expanded="false" data-panel-tab="logs">日志</button>
            </div>
            <button class="asg-icon" data-action="minimize" title="最小化" aria-label="最小化面板">−</button>
          </div>
        </div>
        <div class="asg-body">
          <div class="asg-main-column">
            <div class="asg-status-row"><div class="asg-status" data-field="status">准备检测</div><div class="asg-balance" data-field="balance">余额读取中...</div></div>
            <label for="asg-mode-select">模式</label>
            <select id="asg-mode-select" data-field="mode"><option value="price">价格（最低价格）</option><option value="balance">平衡（倍率上限内首 Token 最快）</option><option value="speed">速度（最快首字）</option><option value="smart">智能（倍率上限内综合评分）</option></select>
            <div class="asg-recommend" data-field="recommend"><div class="asg-muted">正在读取监控数据...</div></div>
            <label for="asg-key-select">目标密钥</label>
            <select id="asg-key-select" data-field="key"></select>
            <div class="asg-key-details" data-field="key-details" hidden>
              <div class="asg-key-detail"><span>密钥名</span><strong data-key-detail="name"></strong></div>
              <div class="asg-key-detail"><span>当前分组</span><strong data-key-detail="group"></strong></div>
              <div class="asg-key-detail"><span>倍率</span><strong class="asg-key-metric" data-key-detail="multiplier"></strong></div>
              <div class="asg-key-detail"><span>最新首 Token</span><strong class="asg-key-metric" data-key-detail="latency"></strong></div>
            </div>
            <div class="asg-actions"><button data-action="refresh">检测</button><button data-action="switch" disabled>切换到推荐分组</button></div>
            <label class="asg-auto"><input type="checkbox" data-field="auto"> 自动切换（默认关闭）</label>
            <details class="asg-guide"><summary>快速开始</summary><ol><li>选择价格、平衡、速度或智能模式。</li><li>选择目标密钥并点击“检测”。</li><li>确认推荐分组后点击切换；自动切换可在设置中开启。</li></ol></details>
            <section class="asg-ranking" aria-labelledby="asg-ranking-title"><div class="asg-ranking-head"><span class="asg-ranking-title" id="asg-ranking-title">推荐排序</span><span class="asg-ranking-rule" data-field="ranking-rule"></span></div><ol class="asg-list" data-field="list"></ol></section>
          </div>
          <aside class="asg-side-column" id="asg-side-column" aria-label="设置与日志" hidden>
            <div class="asg-side-head"><strong data-field="side-title">设置</strong><button type="button" class="asg-side-close" data-action="close-side" title="关闭侧栏" aria-label="关闭侧栏">×</button></div>
            <section class="asg-side-view" id="asg-settings-view" role="tabpanel" aria-labelledby="asg-settings-tab" data-panel-view="settings">
              <div class="asg-settings-body">
              <section class="asg-settings-section">
                <div class="asg-settings-head"><div class="asg-settings-title">可靠性筛选</div><label class="asg-settings-inline-label" for="asg-availability-mode-setting">可用性判断方式</label></div>
                <div class="asg-settings-grid">
                  <select id="asg-availability-mode-setting" data-setting="availabilityMode"><option value="percent">按可用率（百分比）</option><option value="successes">按成功监控点数</option><option value="consecutive">按连续成功点数</option></select>
                  <label class="asg-setting-compact asg-auto"><input type="checkbox" data-setting="requireNoWarnings"> 排除监控警告</label>
                  <label class="asg-setting-wide" data-availability-setting="percent" title="可自行修改，0.1 表示 10%">最近10分钟最低可用率（默认10%）<input type="number" min="0" max="1" step="0.01" data-setting="minSuccess10m"></label>
                  <label class="asg-setting-wide" data-availability-setting="successes">最近10分钟至少成功监控点数<input type="number" min="1" max="60" step="1" data-setting="minSuccessPoints10m"></label>
                  <label class="asg-setting-wide" data-availability-setting="consecutive">连续成功监控点数<input type="number" min="1" max="60" step="1" data-setting="minConsecutiveSuccesses10m"></label>
                  <label class="asg-setting-wide" title="名称包含任一关键词的分组不会参与推荐或切换">排除分组关键词（使用 | 分隔）<input type="text" data-setting="excludedGroupKeywords" placeholder="例如 free|unstable"></label>
                  <span class="asg-setting-preview asg-setting-wide" data-field="excluded-preview" aria-live="polite"></span>
                </div>
              </section>
              <section class="asg-settings-section">
                <div class="asg-settings-title">模型与缓存</div>
                <div class="asg-settings-grid">
                  <label>目标模型<select data-setting="targetModel"><option value="any">全部模型</option><option value="sol">Sol</option><option value="terra">Terra</option><option value="luna">Luna</option></select></label>
                  <label>模型检测策略<select data-setting="modelDetectionPolicy"><option value="observe">观察（不筛选）</option><option value="standard">标准（排除存疑/失败）</option><option value="strict">严格（只要通过且未过期）</option></select></label>
                  <label class="asg-setting-wide" title="0 表示不按缓存命中率筛选">最低缓存命中率（0–1）<input type="number" min="0" max="1" step="0.01" data-setting="minCacheHitRate"></label>
                </div>
              </section>
              <section class="asg-settings-section">
                <div class="asg-settings-title">检测与切换</div>
                <div class="asg-settings-grid">
                  <label>连续通过次数<input type="number" min="1" max="5" step="1" data-setting="consecutiveChecks"></label>
                  <label>检测间隔（秒）<input type="number" min="10" max="3600" step="1" data-setting="pollIntervalSeconds"></label>
                  <label class="asg-setting-wide">切换冷却（分钟）<input type="number" min="0" max="1440" step="0.1" data-setting="cooldownMinutes"><span class="asg-setting-preview" data-field="cooldown-preview" aria-live="polite"></span></label>
                </div>
              </section>
              <section class="asg-settings-section">
                <div class="asg-settings-head"><div class="asg-settings-title">倍率上限策略</div><label class="asg-settings-inline-label" for="asg-balance-max-setting">允许切换的最高倍率</label></div>
                <div class="asg-settings-grid">
                  <label class="asg-balance-setting"><input id="asg-balance-max-setting" type="number" min="0" max="1000" step="0.001" data-setting="balanceMaxPrice" aria-label="允许切换的最高倍率"><span class="asg-balance-preview" data-field="balance-preview" aria-live="polite"></span></label>
                </div>
              </section>
              <button class="asg-save" data-action="save-settings">保存设置</button>
              </div>
            </section>
            <section class="asg-side-view" id="asg-logs-view" role="tabpanel" aria-labelledby="asg-logs-tab" data-panel-view="logs" hidden>
              <div class="asg-log-actions"><button data-action="clear-logs">清空日志</button></div>
              <ul class="asg-logs" data-field="logs"></ul>
            </section>
          </aside>
        </div>`;
      document.body.appendChild(panel);
      this.panel = panel;
      const toggle = document.createElement('button');
      toggle.id = TOGGLE_ID;
      toggle.type = 'button';
      toggle.textContent = 'AI';
      toggle.title = '打开 AIHub 智能分组';
      toggle.setAttribute('aria-label', '打开 AIHub 智能分组');
      document.body.appendChild(toggle);
      this.toggleButton = toggle;
      this.setSideTab(this.sideTab);
      this.setSideOpen(false);
      this.syncSettingsInputs();
      this.setMinimized(this.minimized);
    }

    bindEvents() {
      this.panel.addEventListener('click', (event) => {
        const panelTab = event.target.closest('[data-panel-tab]')?.dataset.panelTab;
        if (panelTab) {
          const nextSide = toggleSidePanelState(this.sideOpen, this.sideTab, panelTab);
          this.setSideTab(nextSide.tab);
          this.setSideOpen(nextSide.open);
        }
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'minimize') this.setMinimized(true);
        if (action === 'close-side') {
          this.setSideOpen(false);
          this.panel.querySelector(`[data-panel-tab="${this.sideTab}"]`)?.focus();
        }
        if (action === 'refresh') this.runManualDetection();
        if (action === 'switch') this.switchToRecommendation(false);
        if (action === 'save-settings') this.saveSettings();
        if (action === 'clear-logs') this.clearLogs();
        if (action === 'locate-provider') {
          const button = event.target.closest('[data-action="locate-provider"]');
          this.navigateToProviderCandidate(button?.dataset.groupName);
        }
      });
      this.panel.querySelector('[role="tablist"]').addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const tabs = [...this.panel.querySelectorAll('[data-panel-tab]')];
        const currentIndex = tabs.indexOf(document.activeElement);
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const nextTab = tabs[(currentIndex + direction + tabs.length) % tabs.length];
        this.setSideTab(nextTab.dataset.panelTab);
        this.setSideOpen(true);
        nextTab.focus();
      });
      this.panel.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !this.sideOpen) return;
        this.setSideOpen(false);
        this.panel.querySelector(`[data-panel-tab="${this.sideTab}"]`)?.focus();
      });
      this.toggleButton.addEventListener('click', () => this.setMinimized(false));
      this.panel.querySelector('[data-field="key"]').addEventListener('change', (event) => {
        this.selectedKeyId = event.target.value || null;
        storageSet('selectedKeyId', this.selectedKeyId);
        this.renderSelectedKeyDetails();
        this.renderActionState();
      });
      this.panel.querySelector('[data-field="mode"]').addEventListener('change', (event) => {
        this.config.mode = normalizeGroupMode(event.target.value);
        storageSet('config', this.config);
        this.log('info', `模式改为${GROUP_MODE_LABELS[this.config.mode]}`);
        this.refresh();
      });
      this.panel.querySelector('[data-field="auto"]').addEventListener('change', (event) => {
        if (event.target.checked && !window.confirm('自动切换会在检测通过后修改选中 API 密钥的分组，是否启用？')) {
          event.target.checked = false;
          return;
        }
        this.config.autoSwitch = event.target.checked;
        storageSet('config', this.config);
        this.log('info', event.target.checked ? '已开启自动切换' : '已关闭自动切换');
        this.refresh();
      });
      this.panel.addEventListener('input', (event) => {
        if (event.target.matches('[data-setting]')) this.renderSettingsPreviews();
      });
      this.panel.addEventListener('change', (event) => {
        if (event.target.matches('[data-setting="availabilityMode"]')) {
          this.syncAvailabilityInputs();
          this.renderSettingsPreviews();
        }
      });
    }

    setMinimized(value) {
      this.minimized = value === true;
      if (this.panel) this.panel.hidden = this.minimized;
      if (this.toggleButton) this.toggleButton.hidden = !this.minimized;
      storageSet('minimized', this.minimized);
    }

    setSideTab(value) {
      this.sideTab = normalizePanelTab(value);
      storageSet('sideTab', this.sideTab);
      this.renderSidePanelState();
    }

    setSideOpen(value) {
      this.sideOpen = value === true;
      this.renderSidePanelState();
    }

    renderSidePanelState() {
      if (!this.panel) return;
      this.panel.dataset.sideOpen = String(this.sideOpen);
      const side = this.panel.querySelector('.asg-side-column');
      if (side) side.hidden = !this.sideOpen;
      for (const tab of this.panel?.querySelectorAll('[data-panel-tab]') || []) {
        const current = tab.dataset.panelTab === this.sideTab;
        const selected = this.sideOpen && current;
        tab.setAttribute('aria-selected', String(selected));
        tab.setAttribute('aria-expanded', String(selected));
        tab.tabIndex = current ? 0 : -1;
      }
      for (const view of this.panel?.querySelectorAll('[data-panel-view]') || []) {
        view.hidden = !this.sideOpen || view.dataset.panelView !== this.sideTab;
      }
      const title = this.panel.querySelector('[data-field="side-title"]');
      if (title) title.textContent = this.sideTab === 'logs' ? '运行日志' : '设置';
    }

    syncSettingsInputs() {
      for (const input of this.panel.querySelectorAll('[data-setting]')) {
        const key = input.dataset.setting;
        if (input.type === 'checkbox') input.checked = this.config[key] === true;
        else input.value = this.config[key];
      }
      this.panel.querySelector('[data-field="auto"]').checked = this.config.autoSwitch;
      this.panel.querySelector('[data-field="mode"]').value = this.config.mode;
      this.syncAvailabilityInputs();
      this.renderSettingsPreviews();
    }

    syncAvailabilityInputs() {
      const mode = normalizeAvailabilityMode(this.panel?.querySelector('[data-setting="availabilityMode"]')?.value);
      for (const field of this.panel?.querySelectorAll('[data-availability-setting]') || []) {
        field.hidden = field.dataset.availabilitySetting !== mode;
      }
    }

    readDraftConfig() {
      const draft = { ...this.config };
      for (const input of this.panel?.querySelectorAll('[data-setting]') || []) {
        draft[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.value;
      }
      return normalizeConfig(draft);
    }

    renderSettingsPreviews() {
      this.renderBalancePreview();
      this.renderExcludedPreview();
      this.renderCooldownPreview();
    }

    renderBalancePreview() {
      const preview = this.panel?.querySelector('[data-field="balance-preview"]');
      const maxPriceInput = this.panel?.querySelector('[data-setting="balanceMaxPrice"]');
      if (!preview || !maxPriceInput) return;
      const rawMaxPrice = maxPriceInput.value.trim();
      if (rawMaxPrice === '' || !maxPriceInput.checkValidity()) {
        preview.textContent = '请输入 0–1000 之间的倍率';
        preview.classList.add('asg-preview-pending');
        return;
      }
      const normalizedDraft = this.readDraftConfig();
      const candidateCount = getEligibleCandidates(this.rows, normalizedDraft)
        .filter((candidate) => candidate.price <= normalizedDraft.balanceMaxPrice).length;
      const hasUnsavedFilter = normalizedDraft.balanceMaxPrice !== this.config.balanceMaxPrice
        || normalizedDraft.minSuccess10m !== this.config.minSuccess10m
        || normalizedDraft.availabilityMode !== this.config.availabilityMode
        || normalizedDraft.minSuccessPoints10m !== this.config.minSuccessPoints10m
        || normalizedDraft.minConsecutiveSuccesses10m !== this.config.minConsecutiveSuccesses10m
        || normalizedDraft.requireNoWarnings !== this.config.requireNoWarnings
        || normalizedDraft.excludedGroupKeywords !== this.config.excludedGroupKeywords
        || normalizedDraft.targetModel !== this.config.targetModel
        || normalizedDraft.modelDetectionPolicy !== this.config.modelDetectionPolicy
        || normalizedDraft.minCacheHitRate !== this.config.minCacheHitRate;
      const suffix = hasUnsavedFilter ? ' · 未保存' : '';
      const limit = formatMultiplier(normalizedDraft.balanceMaxPrice);
      if (!this.lastUpdated) {
        preview.textContent = `最高倍率 ${limit} · 检测后显示符合分组${suffix}`;
      } else if (candidateCount === 0) {
        preview.textContent = `最高倍率 ${limit} · 当前没有符合条件的分组${suffix}`;
      } else {
        const rankingText = normalizedDraft.mode === 'smart' ? '将按综合评分排序' : '将选首 Token 最快';
        preview.textContent = `只考虑倍率 ≤ ${limit} · ${candidateCount} 个分组可选 · ${rankingText}${suffix}`;
      }
      preview.classList.toggle('asg-preview-pending', hasUnsavedFilter);
    }

    renderExcludedPreview() {
      const preview = this.panel?.querySelector('[data-field="excluded-preview"]');
      const input = this.panel?.querySelector('[data-setting="excludedGroupKeywords"]');
      if (!preview || !input) return;
      const info = getExcludedGroupInfo(this.rows, input.value);
      const normalized = info.keywords.join('|');
      const unsaved = normalized !== this.config.excludedGroupKeywords;
      const suffix = unsaved ? ' · 未保存' : '';
      if (!info.keywords.length) {
        preview.textContent = `未设置排除关键词${suffix}`;
      } else if (!this.lastUpdated) {
        preview.textContent = `${info.keywords.length} 个关键词 · 检测后显示匹配分组${suffix}`;
      } else if (!info.matches.length) {
        preview.textContent = `未匹配到分组${suffix}`;
      } else {
        const names = info.matches.slice(0, 3).map((match) => match.name).join('、');
        const more = info.matches.length > 3 ? ` 等 ${info.matches.length} 个` : '';
        preview.textContent = `将排除 ${info.matches.length} 个：${names}${more}${suffix}`;
      }
      preview.classList.toggle('asg-preview-pending', unsaved);
    }

    renderCooldownPreview() {
      const preview = this.panel?.querySelector('[data-field="cooldown-preview"]');
      const input = this.panel?.querySelector('[data-setting="cooldownMinutes"]');
      if (!preview || !input) return;
      if (input.value.trim() === '' || !input.checkValidity()) {
        preview.textContent = '请输入 0–1440 之间的分钟数';
        preview.classList.add('asg-preview-pending');
        return;
      }
      const minutes = normalizeConfig({ ...this.config, cooldownMinutes: input.value }).cooldownMinutes;
      const unsaved = minutes !== this.config.cooldownMinutes;
      const cooldown = getCooldownInfo(Number(this.lastSwitch.at), minutes);
      preview.textContent = `${minutes} 分钟 = ${formatRemainingTime(minutes * 60 * 1000)}${cooldown.active ? ` · 当前${cooldown.label}` : ''}${unsaved ? ' · 未保存' : ''}`;
      preview.classList.toggle('asg-preview-pending', unsaved);
    }

    saveSettings() {
      const next = {};
      for (const input of this.panel.querySelectorAll('[data-setting]')) {
        next[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.value;
      }
      next.autoSwitch = this.config.autoSwitch;
      next.mode = this.config.mode;
      this.config = normalizeConfig(next);
      storageSet('config', this.config);
      this.syncSettingsInputs();
      if (this.timer) window.clearInterval(this.timer);
      this.timer = window.setInterval(() => this.refresh(), this.config.pollIntervalSeconds * 1000);
      this.setStatus('设置已保存');
      this.log('info', '设置已保存');
      this.refresh(true);
    }

    log(level, message) {
      writeRuntimeLog('aihub', level, message);
      this.renderLogs();
    }

    clearLogs() {
      storageSet('runtime-logs', storageGet('runtime-logs', []).filter((entry) => entry?.scope !== 'aihub'));
      this.renderLogs();
    }

    renderLogs() {
      const list = this.panel?.querySelector('[data-field="logs"]');
      if (!list) return;
      list.replaceChildren();
      const logs = readScopeLogs('aihub');
      if (!logs.length) {
        const empty = document.createElement('li');
        empty.className = 'asg-muted';
        empty.textContent = '暂无日志';
        list.appendChild(empty);
        return;
      }
      for (const entry of logs) {
        const item = document.createElement('li');
        item.className = `asg-log-${entry.level}`;
        item.textContent = formatLogLine(entry);
        list.appendChild(item);
      }
    }

    async refresh(forceLog = false) {
      if (this.loading) return;
      this.loading = true;
      this.authError = '';
      this.setStatus('检测中...');
      this.renderActionState();
      try {
        const [summary, series, balanceResult] = await Promise.all([
          fetchMonitorSummary(),
          fetchMonitorSeries(),
          fetchCurrentBalance().then((payload) => ({ payload })).catch((error) => ({ error })),
        ]);
        if (!this.active) return;
        if (balanceResult.error) {
          this.balanceError = balanceResult.error instanceof Error ? balanceResult.error.message : '余额读取失败';
        } else {
          this.balance = getBalanceAmount(balanceResult.payload);
          this.balanceError = this.balance === null ? '余额数据格式异常' : '';
        }
        let keys = null;
        if (shouldRefreshKeys({ now: Date.now(), lastFetchedAt: this.lastKeysFetchedAt, keyCount: this.keys.length, force: forceLog })) {
          try {
            keys = await fetchAllKeys();
            if (!this.active) return;
            this.lastKeysFetchedAt = Date.now();
          } catch (error) {
            if (!this.active) return;
            if (error?.status === 401 && this.onAuthInvalid) {
              this.onAuthInvalid();
              if (!this.active) return;
            }
            this.authError = error?.status === 401
              ? (getAuthToken() ? '密钥接口返回 401：当前登录已失效，请重新登录后刷新' : '未找到页面登录令牌，请在此 Chrome 配置中重新登录后刷新')
              : (error instanceof Error ? `密钥读取失败：${error.message}` : '密钥读取失败');
          }
        }
        if (this.authError && shouldLogTransition(this.lastAuthLogSignature, this.authError, forceLog)) {
          this.log('error', this.authError);
        } else if (!this.authError && this.lastAuthLogSignature) {
          this.log('info', '密钥读取已恢复');
        }
        this.lastAuthLogSignature = this.authError;
        this.monitorSeries = series;
        this.rows = attachRecentAvailability(summary?.apis, series);
        this.monitorGeneratedAt = getLatestMonitorSampleAt(series) || series?.generatedAt || summary?.generatedAt || null;
        this.updateMonitorFreshness();
        this.recordMonitorFreshnessState();
        this.candidateDiagnostics = analyzeCandidates(this.rows, this.config);
        this.ranked = rankCandidates(this.rows, this.config);
        const winner = this.ranked[0] || null;
        this.stability = this.monitorFreshness.stale
          ? createStabilityState()
          : advanceStability(this.stability, winner?.groupId ?? null, this.config.consecutiveChecks);
        if (keys) {
          this.keys = keys;
          this.keyCount = keys.length;
          if (!this.keys.some((key) => String(key.id) === String(this.selectedKeyId))) {
            this.selectedKeyId = this.keys.length === 1 ? this.keys[0].id : null;
            storageSet('selectedKeyId', this.selectedKeyId);
          }
        }
        this.lastUpdated = new Date();
        this.error = '';
        this.renderData();
        const detectionSignature = `${this.config.mode}:${winner?.groupId ?? 'none'}`;
        if (shouldLogTransition(this.lastDetectionLogSignature, detectionSignature, forceLog)) {
          this.log('info', `检测完成，推荐${winner?.name || '暂无分组'}`);
        }
        this.lastDetectionLogSignature = detectionSignature;
        if (this.lastErrorLogSignature) this.log('info', '监控检测已恢复');
        this.lastErrorLogSignature = '';
        if (this.config.autoSwitch) await this.switchToRecommendation(true);
      } catch (error) {
        if (!this.active) return;
        this.error = error instanceof Error ? error.message : '检测失败';
        if (shouldLogTransition(this.lastErrorLogSignature, this.error, forceLog)) this.log('error', this.error);
        this.lastErrorLogSignature = this.error;
        this.setStatus(this.error, true);
        this.renderActionState();
      } finally {
        this.loading = false;
        if (this.active) this.renderActionState();
      }
    }

    updateMonitorFreshness() {
      this.monitorFreshness = getMonitorFreshness(this.monitorGeneratedAt, Date.now(), this.config.maxMonitorAgeSeconds);
      return this.monitorFreshness;
    }

    renderTimeSensitiveState() {
      if (!this.active || !this.panel) return;
      const wasStale = this.monitorFreshness.stale;
      this.updateMonitorFreshness();
      if (!wasStale && this.monitorFreshness.stale) this.stability = createStabilityState();
      this.recordMonitorFreshnessState();
      this.panel.querySelector('[data-field="recommend"]')?.classList.toggle('asg-recommend-stale', this.monitorFreshness.stale);
      const node = this.panel.querySelector('[data-field="monitor-freshness"]');
      if (node) {
        node.textContent = this.monitorFreshness.stale
          ? `监控数据已过期（${this.monitorFreshness.label}），切换已暂停`
          : `数据更新于 ${this.monitorFreshness.label}`;
        node.classList.toggle('asg-stale', this.monitorFreshness.stale);
      }
      this.renderCooldownPreview();
      this.renderActionState();
    }

    recordMonitorFreshnessState() {
      if (!this.monitorGeneratedAt || this.lastMonitorStaleLogState === this.monitorFreshness.stale) return;
      if (this.monitorFreshness.stale) {
        this.log('error', `监控数据已超过 10 分钟未更新（${this.monitorFreshness.label}），已暂停切换`);
      } else if (this.lastMonitorStaleLogState === true) {
        this.log('info', '监控数据已恢复，切换保护解除');
      }
      this.lastMonitorStaleLogState = this.monitorFreshness.stale;
    }

    selectedKey() {
      return this.keys.find((key) => String(key.id) === String(this.selectedKeyId)) || null;
    }

    async switchToRecommendation(fromAuto) {
      const winner = this.ranked[0];
      const key = this.selectedKey();
      const blockReason = getSwitchBlockReason({
        loading: this.loading,
        allowWhileLoading: fromAuto,
        error: this.error,
        authError: this.authError,
        monitorStale: this.monitorFreshness.stale,
        monitorFreshnessText: this.monitorFreshness.label,
        winner,
        key,
        stability: this.stability,
        requiredChecks: this.config.consecutiveChecks,
      });
      if (blockReason) {
        if (fromAuto) {
          if (shouldLogTransition(this.lastAutoSkipLogSignature, blockReason)) this.log('info', `自动切换跳过：${blockReason}`);
          this.lastAutoSkipLogSignature = blockReason;
        } else {
          this.setStatus(blockReason, Boolean(this.error || this.authError));
        }
        return false;
      }
      const now = Date.now();
      if (fromAuto && !canAutoSwitch({
        now,
        lastSwitchAt: Number(this.lastSwitch.at),
        currentGroupId: key.groupId,
        targetGroupId: winner.groupId,
        stable: this.stability.stable,
        config: this.config,
        monitorStale: this.monitorFreshness.stale,
        monitorFreshnessText: this.monitorFreshness.label,
      })) {
        const reason = getAutoSwitchBlockReason({
          now,
          lastSwitchAt: Number(this.lastSwitch.at),
          currentGroupId: key.groupId,
          targetGroupId: winner.groupId,
          stable: this.stability.stable,
          config: this.config,
          monitorStale: this.monitorFreshness.stale,
          monitorFreshnessText: this.monitorFreshness.label,
        });
        if (shouldLogTransition(this.lastAutoSkipLogSignature, reason)) this.log('info', `自动切换跳过：${reason}`);
        this.lastAutoSkipLogSignature = reason;
        return false;
      }
      if (!fromAuto && !window.confirm(`将密钥“${key.name}”切换到 ${winner.name}（${winner.price}x），是否继续？`)) return false;
      try {
        await updateKeyGroup(key.id, winner.groupId);
        if (!this.active) return false;
        key.groupId = winner.groupId;
        key.groupName = winner.name;
        this.lastKeysFetchedAt = 0;
        this.lastSwitch = { at: Date.now(), keyId: key.id, groupId: winner.groupId };
        this.lastAutoSkipLogSignature = '';
        storageSet('lastSwitch', this.lastSwitch);
        this.setStatus(`已切换到 ${winner.name}`);
        this.log('info', `已切换到${winner.name}`);
        this.renderData();
        return true;
      } catch (error) {
        if (!this.active) return false;
        this.setStatus(error instanceof Error ? error.message : '切换失败', true);
        this.log('error', error instanceof Error ? error.message : '切换失败');
        return false;
      }
    }

    setStatus(text, error = false) {
      const node = this.panel?.querySelector('[data-field="status"]');
      if (node) {
        node.textContent = text;
        node.classList.toggle('asg-error', error);
      }
    }

    renderData() {
      const winner = this.ranked[0];
      const recommend = this.panel.querySelector('[data-field="recommend"]');
      recommend.classList.toggle('asg-recommend-stale', this.monitorFreshness.stale);
      recommend.replaceChildren();
      if (!winner) {
        const empty = document.createElement('div');
        empty.className = 'asg-muted';
        empty.textContent = this.config.mode === 'balance' || this.config.mode === 'smart'
          ? '没有符合当前可靠性和倍率上限的分组'
          : '没有符合当前可靠性条件的分组';
        recommend.appendChild(empty);
      } else {
        const title = document.createElement('strong');
        title.textContent = `${GROUP_MODE_LABELS[this.config.mode]}模式 · ${winner.name} · ${winner.price}x`;
        const metrics = document.createElement('div');
        metrics.className = 'asg-metrics';
        const availabilityText = this.config.availabilityMode === 'successes'
          ? `成功 ${winner.recentSuccessCount || 0}/${winner.recentSampleCount || 0} 点`
          : this.config.availabilityMode === 'consecutive'
            ? `连续成功 ${winner.recentConsecutiveSuccessCount || 0} 点`
            : `可用率 ${formatPercent(winner.success10m)}`;
        metrics.textContent = `10m ${availabilityText} · ${winner.recentSampleCount}次探测 · 首Token ${formatLatency(winner.latency)}${this.config.mode === 'smart' ? ` · 综合评分 ${formatSmartScore(winner.smartScore)}` : ''}${this.stability.stable ? ' · 已稳定' : ` · ${this.stability.count}/${this.config.consecutiveChecks} 次`}`;
        recommend.append(title, metrics, renderProviderSignals(winner), renderAvailabilityChart(this.monitorSeries, winner.id, winner.name));
        if (this.config.mode === 'balance' || this.config.mode === 'smart') {
          const reason = document.createElement('div');
          reason.className = 'asg-balance-reason';
          reason.textContent = this.config.mode === 'smart'
            ? `倍率上限 ${formatMultiplier(this.config.balanceMaxPrice)} · 范围内综合评分最高`
            : `倍率上限 ${formatMultiplier(this.config.balanceMaxPrice)} · 范围内首 Token 最快`;
          recommend.appendChild(reason);
        }
      }
      const diagnostics = this.candidateDiagnostics?.counts || {};
      const diagnostic = document.createElement('div');
      diagnostic.className = 'asg-recommend-meta';
      const overLimit = this.config.mode === 'balance' || this.config.mode === 'smart' ? Math.max(0, Number(diagnostics.eligible || 0) - this.ranked.length) : 0;
      diagnostic.textContent = `参与比较 ${this.ranked.length} · 排除关键词 ${diagnostics.keywords || 0} · 不可用 ${diagnostics.unavailable || 0} · 可用率不足 ${diagnostics.lowSuccess || 0} · 监控警告 ${diagnostics.warnings || 0} · 模型健康 ${diagnostics.modelHealth || 0} · 模型检测 ${diagnostics.modelDetection || 0} · 缓存不足 ${diagnostics.cache || 0}${overLimit ? ` · 超过倍率上限 ${overLimit}` : ''}`;
      recommend.appendChild(diagnostic);
      const freshness = document.createElement('div');
      freshness.className = `asg-monitor-age${this.monitorFreshness.stale ? ' asg-stale' : ''}`;
      freshness.dataset.field = 'monitor-freshness';
      freshness.textContent = this.monitorFreshness.stale
        ? `监控数据已过期（${this.monitorFreshness.label}），切换已暂停`
        : `数据更新于 ${this.monitorFreshness.label}`;
      recommend.appendChild(freshness);
      this.renderBalance();
      const keyInfo = this.authError || (this.keyCount !== null ? `已读取 ${this.keyCount} 个密钥` : '');
      this.setStatus(this.error || keyInfo || (this.lastUpdated ? `最近检测：${this.lastUpdated.toLocaleTimeString()}` : '准备检测'), Boolean(this.error || this.authError));
      this.renderKeys();
      this.renderCandidates();
      this.renderLogs();
      this.renderActionState();
      this.renderSettingsPreviews();
    }

    renderBalance() {
      const node = this.panel?.querySelector('[data-field="balance"]');
      if (!node) return;
      node.classList.toggle('asg-balance-error', Boolean(this.balanceError));
      node.textContent = this.balanceError ? '余额暂不可用' : `余额 ${formatBalance(this.balance)}`;
      node.title = this.balanceError ? this.balanceError : '每次检测刷新当前余额';
    }

    renderKeys() {
      const select = this.panel.querySelector('[data-field="key"]');
      const metricMap = buildGroupMetricMap(this.rows);
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = this.keys.length
        ? '选择要切换的密钥'
        : (this.authError || (this.keyCount !== null ? `接口返回 ${this.keyCount} 个密钥` : '未读取到密钥'));
      select.appendChild(placeholder);
      for (const key of this.keys) {
        const option = document.createElement('option');
        option.value = key.id;
        option.textContent = formatKeyOptionLabel(key, metricMap.get(key.groupId));
        option.selected = String(key.id) === String(this.selectedKeyId);
        select.appendChild(option);
      }
      select.disabled = this.keys.length === 0;
      this.renderSelectedKeyDetails(metricMap);
    }

    renderSelectedKeyDetails(metricMap = buildGroupMetricMap(this.rows)) {
      const details = this.panel?.querySelector('[data-field="key-details"]');
      if (!details) return;
      const key = this.selectedKey();
      details.hidden = !key;
      if (!key) return;
      const metric = metricMap.get(key.groupId);
      const multiplier = nonNegativeNumberOrNull(metric?.multiplier);
      const latencyMs = nonNegativeNumberOrNull(metric?.latencyMs);
      details.querySelector('[data-key-detail="name"]').textContent = key.name;
      details.querySelector('[data-key-detail="group"]').textContent = key.groupName;
      details.querySelector('[data-key-detail="multiplier"]').textContent = multiplier === null ? '暂无数据' : formatMultiplier(multiplier);
      details.querySelector('[data-key-detail="latency"]').textContent = latencyMs === null ? '暂无数据' : formatLatency(latencyMs);
    }

    renderCandidates() {
      const list = this.panel.querySelector('[data-field="list"]');
      const rule = this.panel.querySelector('[data-field="ranking-rule"]');
      list.replaceChildren();
      rule.textContent = `${getCandidateRankingRule(this.config)} · ${this.ranked.length} 个候选`;
      if (!this.ranked.length) {
        const item = document.createElement('li');
        item.className = 'asg-candidate-empty';
        item.textContent = '暂无符合条件的候选分组';
        list.appendChild(item);
        return;
      }
      for (let index = 0; index < this.ranked.length; index += 1) {
        const candidate = this.ranked[index];
        const item = document.createElement('li');
        if (index === 0) item.className = 'asg-candidate-best';
        const locate = document.createElement('button');
        locate.type = 'button';
        locate.className = 'asg-candidate-locate';
        locate.dataset.action = 'locate-provider';
        locate.dataset.groupName = candidate.name;
        locate.title = `在供应商大厅定位 ${candidate.name}`;
        locate.setAttribute('aria-label', `在供应商大厅定位 ${candidate.name}`);
        const rank = document.createElement('span');
        rank.className = 'asg-candidate-rank';
        rank.textContent = `#${index + 1}`;
        const main = document.createElement('div');
        main.className = 'asg-candidate-main';
        const nameRow = document.createElement('div');
        nameRow.className = 'asg-candidate-name-row';
        const name = document.createElement('span');
        name.className = 'asg-candidate-name';
        name.textContent = candidate.name;
        name.title = candidate.name;
        nameRow.appendChild(name);
        if (index === 0) {
          const badge = document.createElement('span');
          badge.className = 'asg-candidate-badge';
          badge.textContent = '当前推荐';
          nameRow.appendChild(badge);
        }
        const detail = document.createElement('div');
        detail.className = 'asg-candidate-detail';
        detail.textContent = this.config.availabilityMode === 'successes'
          ? `10m 成功 ${candidate.recentSuccessCount || 0}/${candidate.recentSampleCount || 0} 点`
          : this.config.availabilityMode === 'consecutive'
            ? `10m 连续成功 ${candidate.recentConsecutiveSuccessCount || 0} 点`
            : `10m 可用率 ${formatPercent(candidate.success10m)}`;
        main.append(nameRow, detail, renderProviderSignals(candidate, true));
        const metrics = document.createElement('div');
        metrics.className = 'asg-candidate-metrics';
        const price = document.createElement('span');
        price.className = 'asg-candidate-price';
        price.textContent = formatMultiplier(candidate.price);
        const latency = document.createElement('span');
        latency.className = 'asg-candidate-latency';
        latency.textContent = `首 Token ${formatLatency(candidate.latency)}`;
        metrics.append(price, latency);
        if (this.config.mode === 'smart') {
          const score = document.createElement('span');
          score.className = 'asg-candidate-score';
          score.textContent = `评分 ${formatSmartScore(candidate.smartScore)}`;
          metrics.appendChild(score);
        }
        locate.append(rank, main, metrics);
        item.appendChild(locate);
        list.appendChild(item);
      }
    }

    runManualDetection() {
      if (location.pathname.replace(/\/+$/, '') === '/providers') {
        this.refreshProviderMonitor();
        return;
      }
      this.refresh(true);
    }

    refreshProviderMonitor() {
      if (this.providerRefreshLoading) return;
      const nativeButton = findProviderRefreshButton(document);
      if (!nativeButton) {
        this.log('error', '未找到供应商大厅的渠道刷新按钮，已直接更新推荐');
        this.refresh(true);
        return;
      }
      if (isProviderRefreshButtonBusy(nativeButton)) {
        this.setStatus('渠道检测正在刷新...');
        this.renderActionState();
        return;
      }

      this.providerRefreshLoading = true;
      this.providerRefreshStartedAt = Date.now();
      this.providerRefreshSawBusy = false;
      this.setStatus('正在刷新渠道检测...');
      this.log('info', '已请求刷新渠道检测');
      this.renderActionState();
      nativeButton.click();
      this.providerRefreshSawBusy = isProviderRefreshButtonBusy(findProviderRefreshButton(document) || nativeButton);
      this.watchProviderRefresh();
    }

    watchProviderRefresh() {
      if (!this.active) return;
      const nativeButton = findProviderRefreshButton(document);
      const busy = isProviderRefreshButtonBusy(nativeButton);
      const elapsed = Date.now() - this.providerRefreshStartedAt;
      if (busy) this.providerRefreshSawBusy = true;
      if (nativeButton && !busy && (this.providerRefreshSawBusy || elapsed >= 1000)) {
        this.providerRefreshLoading = false;
        this.providerRefreshTimer = null;
        this.log('info', '渠道检测刷新完成，正在更新推荐');
        this.refresh(true);
        this.renderActionState();
        return;
      }
      if (elapsed >= 30_000) {
        this.providerRefreshLoading = false;
        this.providerRefreshTimer = null;
        this.setStatus('渠道检测刷新超时，请稍后重试', true);
        this.log('error', '渠道检测刷新超时');
        this.renderActionState();
        return;
      }
      this.providerRefreshTimer = window.setTimeout(() => this.watchProviderRefresh(), 100);
      this.renderActionState();
    }

    navigateToProviderCandidate(groupName) {
      const name = String(groupName || '').trim();
      if (!name) return;
      const pageWindow = getPageWindow();
      if (location.pathname.replace(/\/+$/, '') !== '/providers') {
        try {
          pageWindow.sessionStorage.setItem(PENDING_PROVIDER_GROUP_KEY, JSON.stringify({
            name,
            expiresAt: Date.now() + 30 * 1000,
          }));
        } catch {
          // Navigation still works; only automatic post-navigation location is unavailable.
        }
        this.setStatus(`正在前往供应商大厅定位 ${name}`);
        pageWindow.location.assign('/providers');
        return;
      }
      this.locateProviderCandidate(name);
    }

    resumePendingProviderLocation() {
      if (location.pathname.replace(/\/+$/, '') !== '/providers') return;
      const pageWindow = getPageWindow();
      let pending = null;
      try {
        pending = parsePendingProviderLocation(pageWindow.sessionStorage.getItem(PENDING_PROVIDER_GROUP_KEY));
        pageWindow.sessionStorage.removeItem(PENDING_PROVIDER_GROUP_KEY);
      } catch {
        pending = null;
      }
      if (pending) this.locateProviderCandidate(pending.name);
    }

    locateProviderCandidate(groupName, attempt = 0) {
      if (!this.active) return;
      if (this.providerLocateTimer) window.clearTimeout(this.providerLocateTimer);
      this.providerLocateTimer = null;
      const row = findProviderGroupRow(document, groupName);
      if (row) {
        document.querySelector('.asg-provider-locate-target')?.classList.remove('asg-provider-locate-target');
        row.classList.add('asg-provider-locate-target');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.setStatus(`已定位到 ${groupName}`);
        if (!this.minimized) {
          this.panel.hidden = true;
          this.toggleButton.hidden = false;
        }
        this.providerLocateTimer = window.setTimeout(() => {
          row.classList.remove('asg-provider-locate-target');
          this.providerLocateTimer = null;
        }, 2500);
        return;
      }
      if (attempt >= 40) {
        this.setStatus(`未在供应商大厅找到 ${groupName}`, true);
        return;
      }
      this.providerLocateTimer = window.setTimeout(() => this.locateProviderCandidate(groupName, attempt + 1), 250);
    }

    renderActionState() {
      const refreshButton = this.panel.querySelector('[data-action="refresh"]');
      const onProvidersPage = location.pathname.replace(/\/+$/, '') === '/providers';
      const nativeProviderButton = onProvidersPage ? findProviderRefreshButton(document) : null;
      const providerBusy = isProviderRefreshButtonBusy(nativeProviderButton);
      refreshButton.disabled = this.loading || this.providerRefreshLoading || providerBusy;
      refreshButton.textContent = this.providerRefreshLoading || providerBusy
        ? '渠道刷新中...'
        : this.loading
          ? '检测中...'
          : onProvidersPage
            ? '刷新并检测'
            : '检测';
      refreshButton.title = onProvidersPage
        ? (nativeProviderButton
          ? '先刷新供应商大厅的渠道数据，再更新智能推荐'
          : '未找到顶部刷新按钮，将直接更新智能推荐')
        : '更新智能推荐';

      const button = this.panel.querySelector('[data-action="switch"]');
      const winner = this.ranked[0];
      const key = this.selectedKey();
      const reason = getSwitchBlockReason({
        loading: this.loading,
        error: this.error,
        authError: this.authError,
        monitorStale: this.monitorFreshness.stale,
        monitorFreshnessText: this.monitorFreshness.label,
        winner,
        key,
        stability: this.stability,
        requiredChecks: this.config.consecutiveChecks,
      });
      button.disabled = Boolean(reason);
      button.title = reason || `切换到 ${winner.name}`;
    }
  }

  class KeyGroupDropdownEnhancer {
    constructor() {
      this.monitorIndex = buildGroupDropdownMonitorIndex([]);
      this.observer = null;
      this.renderTimer = null;
      this.refreshTimer = null;
      this.renderQueued = false;
      this.loading = false;
      this.active = false;
      this.hasMonitorData = false;
      this.loadFailed = false;
      this.lastAttemptAt = 0;
      this.lastErrorSignature = '';
    }

    start() {
      this.active = true;
      addStyle(KEY_GROUP_STYLE);
      this.observer = new MutationObserver(() => this.queueRender());
      this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      this.queueRender();
      this.refreshTimer = window.setInterval(() => {
        if (this.findMenus().length && Date.now() - this.lastAttemptAt >= 60_000) this.refresh();
      }, 60_000);
    }

    stop() {
      this.active = false;
      this.observer?.disconnect();
      this.observer = null;
      if (this.renderTimer) window.clearTimeout(this.renderTimer);
      if (this.refreshTimer) window.clearInterval(this.refreshTimer);
      this.renderTimer = null;
      this.refreshTimer = null;
      document.querySelectorAll('.asg-key-group-status,.asg-key-group-latency').forEach((node) => node.remove());
      document.querySelectorAll('.asg-key-group-option').forEach((button) => {
        button.classList.remove('asg-key-group-option');
        const badge = button.querySelector('.groupOptionItemBadge');
        if (badge?.dataset.asgToneClass) {
          badge.classList.remove(badge.dataset.asgToneClass);
          delete badge.dataset.asgToneClass;
        }
        button.querySelector('.asg-key-group-row')?.classList.remove('asg-key-group-row');
        button.querySelector('.asg-key-group-main')?.classList.remove('asg-key-group-main');
        button.querySelector('.asg-key-group-rate-shell')?.classList.remove('asg-key-group-rate-shell');
        button.querySelector('.asg-key-group-rate')?.classList.remove('asg-key-group-rate');
      });
    }

    findMenus() {
      return [...document.querySelectorAll('input[placeholder="搜索分组..."]')]
        .map((input) => {
          const searchArea = input.parentElement?.parentElement;
          const menu = searchArea?.parentElement;
          const optionList = searchArea?.nextElementSibling;
          return menu && optionList && menu.contains(optionList) ? { menu, optionList } : null;
        })
        .filter(Boolean);
    }

    queueRender() {
      if (!this.active || this.renderQueued) return;
      this.renderQueued = true;
      this.renderTimer = window.setTimeout(() => {
        this.renderTimer = null;
        this.renderQueued = false;
        this.render();
      }, 0);
    }

    async refresh() {
      if (!this.active || this.loading || Date.now() - this.lastAttemptAt < 60_000) return;
      this.loading = true;
      this.loadFailed = false;
      this.lastAttemptAt = Date.now();
      this.render();
      try {
        const summary = await fetchMonitorSummary();
        if (!this.active) return;
        this.monitorIndex = buildGroupDropdownMonitorIndex(summary?.apis);
        this.hasMonitorData = true;
        if (this.lastErrorSignature) writeRuntimeLog('aihub', 'info', '密钥分组监控读取已恢复');
        this.lastErrorSignature = '';
      } catch (error) {
        if (!this.active) return;
        this.loadFailed = !this.hasMonitorData;
        const message = error instanceof Error ? error.message : '未知错误';
        if (message !== this.lastErrorSignature) writeRuntimeLog('aihub', 'error', `密钥分组监控读取失败：${message}`);
        this.lastErrorSignature = message;
      } finally {
        this.loading = false;
        if (this.active) this.render();
      }
    }

    render() {
      if (!this.active) return;
      const menus = this.findMenus();
      if (!menus.length) return;
      if (!this.hasMonitorData && !this.loading && Date.now() - this.lastAttemptAt >= 60_000) this.refresh();
      for (const { optionList } of menus) {
        for (const button of optionList.querySelectorAll('button')) this.renderOption(button);
      }
    }

    renderOption(button) {
      const badge = button.querySelector('.groupOptionItemBadge');
      const nameNode = badge?.querySelector('.truncate');
      const content = button.firstElementChild;
      const leftColumn = badge?.parentElement;
      const rightShell = content?.lastElementChild;
      const rightColumn = rightShell?.firstElementChild || rightShell;
      const multiplierNode = rightColumn?.querySelector('span');
      const name = nameNode?.textContent?.trim();
      if (!name || !leftColumn || !rightColumn || !multiplierNode) return;

      button.classList.add('asg-key-group-option');
      content.classList.add('asg-key-group-row');
      leftColumn.classList.add('asg-key-group-main');
      rightShell?.classList.add('asg-key-group-rate-shell');
      rightColumn.classList.add('asg-key-group-rate');

      let info;
      if (this.loadFailed) {
        info = { statusText: '监控读取失败', statusTone: 'error', latencyText: '首 Token 暂无数据', latencyValueText: '' };
      } else if (!this.hasMonitorData) {
        info = { statusText: '监控读取中', statusTone: 'unknown', latencyText: '首 Token --', latencyValueText: '' };
      } else {
        const multiplier = parseGroupOptionMultiplier(multiplierNode.textContent);
        info = formatGroupDropdownMonitor(findGroupDropdownMonitor(this.monitorIndex, name, multiplier));
      }

      const badgeToneClass = getGroupDropdownToneClass(info.statusTone);
      const currentBadgeToneClass = badge.dataset.asgToneClass || '';
      if (currentBadgeToneClass !== badgeToneClass) {
        if (badge.dataset.asgToneClass) badge.classList.remove(badge.dataset.asgToneClass);
        if (badgeToneClass) {
          badge.classList.add(badgeToneClass);
          badge.dataset.asgToneClass = badgeToneClass;
        } else {
          delete badge.dataset.asgToneClass;
        }
      }

      let status = leftColumn.querySelector('.asg-key-group-status');
      if (!status) {
        status = document.createElement('span');
        leftColumn.appendChild(status);
      }
      const statusClass = `asg-key-group-status asg-key-group-status-${info.statusTone}`;
      if (status.className !== statusClass) status.className = statusClass;
      if (status.textContent !== info.statusText) status.textContent = info.statusText;

      let latency = rightColumn.querySelector('.asg-key-group-latency');
      if (!latency) {
        latency = document.createElement('span');
        rightColumn.appendChild(latency);
      }
      if (latency.className !== 'asg-key-group-latency') latency.className = 'asg-key-group-latency';
      const latencyRenderKey = `${info.latencyText}|${info.latencyValueText}`;
      if (latency.dataset.renderKey !== latencyRenderKey) {
        if (info.latencyValueText) {
          const value = document.createElement('strong');
          value.className = 'asg-key-group-latency-value';
          value.textContent = info.latencyValueText;
          latency.replaceChildren(document.createTextNode('首 Token'), value);
        } else {
          latency.textContent = info.latencyText;
        }
        latency.dataset.renderKey = latencyRenderKey;
      }
    }
  }

  class UsageMultiplierEnhancer {
    constructor() {
      this.multiplierByGroup = new Map();
      this.observer = null;
      this.renderQueued = false;
      this.active = false;
      this.refreshTimer = null;
      this.renderTimer = null;
    }

    start() {
      this.active = true;
      addStyle(USAGE_STYLE);
      this.observer = new MutationObserver(() => this.queueRender());
      this.observer.observe(document.body, { childList: true, subtree: true });
      this.refresh();
      this.refreshTimer = window.setInterval(() => this.refresh(), 5 * 60 * 1000);
    }

    stop() {
      this.active = false;
      this.observer?.disconnect();
      this.observer = null;
      if (this.refreshTimer) window.clearInterval(this.refreshTimer);
      if (this.renderTimer) window.clearTimeout(this.renderTimer);
      this.refreshTimer = null;
      this.renderTimer = null;
      document.querySelectorAll('.asg-usage-multiplier').forEach((node) => node.remove());
    }

    async refresh() {
      try {
        const summary = await fetchMonitorSummary();
        if (!this.active) return;
        this.multiplierByGroup = buildGroupMultiplierMap(summary?.apis);
        this.render();
      } catch {
        // The usage page remains unchanged when current monitor data is unavailable.
      }
    }

    queueRender() {
      if (this.renderQueued) return;
      this.renderQueued = true;
      this.renderTimer = window.setTimeout(() => {
        this.renderTimer = null;
        this.renderQueued = false;
        this.render();
      }, 0);
    }

    render() {
      if (!this.multiplierByGroup.size) return;
      for (const table of document.querySelectorAll('table')) {
        const headers = [...table.querySelectorAll('thead th')];
        const groupColumnIndex = headers.findIndex((header) => header.textContent.trim() === '分组');
        if (groupColumnIndex < 0) continue;
        for (const row of table.querySelectorAll('tbody tr')) {
          const cells = row.querySelectorAll('td');
          const cell = cells[groupColumnIndex];
          if (!cell) continue;
          const existing = cell.querySelector('.asg-usage-multiplier');
          const name = normalizeGroupName([...cell.childNodes]
            .filter((node) => node !== existing)
            .map((node) => node.textContent)
            .join(' '));
          const multiplier = this.multiplierByGroup.get(name);
          if (multiplier == null) {
            existing?.remove();
            continue;
          }
          const text = formatMultiplier(multiplier);
          if (existing) {
            existing.dataset.groupName = name;
            if (existing.textContent !== text) existing.textContent = text;
          } else {
            const badge = document.createElement('span');
            badge.className = 'asg-usage-multiplier';
            badge.dataset.groupName = name;
            badge.textContent = text;
            cell.appendChild(badge);
          }
        }
      }
    }
  }

  class AppRouter {
    constructor() {
      this.panel = null;
      this.usage = null;
      this.keyGroups = null;
      this.rejectedToken = '';
      this.timer = null;
    }

    start() {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('显示 AIHub 智能分组', () => {
          this.panel?.setMinimized(false);
        });
      }
      this.sync();
      this.timer = window.setInterval(() => this.sync(), 500);
    }

    sync() {
      const token = getAuthToken();
      if (!token) this.rejectedToken = '';
      const features = getPageFeatures(location.pathname, Boolean(token) && token !== this.rejectedToken);
      if (features.panel && !this.panel) {
        this.panel = new Controller({
          onAuthInvalid: () => {
            this.rejectedToken = token;
            this.sync();
          },
        });
        this.panel.start(false);
      } else if (!features.panel && this.panel) {
        this.panel.stop();
        this.panel = null;
      }
      if (features.usage && !this.usage) {
        this.usage = new UsageMultiplierEnhancer();
        this.usage.start();
      } else if (!features.usage && this.usage) {
        this.usage.stop();
        this.usage = null;
      }
      if (features.keyGroups && !this.keyGroups) {
        this.keyGroups = new KeyGroupDropdownEnhancer();
        this.keyGroups.start();
      } else if (!features.keyGroups && this.keyGroups) {
        this.keyGroups.stop();
        this.keyGroups = null;
      }
    }
  }

  return {
    DEFAULT_CONFIG,
    GROUP_MODE_LABELS,
    normalizeConfig,
    normalizeGroupMode,
    normalizeTargetModel,
    normalizeModelDetectionPolicy,
    normalizeAvailabilityMode,
    normalizePanelTab,
    toggleSidePanelState,
    getBalanceAmount,
    formatBalance,
    normalizeCacheHitRate,
    formatCacheHitRate,
    getModelHealthInfo,
    getModelDetectionInfo,
    getProviderSignalSummary,
    modelHealthPassesTarget,
    isModelDetectionExpired,
    modelDetectionPassesPolicy,
    getModelHealthScore,
    getModelDetectionScore,
    getSmartCandidateScore,
    normalizeProviderRow,
    normalizeProviderSummary,
    normalizeProviderSeries,
    getExcludedGroupInfo,
    analyzeCandidates,
    rankCandidates,
    getCandidateRankingRule,
    findProviderGroupRow,
    findProviderRefreshButton,
    isProviderRefreshButtonBusy,
    parsePendingProviderLocation,
    getMonitorFreshness,
    getLatestMonitorSampleAt,
    getCooldownInfo,
    attachRecentAvailability,
    buildAvailabilityChartModel,
    normalizeGroupName,
    buildGroupMultiplierMap,
    buildGroupMetricMap,
    buildGroupDropdownMonitorIndex,
    findGroupDropdownMonitor,
    parseGroupOptionMultiplier,
    formatGroupDropdownMonitor,
    getGroupDropdownToneClass,
    formatKeyOptionLabel,
    formatMultiplier,
    formatSmartScore,
    getPageFeatures,
    createStabilityState,
    advanceStability,
    canAutoSwitch,
    getAutoSwitchBlockReason,
    shouldLogTransition,
    getSwitchBlockReason,
    projectKeys,
    buildAuthHeaders,
    buildApiHeaders,
    mergeKeyPages,
    shouldRefreshKeys,
    appendLogEntries,
    formatLogLine,
    start() {
      if (location.hostname !== 'aihub.top') return;
      new AppRouter().start();
    },
  };
});
