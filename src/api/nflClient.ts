import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import {
  NFLGameScore, NFLResponse, NFLHealthResult,
  ESPNScoreboardResponse, ESPNEvent, ESPNCompetition, ESPNCompetitor,
  ESPNNewsArticle, ESPNNewsResponse,
} from '../types';

/**
 * Parsed season/week from a user query.
 * Missing fields mean "use current".
 */
export interface ParsedWeekQuery {
  season?: number;
  week?: number;
}

/**
 * Detect whether an error is an abort/cancellation error.
 * Covers native AbortError and axios CanceledError.
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'CanceledError') return true;
    if ('code' in error && (error as { code?: string }).code === 'ERR_CANCELED') return true;
  }
  return false;
}

const ESPN_BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

/**
 * Parse an explicit season and/or week from user input.
 *
 * Supported patterns:
 *   "week 4 2025", "2025 week 4", "wk4 2025", "week 4",
 *   "2025/4", "2025 wk 4", "w4"
 *
 * Returns only the fields that were explicitly found.
 */
export function parseSeasonWeek(content: string): ParsedWeekQuery {
  const result: ParsedWeekQuery = {};
  const text = content.toLowerCase().trim();
  if (!text) return result;

  // Pattern 1: "week 4 2025" or "wk 4 2025" or "w4 2025"
  const weekFirst = text.match(/\bw(?:ee)?k?\s*(\d{1,2})\b(?:\s+|\s*,\s*)(20[12]\d)\b/);
  if (weekFirst) {
    result.week = parseInt(weekFirst[1], 10);
    result.season = parseInt(weekFirst[2], 10);
    return result;
  }

  // Pattern 2: "2025 week 4" or "2025 wk4" or "2025 w4"
  const seasonFirst = text.match(/\b(20[12]\d)\s+w(?:ee)?k?\s*(\d{1,2})\b/);
  if (seasonFirst) {
    result.season = parseInt(seasonFirst[1], 10);
    result.week = parseInt(seasonFirst[2], 10);
    return result;
  }

  // Pattern 3: "2025/4" or "2025-4" (season/week shorthand)
  const slashPattern = text.match(/\b(20[12]\d)[/\-](\d{1,2})\b/);
  if (slashPattern) {
    result.season = parseInt(slashPattern[1], 10);
    result.week = parseInt(slashPattern[2], 10);
    return result;
  }

  // Pattern 4: standalone "week 4" or "wk 4" or "wk4" or "w4" (no season)
  const weekOnly = text.match(/\bw(?:ee)?k?\s*(\d{1,2})\b/);
  if (weekOnly) {
    result.week = parseInt(weekOnly[1], 10);
  }

  // Pattern 5: standalone 4-digit season year without a week keyword
  // Only pick it up if we didn't already get one and it looks like a season
  if (!result.season) {
    const yearOnly = text.match(/\b(20[12]\d)\b/);
    if (yearOnly) {
      result.season = parseInt(yearOnly[1], 10);
    }
  }

  return result;
}

// ── ESPN → NFLGameScore adapter ─────────────────────────────────

/**
 * Map ESPN status fields to the internal NFLGameScore.Status union.
 */
function mapESPNStatus(status: ESPNCompetition['status']): NFLGameScore['Status'] {
  const { state, name } = status.type;

  if (state === 'pre') return 'Scheduled';

  if (state === 'in') {
    if (name === 'STATUS_DELAYED') return 'Delayed';
    return 'InProgress';
  }

  if (state === 'post') {
    if (name === 'STATUS_POSTPONED') return 'Postponed';
    if (name === 'STATUS_CANCELED') return 'Canceled';
    if (status.period > 4) return 'F/OT';
    return 'Final';
  }

  return 'Scheduled';
}

/**
 * Derive the Quarter field from ESPN status.
 */
function mapESPNQuarter(status: ESPNCompetition['status']): string | null {
  if (status.type.state === 'pre') return null;
  if (status.type.name === 'STATUS_HALFTIME') return 'Half';
  if (status.period === 0) return null;
  if (status.period > 4) return 'OT';
  return String(status.period);
}

/**
 * Convert a single ESPN event into the internal NFLGameScore model.
 */
export function mapESPNEventToGame(event: ESPNEvent): NFLGameScore {
  const competition = event.competitions[0];
  const status = competition.status;

  // Find home and away competitors
  const home = competition.competitors.find((c: ESPNCompetitor) => c.homeAway === 'home');
  const away = competition.competitors.find((c: ESPNCompetitor) => c.homeAway === 'away');

  const homeScore = home?.score !== undefined ? parseInt(home.score, 10) : null;
  const awayScore = away?.score !== undefined ? parseInt(away.score, 10) : null;

  // Venue
  let stadiumDetails: NFLGameScore['StadiumDetails'] = null;
  if (competition.venue) {
    stadiumDetails = {
      Name: competition.venue.fullName,
      City: competition.venue.address?.city ?? '',
      State: competition.venue.address?.state ?? '',
      Country: competition.venue.address?.country ?? 'USA',
    };
  }

  // Odds
  let pointSpread: number | null = null;
  let overUnder: number | null = null;
  let awayMoneyLine: number | null = null;
  let homeMoneyLine: number | null = null;
  if (competition.odds && competition.odds.length > 0) {
    const odds = competition.odds[0];
    pointSpread = odds.spread ?? null;
    overUnder = odds.overUnder ?? null;
    awayMoneyLine = odds.awayTeamOdds?.moneyLine ?? null;
    homeMoneyLine = odds.homeTeamOdds?.moneyLine ?? null;
  }

  return {
    GameKey: event.id,
    Season: event.season.year,
    SeasonType: event.season.type,
    Week: event.week.number,
    Date: event.date || null,
    AwayTeam: away?.team.abbreviation ?? '',
    HomeTeam: home?.team.abbreviation ?? '',
    AwayScore: status.type.state === 'pre' ? null : (isNaN(awayScore as number) ? null : awayScore),
    HomeScore: status.type.state === 'pre' ? null : (isNaN(homeScore as number) ? null : homeScore),
    Channel: competition.broadcast || null,
    Quarter: mapESPNQuarter(status),
    TimeRemaining: status.type.state === 'in' ? status.displayClock : null,
    Status: mapESPNStatus(status),
    StadiumDetails: stadiumDetails,
    IsClosed: status.type.completed,
    AwayTeamMoneyLine: awayMoneyLine,
    HomeTeamMoneyLine: homeMoneyLine,
    PointSpread: pointSpread,
    OverUnder: overUnder,
    _espn: event,
  };
}

/**
 * Map a full ESPN scoreboard response into an array of NFLGameScore.
 */
export function mapESPNScoreboard(response: ESPNScoreboardResponse): NFLGameScore[] {
  if (!response.events || !Array.isArray(response.events)) return [];
  return response.events.map(mapESPNEventToGame);
}

// ── Team maps ───────────────────────────────────────────────────

/** NFL team abbreviation → full name map for fuzzy team lookup. */
const TEAM_MAP: Record<string, string> = {
  ARI: 'Arizona Cardinals',
  ATL: 'Atlanta Falcons',
  BAL: 'Baltimore Ravens',
  BUF: 'Buffalo Bills',
  CAR: 'Carolina Panthers',
  CHI: 'Chicago Bears',
  CIN: 'Cincinnati Bengals',
  CLE: 'Cleveland Browns',
  DAL: 'Dallas Cowboys',
  DEN: 'Denver Broncos',
  DET: 'Detroit Lions',
  GB: 'Green Bay Packers',
  HOU: 'Houston Texans',
  IND: 'Indianapolis Colts',
  JAX: 'Jacksonville Jaguars',
  KC: 'Kansas City Chiefs',
  LAC: 'Los Angeles Chargers',
  LAR: 'Los Angeles Rams',
  LV: 'Las Vegas Raiders',
  MIA: 'Miami Dolphins',
  MIN: 'Minnesota Vikings',
  NE: 'New England Patriots',
  NO: 'New Orleans Saints',
  NYG: 'New York Giants',
  NYJ: 'New York Jets',
  PHI: 'Philadelphia Eagles',
  PIT: 'Pittsburgh Steelers',
  SEA: 'Seattle Seahawks',
  SF: 'San Francisco 49ers',
  TB: 'Tampa Bay Buccaneers',
  TEN: 'Tennessee Titans',
  WAS: 'Washington Commanders',
};

/** Common aliases (case-insensitive) → team abbreviation. */
const TEAM_ALIASES: Record<string, string> = {
  cardinals: 'ARI', arizona: 'ARI',
  falcons: 'ATL', atlanta: 'ATL',
  ravens: 'BAL', baltimore: 'BAL',
  bills: 'BUF', buffalo: 'BUF',
  panthers: 'CAR', carolina: 'CAR',
  bears: 'CHI', chicago: 'CHI',
  bengals: 'CIN', cincinnati: 'CIN',
  browns: 'CLE', cleveland: 'CLE',
  cowboys: 'DAL', dallas: 'DAL',
  broncos: 'DEN', denver: 'DEN',
  lions: 'DET', detroit: 'DET',
  packers: 'GB', 'green bay': 'GB',
  texans: 'HOU', houston: 'HOU',
  colts: 'IND', indianapolis: 'IND',
  jaguars: 'JAX', jags: 'JAX', jacksonville: 'JAX',
  chiefs: 'KC', 'kansas city': 'KC',
  chargers: 'LAC',
  rams: 'LAR',
  raiders: 'LV', 'las vegas': 'LV',
  dolphins: 'MIA', miami: 'MIA',
  vikings: 'MIN', minnesota: 'MIN',
  patriots: 'NE', pats: 'NE', 'new england': 'NE',
  saints: 'NO', 'new orleans': 'NO',
  giants: 'NYG',
  jets: 'NYJ',
  eagles: 'PHI', philadelphia: 'PHI', philly: 'PHI',
  steelers: 'PIT', pittsburgh: 'PIT',
  seahawks: 'SEA', seattle: 'SEA',
  '49ers': 'SF', niners: 'SF', 'san francisco': 'SF',
  buccaneers: 'TB', bucs: 'TB', tampa: 'TB', 'tampa bay': 'TB',
  titans: 'TEN', tennessee: 'TEN',
  commanders: 'WAS', washington: 'WAS',
};

// ── Cache ───────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class NFLCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlSeconds: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  clear(): void {
    this.store.clear();
  }
}

// ── NFLClient ───────────────────────────────────────────────────

export class NFLClient {
  private client: AxiosInstance;
  private cache = new NFLCache();

  constructor() {
    const baseURL = config.getNflEndpoint() || ESPN_BASE_URL;
    this.client = axios.create({ baseURL });
    if (!baseURL.includes('espn.com')) {
      logger.log('warn', 'nfl', `NFL: Endpoint "${baseURL}" is not an ESPN URL — requests may fail`);
    }
  }

  /**
   * Rebuild the axios instance with the current endpoint from config.
   */
  refresh(): void {
    const baseURL = config.getNflEndpoint() || ESPN_BASE_URL;
    this.client = axios.create({ baseURL });
    this.cache.clear();
    if (!baseURL.includes('espn.com')) {
      logger.log('warn', 'nfl', `NFL: Endpoint "${baseURL}" is not an ESPN URL — requests may fail`);
    }
    if (config.getNflLoggingLevel() >= 0) {
      logger.log('success', 'nfl', `NFL: Client refreshed — endpoint: ${baseURL}`);
    }
  }

  /**
   * Resolve a user-provided team query to a team abbreviation.
   * Supports full names, city names, nicknames, and abbreviations.
   */
  resolveTeam(query: string): string | null {
    const lower = query.toLowerCase().trim();
    if (!lower) return null;

    // Direct abbreviation match
    const upper = lower.toUpperCase();
    if (TEAM_MAP[upper]) return upper;

    // Alias lookup
    if (TEAM_ALIASES[lower]) return TEAM_ALIASES[lower];

    // Partial match — check if any alias starts with or contains the query
    for (const [alias, abbr] of Object.entries(TEAM_ALIASES)) {
      if (alias.startsWith(lower) || lower.startsWith(alias)) {
        return abbr;
      }
    }

    return null;
  }

  /**
   * Get the full team name for a team abbreviation.
   */
  getTeamName(abbr: string): string {
    return TEAM_MAP[abbr.toUpperCase()] || abbr;
  }

  // ── ESPN API Endpoints ────────────────────────────────────────

  /**
   * Fetch scoreboard from ESPN. No API key required.
   * Supports current (default), by date (?dates=YYYYMMDD), or
   * by week/season (?week=N&seasontype=T&season=Y).
   */
  async fetchScoreboard(
    params?: { dates?: string; week?: number; seasontype?: number; season?: number },
    signal?: AbortSignal
  ): Promise<NFLGameScore[]> {
    const logLevel = config.getNflLoggingLevel();

    // Build cache key from params
    const paramStr = params
      ? Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')
      : 'current';
    const cacheKey = `scoreboard-${paramStr}`;

    const cached = this.cache.get<NFLGameScore[]>(cacheKey);
    if (cached !== null) {
      if (logLevel >= 1) logger.log('success', 'nfl', `NFL: scoreboard cache HIT — ${cacheKey} (${cached.length} game(s))`);
      return cached;
    }

    try {
      if (logLevel >= 1) logger.log('success', 'nfl', `NFL: Fetching /scoreboard (${paramStr})`);
      const response = await this.client.get('/scoreboard', {
        params,
        signal,
      });
      const espnData = response.data as ESPNScoreboardResponse;
      const games = mapESPNScoreboard(espnData);

      // Use short cache for in-progress games, longer for final scores
      const hasLive = games.some(g => g.Status === 'InProgress');
      const ttl = hasLive ? 60 : 300;
      this.cache.set(cacheKey, games, ttl);

      // Summarize game statuses
      const statusCounts: Record<string, number> = {};
      for (const g of games) {
        statusCounts[g.Status] = (statusCounts[g.Status] || 0) + 1;
      }
      const statusSummary = Object.entries(statusCounts).map(([s, c]) => `${s}:${c}`).join(', ');
      if (logLevel >= 0) {
        logger.log('success', 'nfl', `NFL: Scoreboard (${paramStr}) — ${games.length} game(s) [${statusSummary}] (cached ${ttl}s)`);
      }

      return games;
    } catch (error) {
      if (isAbortError(error)) throw error;
      const hint = (error as { response?: { status?: number } })?.response?.status === 401
        ? ' — check NFL_BASE_URL in .env (should be ESPN)'
        : '';
      logger.logError('nfl', `Failed to fetch ESPN scoreboard (${paramStr}): ${error}${hint}`);
      return [];
    }
  }

  /**
   * Fetch the current scoreboard (no date/week filter).
   */
  async getCurrentScoreboard(signal?: AbortSignal): Promise<NFLGameScore[]> {
    return this.fetchScoreboard(undefined, signal);
  }

  /**
   * Fetch scores for a specific season and week.
   */
  async getScoresByWeek(season: number, week: number, signal?: AbortSignal): Promise<NFLGameScore[]> {
    // ESPN uses seasontype: 1=pre, 2=regular, 3=post
    // Default to regular season (2) unless the caller knows otherwise
    return this.fetchScoreboard({ season, week, seasontype: 2 }, signal);
  }

  /**
   * Fetch the current week's game scores.
   * ESPN defaults to the current week automatically.
   */
  async getCurrentWeekScores(signal?: AbortSignal): Promise<NFLGameScore[]> {
    return this.getCurrentScoreboard(signal);
  }

  /**
   * Find games for a specific team in the current week.
   */
  async findTeamGame(teamAbbr: string, signal?: AbortSignal): Promise<NFLGameScore | null> {
    const games = await this.getCurrentWeekScores(signal);
    const upper = teamAbbr.toUpperCase();
    return games.find(g => g.HomeTeam === upper || g.AwayTeam === upper) || null;
  }

  /**
   * Find the Super Bowl game.
   * ESPN annotates the Super Bowl with a note headline containing "Super Bowl".
   * Falls back to looking for postseason (SeasonType 3) games.
   */
  async getSuperBowlGame(signal?: AbortSignal): Promise<NFLGameScore | null> {
    // Try current scoreboard first — during Super Bowl week this is sufficient
    const games = await this.getCurrentScoreboard(signal);

    // Look for game with "Super Bowl" in its notes
    for (const game of games) {
      const espn = game._espn;
      if (espn) {
        const comp = espn.competitions[0];
        const hasSuperBowlNote = comp.notes?.some(
          n => n.headline?.toLowerCase().includes('super bowl')
        );
        if (hasSuperBowlNote) return game;
      }
    }

    // Fallback: look for a single postseason game (SeasonType 3)
    const postseasonGames = games.filter(g => g.SeasonType === 3);
    if (postseasonGames.length === 1) return postseasonGames[0];

    // Try fetching postseason explicitly with week 5 (Super Bowl week in ESPN)
    try {
      const season = games.length > 0 ? games[0].Season : new Date().getFullYear();
      const sbGames = await this.fetchScoreboard({ season, week: 5, seasontype: 3 }, signal);
      if (sbGames.length > 0) return sbGames[0];
    } catch (error) {
      if (isAbortError(error)) throw error;
      // Silently continue
    }

    return null;
  }

  /**
   * Test ESPN API connection and return health status.
   * No API key needed — just check that the endpoint responds.
   */
  async testConnection(): Promise<NFLHealthResult> {
    try {
      const response = await this.client.get('/scoreboard', {
        timeout: 10000,
      });
      if (response.status === 200 && response.data?.events) {
        return { healthy: true };
      }
      return { healthy: false, error: `Unexpected response: ${response.status}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { healthy: false, error: msg };
    }
  }

  /**
   * Check if the NFL API is healthy (simple boolean).
   */
  async isHealthy(): Promise<boolean> {
    const result = await this.testConnection();
    return result.healthy;
  }

  // ── News ──────────────────────────────────────────────────────

  /**
   * Fetch NFL news articles from ESPN.
   */
  async fetchNews(limit: number = 10, signal?: AbortSignal): Promise<ESPNNewsArticle[]> {
    const logLevel = config.getNflLoggingLevel();
    const cacheKey = `news-${limit}`;
    const cached = this.cache.get<ESPNNewsArticle[]>(cacheKey);
    if (cached !== null) {
      if (logLevel >= 1) logger.log('success', 'nfl', `NFL: news cache HIT — ${cached.length} article(s)`);
      return cached;
    }

    try {
      if (logLevel >= 1) logger.log('success', 'nfl', `NFL: Fetching /news (limit=${limit})`);
      const response = await this.client.get('/news', { signal });
      const data = response.data as ESPNNewsResponse;
      const articles = (data.articles || []).slice(0, limit);
      this.cache.set(cacheKey, articles, 300); // 5 minute cache
      if (logLevel >= 0) {
        logger.log('success', 'nfl', `NFL: News — ${articles.length} article(s) (cached 5m)`);
      }
      return articles;
    } catch (error) {
      if (isAbortError(error)) throw error;
      const hint = (error as { response?: { status?: number } })?.response?.status === 401
        ? ' — check NFL_BASE_URL in .env (should be ESPN)'
        : '';
      logger.logError('nfl', `Failed to fetch ESPN news: ${error}${hint}`);
      return [];
    }
  }

  /**
   * Format news articles into a readable numbered list.
   */
  formatNews(articles: ESPNNewsArticle[]): string {
    if (articles.length === 0) return 'No NFL news available.';

    const lines: string[] = ['📰 **NFL News**', ''];
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      const date = new Date(a.published).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
      });
      lines.push(`**${i + 1}.** ${a.headline}`);
      if (a.description) {
        lines.push(`   ${a.description}`);
      }
      lines.push(`   _${date}${a.byline ? ` — ${a.byline}` : ''}_`);
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }

  /**
   * Format news articles as AI-readable context for Ollama enhancement.
   */
  formatNewsContextForAI(articles: ESPNNewsArticle[]): string {
    if (articles.length === 0) return 'No NFL news data available.';

    const lines: string[] = ['NFL News Headlines'];
    for (const a of articles) {
      const date = new Date(a.published).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      lines.push(`- ${a.headline} (${date})`);
      if (a.description) lines.push(`  ${a.description}`);
    }
    return lines.join('\n');
  }

  // ── Formatting ────────────────────────────────────────────────

  /**
   * Format a single game score into a readable string with emoji indicators.
   */
  formatGame(game: NFLGameScore): string {
    const away = this.getTeamName(game.AwayTeam);
    const home = this.getTeamName(game.HomeTeam);

    if (game.Status === 'Scheduled') {
      const dateStr = game.Date ? new Date(game.Date).toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      }) : 'TBD';
      const channel = game.Channel ? ` 📺 ${game.Channel}` : '';
      return `⏰ **${away}** @ **${home}** — ${dateStr}${channel}`;
    }

    const awayScore = game.AwayScore ?? 0;
    const homeScore = game.HomeScore ?? 0;

    if (game.Status === 'InProgress') {
      const quarter = game.Quarter || '?';
      const time = game.TimeRemaining || '';
      const qDisplay = quarter === 'Half' ? 'Halftime' : `Q${quarter} ${time}`.trim();
      return `🏈 **${away}** ${awayScore} - **${home}** ${homeScore} (${qDisplay})`;
    }

    if (game.Status === 'Final' || game.Status === 'F/OT') {
      const suffix = game.Status === 'F/OT' ? ' (OT)' : '';
      return `✅ **${away}** ${awayScore} - **${home}** ${homeScore} (Final${suffix})`;
    }

    // Postponed, Delayed, Canceled, etc.
    return `⚠️ **${away}** @ **${home}** — ${game.Status}`;
  }

  /**
   * Format a Super Bowl game with extra detail.
   * Enhanced with ESPN data: records, broadcast info, situation.
   */
  formatSuperBowl(game: NFLGameScore): string {
    const lines: string[] = [];
    const espn = game._espn;
    const comp = espn?.competitions?.[0];

    // Title — use note headline if available (e.g. "Super Bowl LX")
    const sbHeadline = comp?.notes?.find(n => n.headline?.toLowerCase().includes('super bowl'))?.headline;
    lines.push(`🏈 **${sbHeadline || 'Super Bowl'}** 🏈`);

    if (game.StadiumDetails) {
      const stadium = game.StadiumDetails;
      lines.push(`🏟️ ${stadium.Name}, ${stadium.City}, ${stadium.State}`);
    }

    lines.push('');

    const away = this.getTeamName(game.AwayTeam);
    const home = this.getTeamName(game.HomeTeam);

    // Team records from ESPN
    const awayComp = comp?.competitors?.find((c: ESPNCompetitor) => c.homeAway === 'away');
    const homeComp = comp?.competitors?.find((c: ESPNCompetitor) => c.homeAway === 'home');
    const awayRecord = awayComp?.records?.find(r => r.type === 'total')?.summary;
    const homeRecord = homeComp?.records?.find(r => r.type === 'total')?.summary;

    if (game.Status === 'Scheduled') {
      const dateStr = game.Date ? new Date(game.Date).toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      }) : 'TBD';
      lines.push(`**${away}**${awayRecord ? ` (${awayRecord})` : ''} vs **${home}**${homeRecord ? ` (${homeRecord})` : ''}`);
      lines.push(`📅 ${dateStr}`);
      if (game.Channel) lines.push(`📺 ${game.Channel}`);
    } else if (game.Status === 'InProgress') {
      const awayScore = game.AwayScore ?? 0;
      const homeScore = game.HomeScore ?? 0;
      const quarter = game.Quarter || '?';
      const time = game.TimeRemaining || '';
      const qDisplay = quarter === 'Half' ? 'Halftime' : `Q${quarter} ${time}`.trim();

      lines.push(`**${away}**${awayRecord ? ` (${awayRecord})` : ''} ${awayScore}`);
      lines.push(`**${home}**${homeRecord ? ` (${homeRecord})` : ''} ${homeScore}`);
      lines.push('');
      lines.push(`📊 ${qDisplay}`);

      // Situation details (down & distance, possession, red zone)
      if (comp?.situation) {
        const sit = comp.situation;
        const parts: string[] = [];
        if (sit.possession) {
          const possTeam = sit.possession === awayComp?.id ? game.AwayTeam : game.HomeTeam;
          parts.push(`🏈 ${possTeam} ball`);
        }
        if (sit.down && sit.distance) {
          parts.push(`${sit.down}${ordinalSuffix(sit.down)} & ${sit.distance}`);
        }
        if (sit.yardLine) {
          parts.push(`at ${sit.yardLine}-yard line`);
        }
        if (sit.isRedZone) {
          parts.push('🔴 Red Zone');
        }
        if (parts.length > 0) lines.push(parts.join(' | '));

        if (sit.lastPlay?.text) {
          lines.push(`▶️ ${sit.lastPlay.text}`);
        }
      }

      if (game.Channel) lines.push(`📺 ${game.Channel}`);
    } else {
      const awayScore = game.AwayScore ?? 0;
      const homeScore = game.HomeScore ?? 0;
      const suffix = game.Status === 'F/OT' ? ' (OT)' : '';
      const winner = awayScore > homeScore ? away : home;

      lines.push(`**${away}**${awayRecord ? ` (${awayRecord})` : ''} ${awayScore}`);
      lines.push(`**${home}**${homeRecord ? ` (${homeRecord})` : ''} ${homeScore}`);
      lines.push('');
      lines.push(`🏆 **${winner}** wins!${suffix}`);
    }

    return lines.join('\n');
  }

  /**
   * Format multiple game scores as a list.
   */
  formatGameList(games: NFLGameScore[]): string {
    if (games.length === 0) {
      return 'No NFL games found for the current week.';
    }

    const lines: string[] = ['🏈 **NFL Scores**', ''];
    for (const game of games) {
      lines.push(this.formatGame(game));
    }
    return lines.join('\n');
  }

  /**
   * Format game data as AI-readable context for Ollama enhancement.
   */
  formatGamesContextForAI(games: NFLGameScore[]): string {
    if (games.length === 0) return 'No NFL games data available for the current week.';

    // Plain data lines — the caller (apiRouter) wraps with [NFL Game Data] markers
    const lines: string[] = ['NFL Scores - Current Week'];
    for (const game of games) {
      const away = this.getTeamName(game.AwayTeam);
      const home = this.getTeamName(game.HomeTeam);
      const awayScore = game.AwayScore ?? 0;
      const homeScore = game.HomeScore ?? 0;

      if (game.Status === 'Scheduled') {
        lines.push(`${away} @ ${home} - Scheduled: ${game.Date || 'TBD'}`);
      } else if (game.Status === 'InProgress') {
        lines.push(`${away} ${awayScore} - ${home} ${homeScore} (${game.Quarter || '?'} ${game.TimeRemaining || ''})`);
      } else {
        lines.push(`${away} ${awayScore} - ${home} ${homeScore} (${game.Status})`);
      }
    }
    return lines.join('\n');
  }

  // ── High-level request handler ────────────────────────────────

  /**
   * Handle an NFL keyword request.
   * Dispatches to the appropriate method based on the keyword and content.
   *
   * @param content - User's message content (after keyword stripping)
   * @param keyword - The matched keyword (e.g. "superbowl", "nfl scores", "nfl score", "nfl", "nfl news", "nfl news report")
   * @returns Formatted NFL response
   */
  async handleRequest(content: string, keyword: string, signal?: AbortSignal): Promise<NFLResponse> {
    if (!config.getNflEnabled()) {
      return { success: false, error: 'NFL features are currently disabled.' };
    }

    const lowerKeyword = keyword.toLowerCase();
    const logLevel = config.getNflLoggingLevel();

    // Parse explicit season/week from user content for diagnostics
    const parsed = parseSeasonWeek(content);
    const parsedInfo = (parsed.season || parsed.week)
      ? ` [parsed: season=${parsed.season ?? 'current'}, week=${parsed.week ?? 'current'}]`
      : '';

    if (logLevel >= 0) {
      logger.log('success', 'nfl', `NFL: handleRequest keyword="${keyword}" content="${content.length > 80 ? content.substring(0, 80) + '...' : content}"${parsedInfo}`);
    }

    try {
      if (lowerKeyword === 'superbowl') {
        return await this.handleSuperBowl(signal);
      }

      if (lowerKeyword === 'nfl scores') {
        return await this.handleAllScores(content, signal);
      }

      if (lowerKeyword === 'nfl score') {
        return await this.handleTeamScore(content, signal);
      }

      if (lowerKeyword === 'nfl news report') {
        return await this.handleNewsReport(content, signal);
      }

      if (lowerKeyword === 'nfl news') {
        return await this.handleNews(content, signal);
      }

      // Generic "nfl" keyword — fetch all current data for AI context
      if (lowerKeyword === 'nfl') {
        return await this.handleGenericNfl(content, signal);
      }

      return { success: false, error: `Unknown NFL keyword: ${keyword}` };
    } catch (error) {
      if (isAbortError(error)) {
        return { success: false, error: 'NFL request was cancelled or timed out. Please try again.' };
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.logError('nfl', `NFL request failed: ${msg}`);
      return { success: false, error: `NFL API error: ${msg}` };
    }
  }

  private async handleSuperBowl(signal?: AbortSignal): Promise<NFLResponse> {
    const game = await this.getSuperBowlGame(signal);
    if (!game) {
      const text = 'The Super Bowl game could not be found. It may not be scheduled yet, or the season may still be in progress.';
      return { success: true, data: { text } };
    }

    const text = this.formatSuperBowl(game);
    this.logResponsePayload('superbowl', text);
    return { success: true, data: { text, games: [game] } };
  }

  private async handleAllScores(content: string, signal?: AbortSignal): Promise<NFLResponse> {
    const parsed = parseSeasonWeek(content);
    const isExplicit = parsed.season !== undefined || parsed.week !== undefined;

    let games: NFLGameScore[];
    let label: string;

    if (isExplicit) {
      const season = parsed.season ?? new Date().getFullYear();
      const week = parsed.week ?? 1;
      games = await this.getScoresByWeek(season, week, signal);
      label = `${season} Week ${week}`;
    } else {
      games = await this.getCurrentWeekScores(signal);
      label = 'Current Week';
    }

    let text: string;
    if (games.length === 0) {
      text = isExplicit
        ? `No NFL games found for ${label}.`
        : 'No NFL games found for the current week.';
    } else {
      const header = isExplicit ? `🏈 **NFL Scores — ${label}**` : '🏈 **NFL Scores**';
      const lines = [header, ''];
      for (const game of games) {
        lines.push(this.formatGame(game));
      }
      text = lines.join('\n');
    }

    this.logResponsePayload('nfl scores', text);
    return { success: true, data: { text, games } };
  }

  private async handleTeamScore(content: string, signal?: AbortSignal): Promise<NFLResponse> {
    // Strip season/week tokens before resolving team name
    const parsed = parseSeasonWeek(content);
    const isExplicit = parsed.season !== undefined || parsed.week !== undefined;

    // Remove season/week patterns from content so team resolution works
    const teamQuery = content
      .replace(/\bw(?:ee)?k\s*\d{1,2}\b/gi, '')
      .replace(/\b20[12]\d\b/g, '')
      .replace(/[/\-]\d{1,2}\b/g, '')
      .trim();

    if (!teamQuery) {
      return { success: true, data: { text: 'Please specify a team name. Example: `nfl score chiefs`' } };
    }

    const teamAbbr = this.resolveTeam(teamQuery);
    if (!teamAbbr) {
      return { success: true, data: { text: `Could not find a team matching "${teamQuery}". Try a team name like "chiefs", "eagles", or "49ers".` } };
    }

    let game: NFLGameScore | null;

    if (isExplicit) {
      const season = parsed.season ?? new Date().getFullYear();
      const week = parsed.week ?? 1;

      const games = await this.getScoresByWeek(season, week, signal);
      const upper = teamAbbr.toUpperCase();
      game = games.find(g => g.HomeTeam === upper || g.AwayTeam === upper) || null;

      if (!game) {
        const teamName = this.getTeamName(teamAbbr);
        return { success: true, data: { text: `No game found for the **${teamName}** in ${season} Week ${week}.` } };
      }
    } else {
      game = await this.findTeamGame(teamAbbr, signal);
      if (!game) {
        const teamName = this.getTeamName(teamAbbr);
        return { success: true, data: { text: `No game found for the **${teamName}** this week.` } };
      }
    }

    const text = this.formatGame(game);
    this.logResponsePayload('nfl score', text);
    return { success: true, data: { text, games: [game] } };
  }

  private async handleNews(_content: string, signal?: AbortSignal): Promise<NFLResponse> {
    const articles = await this.fetchNews(5, signal);
    if (articles.length === 0) {
      return { success: true, data: { text: 'No NFL news available at this time.' } };
    }
    const text = this.formatNews(articles);
    this.logResponsePayload('nfl news', text);
    return { success: true, data: { text, articles } };
  }

  private async handleNewsReport(_content: string, signal?: AbortSignal): Promise<NFLResponse> {
    const articles = await this.fetchNews(11, signal);
    if (articles.length === 0) {
      return { success: true, data: { text: 'No NFL news available at this time.' } };
    }
    // Return AI-formatted context — apiRouter will pass through Ollama final pass
    const text = this.formatNewsContextForAI(articles);
    this.logResponsePayload('nfl news report', text);
    return { success: true, data: { text, articles } };
  }

  private async handleGenericNfl(content: string, signal?: AbortSignal): Promise<NFLResponse> {
    // For the generic "nfl" keyword, fetch scores and return as structured
    // data. If finalOllamaPass is configured on the keyword, apiRouter will
    // pass this through Ollama for conversational response.
    const parsed = parseSeasonWeek(content);
    const isExplicit = parsed.season !== undefined || parsed.week !== undefined;

    let games: NFLGameScore[];
    let label: string;

    if (isExplicit) {
      const season = parsed.season ?? new Date().getFullYear();
      const week = parsed.week ?? 1;
      games = await this.getScoresByWeek(season, week, signal);
      label = `${season} Week ${week}`;
    } else {
      games = await this.getCurrentWeekScores(signal);
      label = 'Current Week';
    }

    let text = games.length === 0
      ? `No NFL games data available for ${label}.`
      : `NFL Scores - ${label}\n` + games.map(game => {
          const away = this.getTeamName(game.AwayTeam);
          const home = this.getTeamName(game.HomeTeam);
          const awayScore = game.AwayScore ?? 0;
          const homeScore = game.HomeScore ?? 0;
          if (game.Status === 'Scheduled') {
            return `${away} @ ${home} - Scheduled: ${game.Date || 'TBD'}`;
          } else if (game.Status === 'InProgress') {
            return `${away} ${awayScore} - ${home} ${homeScore} (${game.Quarter || '?'} ${game.TimeRemaining || ''})`;
          } else {
            return `${away} ${awayScore} - ${home} ${homeScore} (${game.Status})`;
          }
        }).join('\n');

    // Add scope note when the request implies data beyond what was fetched
    if (!isExplicit) {
      const scopePatterns = /playoff|postseason|season|championship|divisional|wild\s*card|conference|\b20[12]\d\b/i;
      if (scopePatterns.test(content)) {
        text += '\n\nNote: The data above reflects the current week\'s games only. For historical results, try specifying a season and week (e.g., "nfl scores week 4 2025").';
      }
    }

    this.logResponsePayload('nfl', text);
    return { success: true, data: { text, games } };
  }

  // ── Logging helpers ───────────────────────────────────────────

  /**
   * Log the formatted response payload at the configured verbosity.
   *   Level 0: length summary only
   *   Level 1: trimmed preview (first 200 chars)
   *   Level 2: full payload
   */
  private logResponsePayload(keyword: string, text: string): void {
    const logLevel = config.getNflLoggingLevel();
    if (logLevel <= 0) {
      logger.log('success', 'nfl', `NFL: [${keyword}] response — ${text.length} chars`);
      return;
    }
    if (logLevel === 1) {
      const preview = text.length > 200 ? text.substring(0, 200) + '...' : text;
      logger.log('success', 'nfl', `NFL: [${keyword}] response (${text.length} chars): ${preview}`);
      return;
    }
    // Level 2 — full payload
    logger.log('success', 'nfl', `NFL: [${keyword}] response (${text.length} chars):\n${text}`);
  }

  /**
   * Check whether a keyword can operate with no additional user content.
   * Used by the message handler to skip the empty-content guard.
   */
  static allowsEmptyContent(keyword: string): boolean {
    const lower = keyword.toLowerCase();
    return lower === 'nfl scores' || lower === 'superbowl' || lower === 'nfl'
      || lower === 'nfl news' || lower === 'nfl news report';
  }
}

/**
 * Ordinal suffix for numbers (1st, 2nd, 3rd, 4th).
 */
function ordinalSuffix(n: number): string {
  if (n >= 11 && n <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

export const nflClient = new NFLClient();
