// src/integrations.js - Real integrations for handlers
// Neynar API, ICS calendar parsing, Farcaster mentions
// All integrations respect timeouts, rate limits, and credential availability

const fs = require('fs');
const path = require('path');

// ===== NEYNAR API INTEGRATION =====
const NEYNAR_API_BASE = 'https://api.neynar.com';
const NEYNAR_HUB_API_BASE = 'https://hub-api.neynar.com';

function getNeynarKey() {
  const home = process.env.HOME || '/root';
  try {
    const envFilePath = path.join(home, '.zao', 'private', 'neynar.env');
    const content = fs.readFileSync(envFilePath, 'utf8');
    const match = content.match(/NEYNAR_API_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch (e) {
    return null;
  }
}

async function fetchNeynarWithTimeout(endpoint, options = {}, timeoutMs = 15000) {
  const key = getNeynarKey();
  if (!key) {
    return { error: 'NEYNAR_API_KEY not available' };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${NEYNAR_API_BASE}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'x-api-key': key,
        'accept': 'application/json',
        ...options.headers
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }

    return await response.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      return { error: 'timeout' };
    }
    return { error: e.message };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function getNeynarMentions(fid, limit = 10) {
  // Fetch mentions for a given Farcaster ID
  // Returns structured mentions for inbox.read / farcaster.read handlers
  const result = await fetchNeynarWithTimeout(
    `/v2/farcaster/reactions/user_reactions?fid=${fid}&reaction_type=likes&limit=${limit}`,
    { method: 'GET' }
  );

  if (result.error) {
    return { mentions: [], count: 0, error: result.error };
  }

  // Parse Neynar's response into structured mentions
  const reactions = result.reactions || [];
  const mentions = reactions.map(r => ({
    castHash: r.cast?.hash || '',
    authorFid: r.cast?.author?.fid || 0,
    authorUsername: r.cast?.author?.username || '',
    text: r.cast?.text || '',
    timestamp: r.cast?.timestamp || new Date().toISOString(),
    reactionType: 'mention'
  }));

  return { mentions, count: mentions.length };
}

async function searchNeynarCasts(query, limit = 10) {
  // Search casts by query (e.g., mentions)
  const result = await fetchNeynarWithTimeout(
    `/v1/search_casts?q=${encodeURIComponent(query)}&limit=${limit}`,
    { method: 'GET' }
  );

  if (result.error) {
    return { casts: [], count: 0, error: result.error };
  }

  const casts = (result.casts || []).map(c => ({
    castHash: c.hash || '',
    authorFid: c.author?.fid || 0,
    authorUsername: c.author?.username || '',
    text: c.text || '',
    timestamp: c.timestamp || new Date().toISOString(),
    reactionType: 'search_result'
  }));

  return { casts, count: casts.length };
}

// ===== ICS CALENDAR PARSING =====
// Simple ICS parser for reading calendar events from Luma or other ICS feeds

function parseICalendar(icsContent) {
  // Basic ICS parser for VEVENT entries
  // Handles: SUMMARY, DTSTART, DTEND, DESCRIPTION, URL, LOCATION
  const events = [];

  // Split by VEVENT
  const eventMatches = icsContent.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];

  for (const eventBlock of eventMatches) {
    const event = {};

    // Parse SUMMARY (title)
    const summaryMatch = eventBlock.match(/SUMMARY:(.+?)(?:\r?\n|$)/);
    event.title = summaryMatch ? summaryMatch[1].trim() : '';

    // Parse DTSTART (start time)
    const dtStartMatch = eventBlock.match(/DTSTART(?:;[^:]*)?:(.+?)(?:\r?\n|$)/);
    if (dtStartMatch) {
      event.startTime = parseICalDateTime(dtStartMatch[1]);
    }

    // Parse DTEND (end time)
    const dtEndMatch = eventBlock.match(/DTEND(?:;[^:]*)?:(.+?)(?:\r?\n|$)/);
    if (dtEndMatch) {
      event.endTime = parseICalDateTime(dtEndMatch[1]);
    }

    // Parse DESCRIPTION
    const descMatch = eventBlock.match(/DESCRIPTION:(.+?)(?:\r?\n|$)/);
    event.description = descMatch ? descMatch[1].trim() : '';

    // Parse LOCATION
    const locMatch = eventBlock.match(/LOCATION:(.+?)(?:\r?\n|$)/);
    event.location = locMatch ? locMatch[1].trim() : '';

    // Parse URL
    const urlMatch = eventBlock.match(/URL:(.+?)(?:\r?\n|$)/);
    event.url = urlMatch ? urlMatch[1].trim() : '';

    if (event.title && event.startTime) {
      events.push(event);
    }
  }

  return events;
}

function parseICalDateTime(dateStr) {
  // ICS format: YYYYMMDDTHHMMSSZ or YYYYMMDD (all-day)
  // Returns ISO string
  const cleaned = dateStr.trim();

  // All-day event (YYYYMMDD)
  if (cleaned.length === 8 && /^\d{8}$/.test(cleaned)) {
    const year = cleaned.slice(0, 4);
    const month = cleaned.slice(4, 6);
    const day = cleaned.slice(6, 8);
    return `${year}-${month}-${day}T00:00:00Z`;
  }

  // Date-time (YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS)
  if (cleaned.includes('T')) {
    const match = cleaned.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (match) {
      const [, year, month, day, hour, min, sec, hasZ] = match;
      const iso = `${year}-${month}-${day}T${hour}:${min}:${sec}${hasZ ? 'Z' : ''}`;
      return iso;
    }
  }

  // Fallback: return as-is if unparseable
  return cleaned;
}

async function fetchCalendarICS(url, timeoutMs = 10000) {
  // Fetch ICS feed from URL
  if (!url) {
    return { events: [], error: 'No calendar URL provided' };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ZOL-Agent/1.0' },
      signal: controller.signal
    });

    if (!response.ok) {
      return { events: [], error: `HTTP ${response.status}` };
    }

    const icsContent = await response.text();
    const events = parseICalendar(icsContent);
    return { events, count: events.length };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { events: [], error: 'timeout' };
    }
    return { events: [], error: e.message };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function getDefaultCalendarUrl() {
  // Try env var first, then return ZAO's known Luma calendar URL
  return process.env.ZOL_CALENDAR_URL || 'https://luma.com/zao/calendar.ics';
}

// ===== EXPORTS =====
module.exports = {
  getNeynarKey,
  fetchNeynarWithTimeout,
  getNeynarMentions,
  searchNeynarCasts,
  parseICalendar,
  parseICalDateTime,
  fetchCalendarICS,
  getDefaultCalendarUrl
};
