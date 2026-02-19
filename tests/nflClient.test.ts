/**
 * NFLClient tests — exercises ESPN adapter mapping, team resolution,
 * game formatting, news fetching/formatting, health checks, and the
 * high-level handleRequest dispatcher.
 * Uses axios mocking; no real ESPN instance required.
 */

import _axios from 'axios';

const mockInstance = {
  get: jest.fn(),
  defaults: { baseURL: '' },
};

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => mockInstance),
  },
}));

jest.mock('../src/utils/config', () => ({
  config: {
    getNflEndpoint: jest.fn(() => 'https://site.api.espn.com/apis/site/v2/sports/football/nfl'),
    getNflEnabled: jest.fn(() => true),
    getNflLoggingLevel: jest.fn(() => 1),
    getDebugLogging: jest.fn(() => false),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
  },
}));

import {
  nflClient, parseSeasonWeek,
  mapESPNEventToGame, mapESPNScoreboard,
  isEspnHost,
} from '../src/api/nflClient';
import { config } from '../src/utils/config';
import {
  ESPNEvent, ESPNScoreboardResponse,
  ESPNCompetitor, ESPNNewsArticle,
} from '../src/types';

// ── ESPN fixture helpers ─────────────────────────────────────

function makeESPNCompetitor(overrides: Partial<ESPNCompetitor> = {}, homeAway: 'home' | 'away' = 'home'): ESPNCompetitor {
  return {
    id: homeAway === 'home' ? '100' : '200',
    homeAway,
    team: {
      id: homeAway === 'home' ? '100' : '200',
      abbreviation: homeAway === 'home' ? 'BAL' : 'KC',
      displayName: homeAway === 'home' ? 'Baltimore Ravens' : 'Kansas City Chiefs',
      shortDisplayName: homeAway === 'home' ? 'Ravens' : 'Chiefs',
      location: homeAway === 'home' ? 'Baltimore' : 'Kansas City',
      name: homeAway === 'home' ? 'Ravens' : 'Chiefs',
      color: '241773',
      logo: 'https://a.espncdn.com/logo.png',
    },
    score: '0',
    records: [{ name: 'overall', type: 'total', summary: '10-7' }],
    ...overrides,
  };
}

function makeESPNEvent(overrides: Partial<ESPNEvent> = {}): ESPNEvent {
  const status: ESPNEvent['status'] = overrides.competitions?.[0]?.status ?? {
    clock: 0,
    displayClock: '0:00',
    period: 0,
    type: {
      id: '1',
      name: 'STATUS_SCHEDULED',
      state: 'pre',
      completed: false,
      description: 'Scheduled',
      detail: 'Sun, Sep 7 at 4:20 PM EDT',
      shortDetail: '9/7 - 4:20 PM EDT',
    },
  };
  const base: ESPNEvent = {
    id: '401547417',
    uid: 's:20~l:28~e:401547417',
    date: '2025-09-07T20:20:00Z',
    name: 'Kansas City Chiefs at Baltimore Ravens',
    shortName: 'KC @ BAL',
    season: { year: 2025, type: 2 },
    week: { number: 1 },
    status,
    competitions: [{
      id: '401547417',
      date: '2025-09-07T20:20:00Z',
      competitors: [
        makeESPNCompetitor({}, 'home'),
        makeESPNCompetitor({}, 'away'),
      ],
      status,
      venue: {
        id: '3814',
        fullName: 'M&T Bank Stadium',
        address: { city: 'Baltimore', state: 'MD', country: 'USA' },
        indoor: false,
      },
      broadcast: 'NBC',
    }],
  };
  return { ...base, ...overrides } as ESPNEvent;
}

function makeESPNScoreboard(events: ESPNEvent[]): ESPNScoreboardResponse {
  return {
    leagues: [{
      season: { year: 2025, type: 2 },
    }],
    season: { type: 2, year: 2025 },
    week: { number: 1 },
    events,
  };
}

/**
 * Create a scheduled ESPN event with default competitors (KC @ BAL).
 */
function scheduledEvent(): ESPNEvent {
  return makeESPNEvent();
}

/**
 * Create a live ESPN event.
 */
function liveEvent(): ESPNEvent {
  return makeESPNEvent({
    id: '401547418',
    competitions: [{
      id: '401547418',
      date: '2025-09-07T20:20:00Z',
      competitors: [
        makeESPNCompetitor({ score: '10' }, 'home'),
        makeESPNCompetitor({ score: '14' }, 'away'),
      ],
      status: {
        clock: 522,
        displayClock: '8:42',
        period: 3,
        type: {
          id: '2',
          name: 'STATUS_IN_PROGRESS',
          state: 'in',
          completed: false,
          description: 'In Progress',
          detail: '8:42 - 3rd Quarter',
          shortDetail: '8:42 - 3rd',
        },
      },
      venue: {
        id: '3814',
        fullName: 'M&T Bank Stadium',
        address: { city: 'Baltimore', state: 'MD', country: 'USA' },
        indoor: false,
      },
      broadcast: 'NBC',
    }],
  });
}

/**
 * Create a final ESPN event (PHI vs DAL).
 */
function finalEvent(): ESPNEvent {
  return makeESPNEvent({
    id: '401547419',
    name: 'Philadelphia Eagles at Dallas Cowboys',
    shortName: 'PHI @ DAL',
    competitions: [{
      id: '401547419',
      date: '2025-09-07T13:00:00Z',
      competitors: [
        makeESPNCompetitor({
          id: '300',
          score: '21',
          team: {
            id: '300',
            abbreviation: 'DAL',
            displayName: 'Dallas Cowboys',
            shortDisplayName: 'Cowboys',
            location: 'Dallas',
            name: 'Cowboys',
            color: '003594',
            logo: 'https://a.espncdn.com/logo.png',
          },
        }, 'home'),
        makeESPNCompetitor({
          id: '400',
          score: '28',
          team: {
            id: '400',
            abbreviation: 'PHI',
            displayName: 'Philadelphia Eagles',
            shortDisplayName: 'Eagles',
            location: 'Philadelphia',
            name: 'Eagles',
            color: '004C54',
            logo: 'https://a.espncdn.com/logo.png',
          },
        }, 'away'),
      ],
      status: {
        clock: 0,
        displayClock: '0:00',
        period: 4,
        type: {
          id: '3',
          name: 'STATUS_FINAL',
          state: 'post',
          completed: true,
          description: 'Final',
          detail: 'Final',
          shortDetail: 'Final',
        },
      },
      venue: {
        id: '3687',
        fullName: 'AT&T Stadium',
        address: { city: 'Arlington', state: 'TX', country: 'USA' },
        indoor: true,
      },
      broadcast: 'FOX',
    }],
  });
}

/**
 * Create an overtime final event.
 */
function overtimeEvent(): ESPNEvent {
  return makeESPNEvent({
    id: '401547420',
    name: 'Buffalo Bills at Miami Dolphins',
    shortName: 'BUF @ MIA',
    competitions: [{
      id: '401547420',
      date: '2025-09-07T13:00:00Z',
      competitors: [
        makeESPNCompetitor({
          id: '500',
          score: '28',
          team: {
            id: '500',
            abbreviation: 'MIA',
            displayName: 'Miami Dolphins',
            shortDisplayName: 'Dolphins',
            location: 'Miami',
            name: 'Dolphins',
            color: '008E97',
            logo: 'https://a.espncdn.com/logo.png',
          },
        }, 'home'),
        makeESPNCompetitor({
          id: '600',
          score: '31',
          team: {
            id: '600',
            abbreviation: 'BUF',
            displayName: 'Buffalo Bills',
            shortDisplayName: 'Bills',
            location: 'Buffalo',
            name: 'Bills',
            color: '00338D',
            logo: 'https://a.espncdn.com/logo.png',
          },
        }, 'away'),
      ],
      status: {
        clock: 0,
        displayClock: '0:00',
        period: 5,
        type: {
          id: '3',
          name: 'STATUS_FINAL',
          state: 'post',
          completed: true,
          description: 'Final/OT',
          detail: 'Final/OT',
          shortDetail: 'Final/OT',
        },
      },
      venue: {
        id: '3948',
        fullName: 'Hard Rock Stadium',
        address: { city: 'Miami Gardens', state: 'FL', country: 'USA' },
        indoor: false,
      },
      broadcast: 'CBS',
    }],
  });
}

/**
 * Create a news article fixture.
 */
function makeNewsArticle(overrides: Partial<ESPNNewsArticle> = {}): ESPNNewsArticle {
  return {
    id: 12345,
    headline: 'Chiefs Sign Key Free Agent',
    description: 'The Kansas City Chiefs have signed a major free agent to bolster their roster.',
    published: '2025-03-15T12:00:00Z',
    type: 'Story',
    links: { web: { href: 'https://espn.com/article/1' } },
    ...overrides,
  };
}


// ── Tests ────────────────────────────────────────────────────

describe('NFLClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (nflClient as any).cache.clear();
  });

  // ── ESPN Adapter: mapESPNEventToGame ───────────────────────

  describe('mapESPNEventToGame', () => {
    it('should map a scheduled event correctly', () => {
      const game = mapESPNEventToGame(scheduledEvent());
      expect(game.GameKey).toBe('401547417');
      expect(game.Season).toBe(2025);
      expect(game.SeasonType).toBe(2);
      expect(game.Week).toBe(1);
      expect(game.AwayTeam).toBe('KC');
      expect(game.HomeTeam).toBe('BAL');
      expect(game.AwayScore).toBeNull();
      expect(game.HomeScore).toBeNull();
      expect(game.Status).toBe('Scheduled');
      expect(game.Quarter).toBeNull();
      expect(game.TimeRemaining).toBeNull();
      expect(game.Channel).toBe('NBC');
      expect(game.IsClosed).toBe(false);
      expect(game.StadiumDetails).toEqual({
        Name: 'M&T Bank Stadium',
        City: 'Baltimore',
        State: 'MD',
        Country: 'USA',
      });
    });

    it('should map a live event with scores and clock', () => {
      const game = mapESPNEventToGame(liveEvent());
      expect(game.Status).toBe('InProgress');
      expect(game.AwayScore).toBe(14);
      expect(game.HomeScore).toBe(10);
      expect(game.Quarter).toBe('3');
      expect(game.TimeRemaining).toBe('8:42');
    });

    it('should map a final event', () => {
      const game = mapESPNEventToGame(finalEvent());
      expect(game.Status).toBe('Final');
      expect(game.AwayTeam).toBe('PHI');
      expect(game.HomeTeam).toBe('DAL');
      expect(game.AwayScore).toBe(28);
      expect(game.HomeScore).toBe(21);
      expect(game.IsClosed).toBe(true);
    });

    it('should map an overtime game with F/OT status', () => {
      const game = mapESPNEventToGame(overtimeEvent());
      expect(game.Status).toBe('F/OT');
      expect(game.IsClosed).toBe(true);
    });

    it('should map odds when present', () => {
      const event = scheduledEvent();
      event.competitions[0].odds = [{
        spread: -3.5,
        overUnder: 47.5,
        homeTeamOdds: { moneyLine: -180 },
        awayTeamOdds: { moneyLine: 150 },
      }];
      const game = mapESPNEventToGame(event);
      expect(game.PointSpread).toBe(-3.5);
      expect(game.OverUnder).toBe(47.5);
      expect(game.HomeTeamMoneyLine).toBe(-180);
      expect(game.AwayTeamMoneyLine).toBe(150);
    });

    it('should set null odds when absent', () => {
      const game = mapESPNEventToGame(scheduledEvent());
      expect(game.PointSpread).toBeNull();
      expect(game.OverUnder).toBeNull();
      expect(game.HomeTeamMoneyLine).toBeNull();
      expect(game.AwayTeamMoneyLine).toBeNull();
    });

    it('should include _espn reference to original event', () => {
      const event = scheduledEvent();
      const game = mapESPNEventToGame(event);
      expect(game._espn).toBe(event);
    });

    it('should handle event without venue', () => {
      const event = scheduledEvent();
      delete (event.competitions[0] as any).venue;
      const game = mapESPNEventToGame(event);
      expect(game.StadiumDetails).toBeNull();
    });
  });

  describe('mapESPNScoreboard', () => {
    it('should map multiple events', () => {
      const response = makeESPNScoreboard([scheduledEvent(), liveEvent(), finalEvent()]);
      const games = mapESPNScoreboard(response);
      expect(games).toHaveLength(3);
      expect(games[0].Status).toBe('Scheduled');
      expect(games[1].Status).toBe('InProgress');
      expect(games[2].Status).toBe('Final');
    });

    it('should return empty array for empty events', () => {
      const response = makeESPNScoreboard([]);
      expect(mapESPNScoreboard(response)).toEqual([]);
    });

    it('should return empty array for missing events field', () => {
      const response = { leagues: [], season: { type: 2, year: 2025 }, week: { number: 1 } } as any;
      expect(mapESPNScoreboard(response)).toEqual([]);
    });
  });

  // ── Team resolution ────────────────────────────────────────

  describe('resolveTeam', () => {
    it('should resolve team abbreviations (case-insensitive)', () => {
      expect(nflClient.resolveTeam('KC')).toBe('KC');
      expect(nflClient.resolveTeam('kc')).toBe('KC');
      expect(nflClient.resolveTeam('PHI')).toBe('PHI');
    });

    it('should resolve team nicknames', () => {
      expect(nflClient.resolveTeam('chiefs')).toBe('KC');
      expect(nflClient.resolveTeam('eagles')).toBe('PHI');
      expect(nflClient.resolveTeam('49ers')).toBe('SF');
      expect(nflClient.resolveTeam('niners')).toBe('SF');
      expect(nflClient.resolveTeam('pats')).toBe('NE');
    });

    it('should resolve city names', () => {
      expect(nflClient.resolveTeam('kansas city')).toBe('KC');
      expect(nflClient.resolveTeam('philadelphia')).toBe('PHI');
      expect(nflClient.resolveTeam('philly')).toBe('PHI');
      expect(nflClient.resolveTeam('green bay')).toBe('GB');
    });

    it('should return null for unknown teams', () => {
      expect(nflClient.resolveTeam('unknown')).toBeNull();
      expect(nflClient.resolveTeam('')).toBeNull();
      expect(nflClient.resolveTeam('   ')).toBeNull();
    });
  });

  describe('getTeamName', () => {
    it('should return full team name for abbreviation', () => {
      expect(nflClient.getTeamName('KC')).toBe('Kansas City Chiefs');
      expect(nflClient.getTeamName('PHI')).toBe('Philadelphia Eagles');
    });

    it('should return the abbreviation if unknown', () => {
      expect(nflClient.getTeamName('XYZ')).toBe('XYZ');
    });
  });

  // ── Formatting ─────────────────────────────────────────────

  describe('formatGame', () => {
    it('should format a scheduled game', () => {
      const game = mapESPNEventToGame(scheduledEvent());
      const text = nflClient.formatGame(game);
      expect(text).toContain('⏰');
      expect(text).toContain('Kansas City Chiefs');
      expect(text).toContain('Baltimore Ravens');
      expect(text).toContain('NBC');
    });

    it('should format a live game', () => {
      const game = mapESPNEventToGame(liveEvent());
      const text = nflClient.formatGame(game);
      expect(text).toContain('🏈');
      expect(text).toContain('14');
      expect(text).toContain('10');
      expect(text).toContain('Q3');
      expect(text).toContain('8:42');
    });

    it('should format a final game', () => {
      const game = mapESPNEventToGame(finalEvent());
      const text = nflClient.formatGame(game);
      expect(text).toContain('✅');
      expect(text).toContain('28');
      expect(text).toContain('21');
      expect(text).toContain('Final');
    });

    it('should format an overtime game', () => {
      const game = mapESPNEventToGame(overtimeEvent());
      const text = nflClient.formatGame(game);
      expect(text).toContain('✅');
      expect(text).toContain('OT');
    });

    it('should format a postponed game', () => {
      const event = scheduledEvent();
      event.competitions[0].status.type.state = 'post';
      event.competitions[0].status.type.name = 'STATUS_POSTPONED';
      const game = mapESPNEventToGame(event);
      const text = nflClient.formatGame(game);
      expect(text).toContain('⚠️');
      expect(text).toContain('Postponed');
    });
  });

  describe('formatGameList', () => {
    it('should show "no games" message for empty list', () => {
      const text = nflClient.formatGameList([]);
      expect(text).toContain('No NFL games found');
    });

    it('should format multiple games', () => {
      const games = [scheduledEvent(), liveEvent(), finalEvent()].map(mapESPNEventToGame);
      const text = nflClient.formatGameList(games);
      expect(text).toContain('🏈 **NFL Scores**');
      const lines = text.split('\n').filter(l => l.trim());
      expect(lines.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('formatGamesContextForAI', () => {
    it('should return plain data without wrapper markers', () => {
      const games = [liveEvent(), finalEvent()].map(mapESPNEventToGame);
      const text = nflClient.formatGamesContextForAI(games);
      expect(text).toContain('NFL Scores - Current Week');
      expect(text).not.toContain('[NFL Game Data');
      expect(text).not.toContain('[End NFL Data]');
    });

    it('should include team and score information', () => {
      const games = [liveEvent()].map(mapESPNEventToGame);
      const text = nflClient.formatGamesContextForAI(games);
      expect(text).toContain('Kansas City Chiefs');
      expect(text).toContain('Baltimore Ravens');
    });

    it('should return a fallback for empty game list', () => {
      const text = nflClient.formatGamesContextForAI([]);
      expect(text).toContain('No NFL games data available');
    });
  });

  // ── News ───────────────────────────────────────────────────

  describe('fetchNews', () => {
    it('should fetch and cache news articles', async () => {
      const articles = [makeNewsArticle(), makeNewsArticle({ headline: 'Trade Rumor' })];
      mockInstance.get.mockResolvedValueOnce({ data: { articles } });

      const result = await nflClient.fetchNews(5);
      expect(result).toHaveLength(2);
      expect(mockInstance.get).toHaveBeenCalledWith('/news', { signal: undefined });

      // Second call should use cache
      const result2 = await nflClient.fetchNews(5);
      expect(result2).toHaveLength(2);
      expect(mockInstance.get).toHaveBeenCalledTimes(1);
    });

    it('should limit articles to requested count', async () => {
      const articles = Array.from({ length: 10 }, (_, i) =>
        makeNewsArticle({ headline: `Article ${i + 1}` })
      );
      mockInstance.get.mockResolvedValueOnce({ data: { articles } });

      const result = await nflClient.fetchNews(3);
      expect(result).toHaveLength(3);
    });

    it('should return empty array on error', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('Network error'));
      const result = await nflClient.fetchNews(5);
      expect(result).toEqual([]);
    });

    it('should rethrow abort errors', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      mockInstance.get.mockRejectedValueOnce(abortError);
      await expect(nflClient.fetchNews(5)).rejects.toThrow('The operation was aborted');
    });
  });

  describe('formatNews', () => {
    it('should format articles as numbered list with emoji header', () => {
      const articles = [
        makeNewsArticle({ headline: 'Big Trade', description: 'Details here', published: '2025-03-15T12:00:00Z' }),
        makeNewsArticle({ headline: 'Injury Update', description: 'Player hurt', published: '2025-03-14T10:00:00Z', byline: 'John Doe' }),
      ];
      const text = nflClient.formatNews(articles);
      expect(text).toContain('📰 **NFL News**');
      expect(text).toContain('**1.** Big Trade');
      expect(text).toContain('**2.** Injury Update');
      expect(text).toContain('Details here');
      expect(text).toContain('John Doe');
    });

    it('should return fallback for empty articles', () => {
      expect(nflClient.formatNews([])).toBe('No NFL news available.');
    });
  });

  describe('formatNewsContextForAI', () => {
    it('should format articles as AI-readable context', () => {
      const articles = [
        makeNewsArticle({ headline: 'Big Trade', description: 'Details here', published: '2025-03-15T12:00:00Z' }),
      ];
      const text = nflClient.formatNewsContextForAI(articles);
      expect(text).toContain('NFL News Headlines');
      expect(text).toContain('Big Trade');
      expect(text).toContain('Details here');
    });

    it('should return fallback for empty articles', () => {
      expect(nflClient.formatNewsContextForAI([])).toBe('No NFL news data available.');
    });
  });

  describe('filterArticlesByKeyword', () => {
    it('should filter articles containing keyword in headline', () => {
      const articles = [
        makeNewsArticle({ headline: 'Super Bowl LX Preview', description: 'Big game coming' }),
        makeNewsArticle({ headline: 'Trade Deadline Updates', description: 'Teams make moves' }),
        makeNewsArticle({ headline: 'Puppy Bowl is Back!', description: 'Adorable competition' }),
      ];
      const result = nflClient.filterArticlesByKeyword(articles, 'bowl');
      expect(result).toHaveLength(2);
      expect(result[0].headline).toContain('Bowl');
      expect(result[1].headline).toContain('Bowl');
    });

    it('should filter articles containing keyword in description', () => {
      const articles = [
        makeNewsArticle({ headline: 'Game Preview', description: 'The road to the Super Bowl continues' }),
        makeNewsArticle({ headline: 'Rookie Watch', description: 'Top draft picks shine' }),
      ];
      const result = nflClient.filterArticlesByKeyword(articles, 'bowl');
      expect(result).toHaveLength(1);
      expect(result[0].headline).toBe('Game Preview');
    });

    it('should be case-insensitive', () => {
      const articles = [
        makeNewsArticle({ headline: 'SUPER BOWL PREVIEW' }),
        makeNewsArticle({ headline: 'super bowl preview' }),
      ];
      const result = nflClient.filterArticlesByKeyword(articles, 'Bowl');
      expect(result).toHaveLength(2);
    });

    it('should return empty array when no articles match', () => {
      const articles = [
        makeNewsArticle({ headline: 'Trade Deadline' }),
        makeNewsArticle({ headline: 'Injury Report' }),
      ];
      const result = nflClient.filterArticlesByKeyword(articles, 'bowl');
      expect(result).toHaveLength(0);
    });

    it('should handle articles with missing description', () => {
      const articles = [
        makeNewsArticle({ headline: 'Bowl Game Preview', description: undefined }),
      ];
      const result = nflClient.filterArticlesByKeyword(articles, 'bowl');
      expect(result).toHaveLength(1);
    });
  });

  // ── Scoreboard API calls ──────────────────────────────────

  describe('fetchScoreboard', () => {
    it('should fetch and cache current scoreboard', async () => {
      const response = makeESPNScoreboard([scheduledEvent(), finalEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      const games = await nflClient.fetchScoreboard();
      expect(games).toHaveLength(2);
      expect(mockInstance.get).toHaveBeenCalledWith('/scoreboard', { params: undefined, signal: undefined });

      // Second call should use cache
      const games2 = await nflClient.fetchScoreboard();
      expect(games2).toHaveLength(2);
      expect(mockInstance.get).toHaveBeenCalledTimes(1);
    });

    it('should accept date parameter', async () => {
      const response = makeESPNScoreboard([finalEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      await nflClient.fetchScoreboard({ dates: '20250907' });
      expect(mockInstance.get).toHaveBeenCalledWith('/scoreboard', {
        params: { dates: '20250907' },
        signal: undefined,
      });
    });

    it('should accept week/season/seasontype parameters', async () => {
      const response = makeESPNScoreboard([finalEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      await nflClient.fetchScoreboard({ season: 2025, week: 4, seasontype: 2 });
      expect(mockInstance.get).toHaveBeenCalledWith('/scoreboard', {
        params: { season: 2025, week: 4, seasontype: 2 },
        signal: undefined,
      });
    });

    it('should use short cache TTL when live games exist', async () => {
      const response = makeESPNScoreboard([liveEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      await nflClient.fetchScoreboard();

      // Within 60s this should use cache
      const games = await nflClient.fetchScoreboard();
      expect(games).toHaveLength(1);
      expect(mockInstance.get).toHaveBeenCalledTimes(1);
    });

    it('should return empty array on error', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('Server error'));
      const games = await nflClient.fetchScoreboard();
      expect(games).toEqual([]);
    });

    it('should rethrow abort errors', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      mockInstance.get.mockRejectedValueOnce(abortError);
      await expect(nflClient.fetchScoreboard()).rejects.toThrow('The operation was aborted');
    });
  });

  describe('findTeamGame', () => {
    it('should find a game for a specific team', async () => {
      const response = makeESPNScoreboard([scheduledEvent(), finalEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      const game = await nflClient.findTeamGame('KC');
      expect(game).not.toBeNull();
      expect(game!.AwayTeam).toBe('KC');
    });

    it('should return null when team has no game', async () => {
      const response = makeESPNScoreboard([finalEvent()]); // PHI vs DAL
      mockInstance.get.mockResolvedValueOnce({ data: response });

      const game = await nflClient.findTeamGame('SEA');
      expect(game).toBeNull();
    });
  });



  // ── Health check ───────────────────────────────────────────

  describe('testConnection', () => {
    it('should return healthy when ESPN API responds with events', async () => {
      const response = makeESPNScoreboard([scheduledEvent()]);
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: response });
      const result = await nflClient.testConnection();
      expect(result.healthy).toBe(true);
    });

    it('should return unhealthy on API error', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('Timeout'));
      const result = await nflClient.testConnection();
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Timeout');
    });

    it('should return unhealthy on unexpected response', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: {} });
      const result = await nflClient.testConnection();
      expect(result.healthy).toBe(false);
    });
  });

  // ── handleRequest dispatcher ───────────────────────────────

  describe('handleRequest', () => {
    it('should return error when NFL is disabled', async () => {
      (config.getNflEnabled as jest.Mock).mockReturnValueOnce(false);
      const result = await nflClient.handleRequest('', 'nfl scores');
      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('should dispatch "nfl scores" to all scores', async () => {
      const response = makeESPNScoreboard([scheduledEvent(), finalEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      const result = await nflClient.handleRequest('', 'nfl scores');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('NFL Scores');
      expect(result.data?.games).toHaveLength(2);
    });

    it('should dispatch "nfl news" keyword', async () => {
      const articles = Array.from({ length: 15 }, (_, i) =>
        makeNewsArticle({ headline: `Story ${i + 1}` })
      );
      mockInstance.get.mockResolvedValueOnce({ data: { articles } });

      const result = await nflClient.handleRequest('', 'nfl news');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('📰 **NFL News**');
      // Default (no filter) returns first 5
      expect(result.data?.articles).toHaveLength(5);
    });

    it('should filter nfl news by keyword when content is provided', async () => {
      const articles = [
        makeNewsArticle({ headline: 'Chiefs Win Big', description: 'KC dominates' }),
        makeNewsArticle({ headline: 'Trade Deadline', description: 'Deals made' }),
        makeNewsArticle({ headline: 'Chiefs Draft Picks', description: 'New talent' }),
      ];
      mockInstance.get.mockResolvedValueOnce({ data: { articles } });

      const result = await nflClient.handleRequest('nfl news chiefs', 'nfl news');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('Chiefs Win Big');
      expect(result.data?.text).toContain('Chiefs Draft Picks');
      expect(result.data?.text).not.toContain('Trade Deadline');
      expect(result.data?.articles).toHaveLength(2);
    });

    it('should return "no matching" message when filter has no results', async () => {
      const articles = [
        makeNewsArticle({ headline: 'Trade Deadline', description: 'Deals' }),
      ];
      mockInstance.get.mockResolvedValueOnce({ data: { articles } });

      const result = await nflClient.handleRequest('nfl news seahawks', 'nfl news');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('No NFL news articles matching');
      expect(result.data?.text).toContain('seahawks');
    });

    it('should return unknown keyword error for removed keywords', async () => {
      const result = await nflClient.handleRequest('', 'nfl');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown NFL keyword');
    });

    it('should handle API errors gracefully', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('API down'));

      const result = await nflClient.handleRequest('', 'nfl scores');
      // Should still succeed since empty array is returned from fetchScoreboard
      expect(result.success).toBe(true);
    });

    it('should pass AbortSignal through to axios calls', async () => {
      const controller = new AbortController();
      const response = makeESPNScoreboard([scheduledEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      await nflClient.handleRequest('', 'nfl scores', controller.signal);

      for (const call of mockInstance.get.mock.calls) {
        const axiosConfig = call[1];
        expect(axiosConfig).toBeDefined();
        expect(axiosConfig.signal).toBe(controller.signal);
      }
    });

    it('should propagate abort errors', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      mockInstance.get.mockRejectedValueOnce(abortError);

      const result = await nflClient.handleRequest('', 'nfl scores');
      expect(result.success).toBe(false);
      expect(result.error).toContain('cancelled');
    });

    it('should reject with AbortError when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      mockInstance.get.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

      const result = await nflClient.handleRequest('', 'nfl scores', controller.signal);
      expect(result.success).toBe(false);
      expect(result.error).toContain('cancelled');
    });

    it('should surface axios CanceledError as timeout message', async () => {
      const canceledError = new Error('canceled');
      canceledError.name = 'CanceledError';
      (canceledError as any).code = 'ERR_CANCELED';

      mockInstance.get.mockRejectedValue(canceledError);

      const result = await nflClient.handleRequest('', 'nfl scores');
      expect(result.success).toBe(false);
      expect(result.error).toContain('cancelled');
    });

    it('should still swallow non-abort API errors in fetch helpers', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('Server error'));

      const result = await nflClient.handleRequest('', 'nfl scores');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('No NFL games');
    });

    it('should append date tip for current-week scores', async () => {
      const response = makeESPNScoreboard([finalEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      const result = await nflClient.handleRequest('', 'nfl scores');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('Tip:');
      expect(result.data?.text).toContain('nfl scores 20260208');
    });

    it('should dispatch "nfl scores" with YYYYMMDD date param', async () => {
      const response = makeESPNScoreboard([finalEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      const result = await nflClient.handleRequest('20260208', 'nfl scores');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('2026-02-08');
      expect(mockInstance.get).toHaveBeenCalledWith('/scoreboard', {
        params: { dates: '20260208' },
        signal: undefined,
      });
    });

    it('should dispatch "nfl scores" with YYYY-MM-DD date param', async () => {
      const response = makeESPNScoreboard([finalEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      const result = await nflClient.handleRequest('2026-02-08', 'nfl scores');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('2026-02-08');
      expect(mockInstance.get).toHaveBeenCalledWith('/scoreboard', {
        params: { dates: '20260208' },
        signal: undefined,
      });
    });
  });



  // ── Endpoint validation ─────────────────────────────────

  describe('endpoint validation', () => {
    it('should log a warning when endpoint is not ESPN', () => {
      const { logger } = require('../src/utils/logger');
      (config.getNflEndpoint as jest.Mock).mockReturnValue('https://api.sportsdata.io/v3/nfl/scores');

      // Trigger refresh which re-evaluates the endpoint
      nflClient.refresh();

      expect(logger.log).toHaveBeenCalledWith(
        'warn', 'nfl',
        expect.stringContaining('is not an ESPN URL')
      );
    });

    it('should not log a warning when endpoint is ESPN', () => {
      const { logger } = require('../src/utils/logger');
      (config.getNflEndpoint as jest.Mock).mockReturnValue('https://site.api.espn.com/apis/site/v2/sports/football/nfl');

      nflClient.refresh();

      expect(logger.log).not.toHaveBeenCalledWith(
        'warn', 'nfl',
        expect.stringContaining('is not an ESPN URL')
      );
    });

    it('should include 401 hint when scoreboard fetch returns 401', async () => {
      const { logger } = require('../src/utils/logger');
      const error = new Error('Request failed with status code 401') as any;
      error.response = { status: 401 };
      mockInstance.get.mockRejectedValueOnce(error);

      const result = await nflClient.handleRequest('', 'nfl scores');

      expect(logger.logError).toHaveBeenCalledWith(
        'nfl',
        expect.stringContaining('check NFL_BASE_URL in .env')
      );
      expect(result.data?.text).toContain('No NFL games found');
    });

    it('should include 401 hint when news fetch returns 401', async () => {
      const { logger } = require('../src/utils/logger');
      const error = new Error('Request failed with status code 401') as any;
      error.response = { status: 401 };
      mockInstance.get.mockRejectedValueOnce(error);

      const result = await nflClient.handleRequest('', 'nfl news');

      expect(logger.logError).toHaveBeenCalledWith(
        'nfl',
        expect.stringContaining('check NFL_BASE_URL in .env')
      );
      expect(result.data?.text).toContain('No NFL news available');
    });
  });

  // ── Logging level gating ───────────────────────────────────

  describe('logging levels', () => {
    it('should log at level 0 with summary only', async () => {
      (config.getNflLoggingLevel as jest.Mock).mockReturnValue(0);
      const { logger } = require('../src/utils/logger');

      const response = makeESPNScoreboard([finalEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      await nflClient.handleRequest('', 'nfl scores');

      const logCalls = (logger.log as jest.Mock).mock.calls
        .filter((c: string[]) => c[2]?.startsWith('NFL:'));
      expect(logCalls.length).toBeGreaterThan(0);

      // Should NOT log cache HIT/Fetching lines at level 0
      const detailCalls = logCalls.filter((c: string[]) =>
        c[2]?.includes('cache HIT') || c[2]?.includes('Fetching')
      );
      expect(detailCalls.length).toBe(0);
    });

    it('should log cache hits at level 1', async () => {
      (config.getNflLoggingLevel as jest.Mock).mockReturnValue(1);
      const { logger } = require('../src/utils/logger');

      const response = makeESPNScoreboard([scheduledEvent()]);
      mockInstance.get.mockResolvedValueOnce({ data: response });

      // Prime cache
      await nflClient.fetchScoreboard();
      (logger.log as jest.Mock).mockClear();

      // Second call should hit cache
      await nflClient.fetchScoreboard();

      const logCalls = (logger.log as jest.Mock).mock.calls
        .filter((c: string[]) => c[2]?.includes('cache HIT'));
      expect(logCalls.length).toBe(1);
    });
  });

  // ── parseSeasonWeek ────────────────────────────────────────

  describe('isEspnHost (URL validation)', () => {
    it('should accept exact espn.com host', () => {
      expect(isEspnHost('https://espn.com/nfl')).toBe(true);
    });

    it('should accept subdomain of espn.com', () => {
      expect(isEspnHost('https://site.api.espn.com/apis/site/v2/sports/football/nfl')).toBe(true);
    });

    it('should reject espn.com in path (not host)', () => {
      expect(isEspnHost('https://evil.com/espn.com')).toBe(false);
    });

    it('should reject espn.com as subdomain of another domain', () => {
      expect(isEspnHost('https://espn.com.evil.net/api')).toBe(false);
    });

    it('should reject non-ESPN domain', () => {
      expect(isEspnHost('https://api.sportsdata.io/v3/nfl/scores')).toBe(false);
    });

    it('should reject malformed URL', () => {
      expect(isEspnHost('not-a-url')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isEspnHost('')).toBe(false);
    });
  });

  describe('parseSeasonWeek', () => {
    it('should parse "week 4 2025"', () => {
      expect(parseSeasonWeek('week 4 2025')).toEqual({ season: 2025, week: 4 });
    });

    it('should parse "2025 week 4"', () => {
      expect(parseSeasonWeek('2025 week 4')).toEqual({ season: 2025, week: 4 });
    });

    it('should parse "wk4 2025"', () => {
      expect(parseSeasonWeek('wk4 2025')).toEqual({ season: 2025, week: 4 });
    });

    it('should parse "wk 10 2025"', () => {
      expect(parseSeasonWeek('wk 10 2025')).toEqual({ season: 2025, week: 10 });
    });

    it('should parse "2025/4" slash shorthand', () => {
      expect(parseSeasonWeek('2025/4')).toEqual({ season: 2025, week: 4 });
    });

    it('should parse "2025-4" dash shorthand', () => {
      expect(parseSeasonWeek('2025-4')).toEqual({ season: 2025, week: 4 });
    });

    it('should parse standalone "week 4" without season', () => {
      expect(parseSeasonWeek('week 4')).toEqual({ week: 4 });
    });

    it('should parse standalone year "2025" without week', () => {
      expect(parseSeasonWeek('results 2025')).toEqual({ season: 2025 });
    });

    it('should return empty object for content with no season/week', () => {
      expect(parseSeasonWeek('nfl scores')).toEqual({});
    });

    it('should return empty object for empty string', () => {
      expect(parseSeasonWeek('')).toEqual({});
    });

    it('should handle mixed content like "chiefs week 4 2025"', () => {
      expect(parseSeasonWeek('chiefs week 4 2025')).toEqual({ season: 2025, week: 4 });
    });

    it('should parse case-insensitively', () => {
      expect(parseSeasonWeek('Week 4 2025')).toEqual({ season: 2025, week: 4 });
    });

    it('should parse "w4" shorthand', () => {
      expect(parseSeasonWeek('scores w4')).toEqual({ week: 4 });
    });
  });
});
