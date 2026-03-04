/**
 * Overlay / Delta Modification Engine
 *
 * Architecture:
 *   Raw source data (refreshable) + Persistent modification rules = Final output
 *
 * Rules survive source refreshes because they are stored separately
 * and re-applied on top of fresh source data every time.
 *
 * Rule types:
 *   1. RemovedChannel  — blacklisted by name/url/tvgId (never comes back)
 *   2. ChannelOverride — rename/regroup/relogo/replace-url
 *   3. GroupRule       — remove/rename/merge entire groups
 *   4. CustomChannel   — user-added channels (not from any source)
 */

import { Channel } from '../types';
import { isTamilChannel } from './universalParser';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MatchType = 'exact_name' | 'stream_url' | 'tvg_id' | 'regex' | 'name_contains';

export interface RemovedChannel {
  channelKey : string;      // the value to match against
  matchType  : MatchType;
  sourceId  ?: string;      // undefined = applies to ALL sources
  removedAt  : string;
  reason    ?: string;      // 'manual_delete' | 'remove_others' | 'bulk_delete'
}

export interface ChannelOverride {
  channelKey     : string;
  matchType      : MatchType;
  sourceId      ?: string;
  overrideName  ?: string;
  overrideGroup ?: string;
  overrideLogo  ?: string;
  overrideTvgId ?: string;
  overrideUrl   ?: string;  // replace stream URL entirely
  overrideOrder ?: number;
}

export type GroupRuleType = 'remove' | 'rename' | 'merge';

export interface GroupRule {
  id        : string;
  ruleType  : GroupRuleType;
  sourceId ?: string;       // undefined = all sources
  matchGroup: string;       // exact group name to match
  newGroup ?: string;       // for rename/merge target
  createdAt : string;
}

export interface CustomChannel extends Channel {
  isCustom: true;
}

export interface ModificationStore {
  removedChannels  : RemovedChannel[];
  channelOverrides : ChannelOverride[];
  groupRules       : GroupRule[];
  customChannels   : CustomChannel[];
}

export const EMPTY_MODS: ModificationStore = {
  removedChannels  : [],
  channelOverrides : [],
  groupRules       : [],
  customChannels   : [],
};

// ─── Match helpers ────────────────────────────────────────────────────────────

function matchesRule(
  ch     : Channel,
  key    : string,
  type   : MatchType,
  srcId ?: string,
): boolean {
  // Source scope check
  if (srcId && ch.sourceId !== srcId) return false;

  const norm = (s: string) => (s || '').toLowerCase().trim();

  switch (type) {
    case 'exact_name':
      return norm(ch.name) === norm(key);
    case 'name_contains':
      return norm(ch.name).includes(norm(key));
    case 'stream_url':
      return (ch.rawUrl || ch.url || '').includes(key);
    case 'tvg_id':
      return norm(ch.tvgId || '') === norm(key);
    case 'regex': {
      try {
        return new RegExp(key, 'i').test(`${ch.name} ${ch.group} ${ch.url}`);
      } catch { return false; }
    }
    default:
      return false;
  }
}

// ─── Core: Apply all modifications to a channel array ────────────────────────

export function applyModifications(
  channels : Channel[],
  mods     : ModificationStore,
  sourceId ?: string,           // if set, only apply scope-matching rules
): Channel[] {
  const {
    removedChannels,
    channelOverrides,
    groupRules,
    customChannels,
  } = mods;

  // ── Step 1: Filter removed channels ──────────────────────────────────────
  let result = channels.filter(ch => {
    const isRemoved = removedChannels.some(rule =>
      matchesRule(ch, rule.channelKey, rule.matchType, rule.sourceId)
    );
    return !isRemoved;
  });

  // ── Step 2: Apply channel overrides ──────────────────────────────────────
  result = result.map(ch => {
    const override = channelOverrides.find(ov =>
      matchesRule(ch, ov.channelKey, ov.matchType, ov.sourceId)
    );
    if (!override) return ch;

    const updated: Channel = { ...ch };
    if (override.overrideName)  updated.name  = override.overrideName;
    if (override.overrideGroup) updated.group = override.overrideGroup;
    if (override.overrideLogo)  updated.logo  = override.overrideLogo;
    if (override.overrideTvgId) updated.tvgId = override.overrideTvgId;
    if (override.overrideUrl) {
      updated.url    = override.overrideUrl;
      updated.rawUrl = override.overrideUrl;
    }
    if (override.overrideOrder !== undefined) updated.order = override.overrideOrder;

    // Re-tag Tamil after override (group/name might have changed)
    updated.isTamil = isTamilChannel(
      updated.name     || '',
      updated.group    || '',
      updated.language || '',
    );

    return updated;
  });

  // ── Step 3: Apply group rules ─────────────────────────────────────────────
  for (const rule of groupRules) {
    if (rule.sourceId && sourceId && rule.sourceId !== sourceId) continue;

    if (rule.ruleType === 'remove') {
      result = result.filter(ch => ch.group !== rule.matchGroup);
    } else if (rule.ruleType === 'rename' && rule.newGroup) {
      result = result.map(ch =>
        ch.group === rule.matchGroup ? { ...ch, group: rule.newGroup! } : ch
      );
    } else if (rule.ruleType === 'merge' && rule.newGroup) {
      result = result.map(ch =>
        ch.group === rule.matchGroup ? { ...ch, group: rule.newGroup! } : ch
      );
    }
  }

  // ── Step 4: Inject custom channels (not bound to any source) ─────────────
  if (!sourceId) {
    const customToAdd = customChannels.filter(
      cc => !result.find(ch => ch.id === cc.id)
    );
    result = [...result, ...customToAdd];
  }

  return result;
}

// ─── Helpers to create rules ──────────────────────────────────────────────────

export function makeRemovedRule(
  ch       : Channel,
  reason  ?: string,
  sourceId?: string,
): RemovedChannel[] {
  // Create two rules: by name AND by URL for maximum durability
  // (URL might change on refresh, name usually stays the same)
  const rules: RemovedChannel[] = [];
  const now = new Date().toISOString();

  if (ch.name) {
    rules.push({
      channelKey: ch.name.toLowerCase().trim(),
      matchType : 'exact_name',
      sourceId,
      removedAt : now,
      reason,
    });
  }

  const streamUrl = ch.rawUrl || ch.url;
  if (streamUrl) {
    rules.push({
      channelKey: streamUrl,
      matchType : 'stream_url',
      sourceId,
      removedAt : now,
      reason,
    });
  }

  return rules;
}

export function makeNonTamilRules(
  channels : Channel[],
  sourceId : string,
): RemovedChannel[] {
  const nonTamil = channels.filter(
    ch => ch.sourceId === sourceId && !ch.isTamil
  );
  const now = new Date().toISOString();
  return nonTamil.map(ch => ({
    channelKey: ch.name.toLowerCase().trim(),
    matchType : 'exact_name' as MatchType,
    sourceId,
    removedAt : now,
    reason    : 'remove_others',
  }));
}

export function makeGroupRemoveRule(groupName: string, id: string): GroupRule {
  return {
    id,
    ruleType  : 'remove',
    matchGroup: groupName,
    createdAt : new Date().toISOString(),
  };
}

export function makeGroupRenameRule(
  oldName  : string,
  newName  : string,
  id       : string,
  sourceId?: string,
): GroupRule {
  return {
    id,
    ruleType  : 'rename',
    matchGroup: oldName,
    newGroup  : newName,
    sourceId,
    createdAt : new Date().toISOString(),
  };
}
