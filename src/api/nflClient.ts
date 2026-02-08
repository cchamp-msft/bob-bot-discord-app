import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { NFLGameScore, NFLResponse, NFLHealthResult } from '../types';

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

const NFL_BASE_URL = 'https://api.sportsdata.io/v3/nfl/scores';

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

/**
 * Simple in-memory cache for NFL API responses.
 */
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

export class NFLClient {
  private client: AxiosInstance;
  private cache = new NFLCache();

  constructor() {
    this.client = axios.create({
      baseURL: config.getNflEndpoint() || NFL_BASE_URL,
    });
  }

  /**
   * Rebuild the axios instance with the current endpoint from config.
   */
  refresh(): void {
    const baseURL = config.getNflEndpoint() || NFL_BASE_URL;
    this.client = axios.create({ baseURL });
    this.cache.clear();
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

  // ── API Endpoints ─────────────────────────────────────────────

  /**
   * Fetch current week number from SportsData.io.
   */
  async getCurrentWeek(signal?: AbortSignal): Promise<number | null> {
    const logLevel = config.getNflLoggingLevel();
    const cached = this.cache.get<number>('currentWeek');
    if (cached !== null) {
      if (logLevel >= 1) logger.log('success', 'nfl', `NFL: currentWeek cache HIT — week ${cached}`);
      return cached;
    }

    const apiKey = config.getNflApiKey();
    if (!apiKey) return null;

    try {
      if (logLevel >= 1) logger.log('success', 'nfl', 'NFL: Fetching /json/CurrentWeek');
      const response = await this.client.get('/json/CurrentWeek', {
        params: { key: apiKey },
        signal,
      });
      const week = response.data as number;
      this.cache.set('currentWeek', week, 3600); // cache 1 hour
      if (logLevel >= 0) logger.log('success', 'nfl', `NFL: currentWeek = ${week} (cached 1h)`);
      return week;
    } catch (error) {
      if (isAbortError(error)) throw error;
      logger.logError('nfl', `Failed to fetch current week: ${error}`);
      return null;
    }
  }

  /**
   * Fetch current season year from SportsData.io.
   */
  async getCurrentSeason(signal?: AbortSignal): Promise<number | null> {
    const logLevel = config.getNflLoggingLevel();
    const cached = this.cache.get<number>('currentSeason');
    if (cached !== null) {
      if (logLevel >= 1) logger.log('success', 'nfl', `NFL: currentSeason cache HIT — season ${cached}`);
      return cached;
    }

    const apiKey = config.getNflApiKey();
    if (!apiKey) return null;

    try {
      if (logLevel >= 1) logger.log('success', 'nfl', 'NFL: Fetching /json/CurrentSeason');
      const response = await this.client.get('/json/CurrentSeason', {
        params: { key: apiKey },
        signal,
      });
      const season = response.data as number;
      this.cache.set('currentSeason', season, 86400); // cache 24 hours
      if (logLevel >= 0) logger.log('success', 'nfl', `NFL: currentSeason = ${season} (cached 24h)`);
      return season;
    } catch (error) {
      if (isAbortError(error)) throw error;
      logger.logError('nfl', `Failed to fetch current season: ${error}`);
      return null;
    }
  }

  /**
   * Fetch scores for a specific season and week using the lightweight
   * ScoresBasic endpoint. Best for current-week quick lookups.
   */
  async getScores(season: number, week: number, signal?: AbortSignal): Promise<NFLGameScore[]> {
    return this.fetchScores(season, week, 'ScoresBasic', signal);
  }

  /**
   * Fetch scores using the full ScoresByWeek endpoint.
   * Preferred for explicit/historical week queries where data accuracy
   * matters more than payload size.
   */
  async getScoresByWeek(season: number, week: number, signal?: AbortSignal): Promise<NFLGameScore[]> {
    return this.fetchScores(season, week, 'ScoresByWeek', signal);
  }

  /**
   * Internal shared fetch for both ScoresBasic and ScoresByWeek endpoints.
   */
  private async fetchScores(
    season: number,
    week: number,
    endpointType: 'ScoresBasic' | 'ScoresByWeek',
    signal?: AbortSignal
  ): Promise<NFLGameScore[]> {
    const logLevel = config.getNflLoggingLevel();
    const cacheKey = `scores-${endpointType}-${season}-${week}`;
    const cached = this.cache.get<NFLGameScore[]>(cacheKey);
    if (cached !== null) {
      if (logLevel >= 1) logger.log('success', 'nfl', `NFL: scores cache HIT — ${cacheKey} (${cached.length} game(s))`);
      return cached;
    }

    const apiKey = config.getNflApiKey();
    if (!apiKey) return [];

    try {
      const endpoint = `/json/${endpointType}/${season}/${week}`;
      if (logLevel >= 1) logger.log('success', 'nfl', `NFL: Fetching ${endpoint}`);
      const response = await this.client.get(endpoint, {
        params: { key: apiKey },
        signal,
      });
      const games = response.data as NFLGameScore[];

      // Use short cache for in-progress games, longer for final scores
      const hasLive = games.some(g => g.Status === 'InProgress');
      const ttl = hasLive ? 60 : 300; // 1 min live, 5 min otherwise
      this.cache.set(cacheKey, games, ttl);

      // Summarize game statuses
      const statusCounts: Record<string, number> = {};
      for (const g of games) {
        statusCounts[g.Status] = (statusCounts[g.Status] || 0) + 1;
      }
      const statusSummary = Object.entries(statusCounts).map(([s, c]) => `${s}:${c}`).join(', ');
      if (logLevel >= 0) {
        logger.log('success', 'nfl', `NFL: Scores ${season}/wk${week} via ${endpointType} — ${games.length} game(s) [${statusSummary}] (cached ${ttl}s)`);
      }

      // Validate returned data matches the requested season/week
      this.validateScoresData(games, season, week, endpointType);

      return games;
    } catch (error) {
      if (isAbortError(error)) throw error;
      logger.logError('nfl', `Failed to fetch scores for ${season} week ${week} via ${endpointType}: ${error}`);
      return [];
    }
  }

  /**
   * Validate that returned scores data matches the requested season/week.
   * Logs a warning if mismatches are detected, which may indicate a
   * sandbox/trial API key returning sample data.
   */
  private validateScoresData(
    games: NFLGameScore[],
    expectedSeason: number,
    expectedWeek: number,
    endpointType: string
  ): void {
    if (games.length === 0) return;

    const mismatched = games.filter(
      g => (g.Season && g.Season !== expectedSeason) || (g.Week && g.Week !== expectedWeek)
    );

    if (mismatched.length > 0) {
      const sample = mismatched[0];
      logger.logError(
        'nfl',
        `NFL DATA VALIDATION WARNING: Requested ${expectedSeason}/wk${expectedWeek} via ${endpointType} ` +
        `but received games with Season=${sample.Season}, Week=${sample.Week}. ` +
        `${mismatched.length}/${games.length} game(s) mismatched. ` +
        `This may indicate a sandbox/trial API key returning sample data. ` +
        `Verify your NFL_API_KEY has production access at sportsdata.io.`
      );
    }
  }

  /**
   * Fetch the current week's game scores.
   */
  async getCurrentWeekScores(signal?: AbortSignal): Promise<NFLGameScore[]> {
    const [season, week] = await Promise.all([
      this.getCurrentSeason(signal),
      this.getCurrentWeek(signal),
    ]);

    if (!season || !week) {
      logger.logError('nfl', 'Could not determine current season/week');
      return [];
    }

    return this.getScores(season, week, signal);
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
   * Find the Super Bowl game. Searches postseason weeks for the championship game.
   * The Super Bowl is typically the last game of week 22 (conference champ round is 21).
   * SportsData.io uses SeasonType 3 for postseason.
   */
  async getSuperBowlGame(signal?: AbortSignal): Promise<NFLGameScore | null> {
    const season = await this.getCurrentSeason(signal);
    if (!season) return null;

    // Try the postseason Super Bowl week (typically week 4 of postseason = overall week 22)
    // SportsData.io postseason weeks: WildCard=1, Divisional=2, ConfChamp=3, SuperBowl=4
    // But scores endpoint uses sequential week numbers for the full season
    // Postseason starts at week 18 (after 17 regular season weeks + bye)
    // Super Bowl is usually week 22
    for (const week of [22, 21, 23]) {
      try {
        const games = await this.getScores(season, week, signal);
        // Super Bowl is the only game in its week with SeasonType 3
        const sb = games.find(g => g.SeasonType === 3 && games.filter(x => x.SeasonType === 3).length <= 1);
        if (sb) return sb;

        // Fallback: if only one game in the week, it's likely the Super Bowl
        if (games.length === 1 && games[0].SeasonType === 3) return games[0];
      } catch (error) {
        if (isAbortError(error)) throw error;
        // Week doesn't exist yet, continue
      }
    }

    return null;
  }

  /**
   * Test NFL API connection and return health status.
   */
  async testConnection(): Promise<NFLHealthResult> {
    const apiKey = config.getNflApiKey();
    if (!apiKey) {
      return { healthy: false, error: 'NFL_API_KEY is not configured' };
    }

    try {
      const response = await this.client.get('/json/CurrentSeason', {
        params: { key: apiKey },
        timeout: 10000,
      });
      if (response.status === 200 && typeof response.data === 'number') {
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
   */
  formatSuperBowl(game: NFLGameScore): string {
    const lines: string[] = [];
    lines.push('🏈 **Super Bowl** 🏈');

    if (game.StadiumDetails) {
      const stadium = game.StadiumDetails;
      lines.push(`🏟️ ${stadium.Name}, ${stadium.City}, ${stadium.State}`);
    }

    lines.push('');

    const away = this.getTeamName(game.AwayTeam);
    const home = this.getTeamName(game.HomeTeam);

    if (game.Status === 'Scheduled') {
      const dateStr = game.Date ? new Date(game.Date).toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      }) : 'TBD';
      lines.push(`**${away}** vs **${home}**`);
      lines.push(`📅 ${dateStr}`);
      if (game.Channel) lines.push(`📺 ${game.Channel}`);
    } else if (game.Status === 'InProgress') {
      const awayScore = game.AwayScore ?? 0;
      const homeScore = game.HomeScore ?? 0;
      const quarter = game.Quarter || '?';
      const time = game.TimeRemaining || '';
      const qDisplay = quarter === 'Half' ? 'Halftime' : `Q${quarter} ${time}`.trim();

      lines.push(`**${away}** ${awayScore}`);
      lines.push(`**${home}** ${homeScore}`);
      lines.push('');
      lines.push(`📊 ${qDisplay}`);
      if (game.Channel) lines.push(`📺 ${game.Channel}`);
    } else {
      const awayScore = game.AwayScore ?? 0;
      const homeScore = game.HomeScore ?? 0;
      const suffix = game.Status === 'F/OT' ? ' (OT)' : '';
      const winner = awayScore > homeScore ? away : home;

      lines.push(`**${away}** ${awayScore}`);
      lines.push(`**${home}** ${homeScore}`);
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
   * @param keyword - The matched keyword (e.g. "superbowl", "nfl scores", "nfl score", "nfl")
   * @returns Formatted NFL response
   */
  async handleRequest(content: string, keyword: string, signal?: AbortSignal): Promise<NFLResponse> {
    if (!config.getNflEnabled()) {
      return { success: false, error: 'NFL features are currently disabled.' };
    }

    const apiKey = config.getNflApiKey();
    if (!apiKey) {
      return { success: false, error: 'NFL API key is not configured. Set NFL_API_KEY in your environment.' };
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
      // No Super Bowl game found — report what we know
      const season = await this.getCurrentSeason(signal);
      const text = season
        ? `The Super Bowl game could not be found for the ${season} season. It may not be scheduled yet, or the season may still be in progress.`
        : 'Could not determine the current NFL season.';
      return { success: true, data: { text } };
    }

    const text = this.formatSuperBowl(game);
    this.logResponsePayload('superbowl', text);
    return { success: true, data: { text, games: [game] } };
  }

  private async handleAllScores(content: string, signal?: AbortSignal): Promise<NFLResponse> {
    const parsed = parseSeasonWeek(content);
    const isExplicit = parsed.season !== undefined || parsed.week !== undefined;

    let season: number | null;
    let week: number | null;
    let games: NFLGameScore[];

    if (isExplicit) {
      // Resolve missing fields from current season/week
      const [curSeason, curWeek] = await Promise.all([
        parsed.season ? Promise.resolve(parsed.season) : this.getCurrentSeason(signal),
        parsed.week ? Promise.resolve(parsed.week) : this.getCurrentWeek(signal),
      ]);
      season = curSeason;
      week = curWeek;

      if (!season || !week) {
        return { success: true, data: { text: 'Could not determine season/week. Please try again.' } };
      }

      // Use ScoresByWeek for explicit/historical queries
      games = await this.getScoresByWeek(season, week, signal);
    } else {
      // Current week — use lighter ScoresBasic endpoint
      games = await this.getCurrentWeekScores(signal);
      season = games.length > 0 ? games[0].Season : null;
      week = games.length > 0 ? games[0].Week : null;
    }

    const label = isExplicit && season && week
      ? `${season} Week ${week}`
      : 'Current Week';

    let text: string;
    if (games.length === 0) {
      text = isExplicit && season && week
        ? `No NFL games found for ${season} Week ${week}.`
        : 'No NFL games found for the current week.';
    } else {
      const header = isExplicit ? `🏈 **NFL Scores — ${label}**` : '🏈 **NFL Scores**';
      const lines = [header, ''];
      for (const game of games) {
        lines.push(this.formatGame(game));
      }

      // Append data-quality warning if validation detected mismatches
      if (isExplicit && season && week) {
        const mismatched = games.filter(
          g => (g.Season && g.Season !== season) || (g.Week && g.Week !== week)
        );
        if (mismatched.length > 0) {
          lines.push('');
          lines.push(
            `⚠️ **Data quality notice:** The API returned data that may not match the requested ` +
            `${season} Week ${week}. Your API key may be a trial/sandbox key returning sample data. ` +
            `Verify your key at sportsdata.io.`
          );
        }
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
      const [season, week] = await Promise.all([
        parsed.season ? Promise.resolve(parsed.season) : this.getCurrentSeason(signal),
        parsed.week ? Promise.resolve(parsed.week) : this.getCurrentWeek(signal),
      ]);

      if (!season || !week) {
        return { success: true, data: { text: 'Could not determine season/week. Please try again.' } };
      }

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

  private async handleGenericNfl(content: string, signal?: AbortSignal): Promise<NFLResponse> {
    // For the generic "nfl" keyword, fetch scores and return as structured
    // data. If finalOllamaPass is configured on the keyword, apiRouter will
    // pass this through Ollama for conversational response.
    const parsed = parseSeasonWeek(content);
    const isExplicit = parsed.season !== undefined || parsed.week !== undefined;

    let games: NFLGameScore[];
    let label: string;

    if (isExplicit) {
      const [season, week] = await Promise.all([
        parsed.season ? Promise.resolve(parsed.season) : this.getCurrentSeason(signal),
        parsed.week ? Promise.resolve(parsed.week) : this.getCurrentWeek(signal),
      ]);

      if (!season || !week) {
        return { success: true, data: { text: 'Could not determine season/week for your query.' } };
      }

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
        text += '\n\nNote: The data above reflects the current week\'s games only. Historical, postseason, and full-season results are not available through this data source.';
      }
    }

    // Append data-quality warning if validation detected mismatches
    if (isExplicit && games.length > 0) {
      const reqSeason = parsed.season ?? games[0]?.Season;
      const reqWeek = parsed.week ?? games[0]?.Week;
      const mismatched = games.filter(
        g => (g.Season && g.Season !== reqSeason) || (g.Week && g.Week !== reqWeek)
      );
      if (mismatched.length > 0) {
        text += '\n\n⚠️ Data quality notice: The API returned data that may not match the requested ' +
          `${label}. Your API key may be a trial/sandbox key returning sample data.`;
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
    return lower === 'nfl scores' || lower === 'superbowl' || lower === 'nfl';
  }
}

export const nflClient = new NFLClient();
