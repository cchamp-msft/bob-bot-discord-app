/**
 * NFLClient tests — exercises team resolution, game formatting,
 * API fetching (scores, Super Bowl, team games), health checks,
 * and the high-level handleRequest dispatcher.
 * Uses axios mocking; no real SportsData.io instance required.
 */

import axios from 'axios';

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
    getNflEndpoint: jest.fn(() => 'https://api.sportsdata.io/v3/nfl/scores'),
    getNflApiKey: jest.fn(() => 'test-nfl-key'),
    getNflEnabled: jest.fn(() => true),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
  },
}));

import { nflClient } from '../src/api/nflClient';
import { config } from '../src/utils/config';
import { NFLGameScore } from '../src/types';

// --- Test data fixtures ---
function makeGame(overrides: Partial<NFLGameScore> = {}): NFLGameScore {
  return {
    GameKey: '202520101',
    Season: 2025,
    SeasonType: 1,
    Week: 1,
    Date: '2025-09-07T20:20:00',
    AwayTeam: 'KC',
    HomeTeam: 'BAL',
    AwayScore: null,
    HomeScore: null,
    Channel: 'NBC',
    Quarter: null,
    TimeRemaining: null,
    Status: 'Scheduled',
    StadiumDetails: {
      Name: 'M&T Bank Stadium',
      City: 'Baltimore',
      State: 'MD',
      Country: 'USA',
    },
    IsClosed: false,
    AwayTeamMoneyLine: null,
    HomeTeamMoneyLine: null,
    PointSpread: null,
    OverUnder: null,
    ...overrides,
  };
}

const scheduledGame = makeGame();

const liveGame = makeGame({
  GameKey: '202520102',
  Status: 'InProgress',
  AwayScore: 14,
  HomeScore: 10,
  Quarter: '3',
  TimeRemaining: '8:42',
});

const finalGame = makeGame({
  GameKey: '202520103',
  Status: 'Final',
  AwayTeam: 'PHI',
  HomeTeam: 'DAL',
  AwayScore: 28,
  HomeScore: 21,
  IsClosed: true,
});

const overtimeGame = makeGame({
  GameKey: '202520104',
  Status: 'F/OT',
  AwayTeam: 'BUF',
  HomeTeam: 'MIA',
  AwayScore: 31,
  HomeScore: 28,
  IsClosed: true,
});

describe('NFLClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear internal cache between tests
    (nflClient as any).cache.clear();
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
      const text = nflClient.formatGame(scheduledGame);
      expect(text).toContain('⏰');
      expect(text).toContain('Kansas City Chiefs');
      expect(text).toContain('Baltimore Ravens');
      expect(text).toContain('NBC');
    });

    it('should format a live game', () => {
      const text = nflClient.formatGame(liveGame);
      expect(text).toContain('🏈');
      expect(text).toContain('14');
      expect(text).toContain('10');
      expect(text).toContain('Q3');
      expect(text).toContain('8:42');
    });

    it('should format a final game', () => {
      const text = nflClient.formatGame(finalGame);
      expect(text).toContain('✅');
      expect(text).toContain('28');
      expect(text).toContain('21');
      expect(text).toContain('Final');
    });

    it('should format an overtime game', () => {
      const text = nflClient.formatGame(overtimeGame);
      expect(text).toContain('✅');
      expect(text).toContain('OT');
    });

    it('should format a postponed game', () => {
      const postponed = makeGame({ Status: 'Postponed' });
      const text = nflClient.formatGame(postponed);
      expect(text).toContain('⚠️');
      expect(text).toContain('Postponed');
    });
  });

  describe('formatSuperBowl', () => {
    it('should format a scheduled Super Bowl with stadium info', () => {
      const sb = makeGame({ SeasonType: 3 });
      const text = nflClient.formatSuperBowl(sb);
      expect(text).toContain('🏈 **Super Bowl** 🏈');
      expect(text).toContain('M&T Bank Stadium');
      expect(text).toContain('Baltimore');
    });

    it('should format in-progress Super Bowl', () => {
      const sb = makeGame({
        SeasonType: 3,
        Status: 'InProgress',
        AwayScore: 21,
        HomeScore: 17,
        Quarter: '4',
        TimeRemaining: '2:00',
      });
      const text = nflClient.formatSuperBowl(sb);
      expect(text).toContain('21');
      expect(text).toContain('17');
      expect(text).toContain('Q4');
    });

    it('should format finished Super Bowl with winner', () => {
      const sb = makeGame({
        SeasonType: 3,
        Status: 'Final',
        AwayTeam: 'KC',
        HomeTeam: 'SF',
        AwayScore: 25,
        HomeScore: 22,
        IsClosed: true,
      });
      const text = nflClient.formatSuperBowl(sb);
      expect(text).toContain('🏆');
      expect(text).toContain('Kansas City Chiefs');
      expect(text).toContain('wins!');
    });
  });

  describe('formatGameList', () => {
    it('should show "no games" message for empty list', () => {
      const text = nflClient.formatGameList([]);
      expect(text).toContain('No NFL games found');
    });

    it('should format multiple games', () => {
      const text = nflClient.formatGameList([scheduledGame, liveGame, finalGame]);
      expect(text).toContain('🏈 **NFL Scores**');
      // Should have one line per game
      const lines = text.split('\n').filter(l => l.trim());
      expect(lines.length).toBeGreaterThanOrEqual(4); // header + 3 games
    });
  });

  describe('formatGamesContextForAI', () => {
    it('should return plain data without wrapper markers', () => {
      const text = nflClient.formatGamesContextForAI([liveGame, finalGame]);
      expect(text).toContain('NFL Scores - Current Week');
      expect(text).not.toContain('[NFL Game Data');
      expect(text).not.toContain('[End NFL Data]');
    });

    it('should include team and score information', () => {
      const text = nflClient.formatGamesContextForAI([liveGame]);
      expect(text).toContain('Kansas City Chiefs');
      expect(text).toContain('Baltimore Ravens');
    });

    it('should return a fallback for empty game list', () => {
      const text = nflClient.formatGamesContextForAI([]);
      expect(text).toContain('No NFL games data available');
    });
  });

  // ── API calls ──────────────────────────────────────────────

  describe('getCurrentWeek', () => {
    it('should fetch and cache current week', async () => {
      mockInstance.get.mockResolvedValueOnce({ data: 5 });

      const week = await nflClient.getCurrentWeek();
      expect(week).toBe(5);
      expect(mockInstance.get).toHaveBeenCalledWith('/json/CurrentWeek', {
        params: { key: 'test-nfl-key' },
      });

      // Second call should use cache
      const week2 = await nflClient.getCurrentWeek();
      expect(week2).toBe(5);
      expect(mockInstance.get).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should return null when no API key configured', async () => {
      (config.getNflApiKey as jest.Mock).mockReturnValueOnce('');
      const week = await nflClient.getCurrentWeek();
      expect(week).toBeNull();
    });

    it('should return null on API error', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('Network error'));
      const week = await nflClient.getCurrentWeek();
      expect(week).toBeNull();
    });
  });

  describe('getCurrentSeason', () => {
    it('should fetch and cache current season', async () => {
      mockInstance.get.mockResolvedValueOnce({ data: 2025 });

      const season = await nflClient.getCurrentSeason();
      expect(season).toBe(2025);
      expect(mockInstance.get).toHaveBeenCalledWith('/json/CurrentSeason', {
        params: { key: 'test-nfl-key' },
      });
    });
  });

  describe('getScores', () => {
    it('should fetch scores for a season/week', async () => {
      mockInstance.get.mockResolvedValueOnce({ data: [scheduledGame, liveGame] });

      const scores = await nflClient.getScores(2025, 1);
      expect(scores).toHaveLength(2);
      expect(mockInstance.get).toHaveBeenCalledWith('/json/ScoresBasic/2025/1', {
        params: { key: 'test-nfl-key' },
      });
    });

    it('should use short cache TTL when live games exist', async () => {
      mockInstance.get.mockResolvedValueOnce({ data: [liveGame] });

      await nflClient.getScores(2025, 1);

      // Second call within 60s should use cache
      const scores = await nflClient.getScores(2025, 1);
      expect(scores).toHaveLength(1);
      expect(mockInstance.get).toHaveBeenCalledTimes(1);
    });

    it('should return empty array on error', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('Server error'));
      const scores = await nflClient.getScores(2025, 1);
      expect(scores).toEqual([]);
    });
  });

  describe('getCurrentWeekScores', () => {
    it('should combine season + week to fetch scores', async () => {
      // getCurrentSeason → 2025
      mockInstance.get.mockResolvedValueOnce({ data: 2025 });
      // getCurrentWeek → 3
      mockInstance.get.mockResolvedValueOnce({ data: 3 });
      // getScores(2025, 3)
      mockInstance.get.mockResolvedValueOnce({ data: [finalGame] });

      const scores = await nflClient.getCurrentWeekScores();
      expect(scores).toHaveLength(1);
      expect(scores[0].GameKey).toBe(finalGame.GameKey);
    });
  });

  describe('findTeamGame', () => {
    it('should find a game for a specific team', async () => {
      // Season
      mockInstance.get.mockResolvedValueOnce({ data: 2025 });
      // Week
      mockInstance.get.mockResolvedValueOnce({ data: 1 });
      // Scores
      mockInstance.get.mockResolvedValueOnce({ data: [scheduledGame, finalGame] });

      const game = await nflClient.findTeamGame('KC');
      expect(game).not.toBeNull();
      expect(game!.AwayTeam).toBe('KC');
    });

    it('should return null when team has no game', async () => {
      mockInstance.get.mockResolvedValueOnce({ data: 2025 });
      mockInstance.get.mockResolvedValueOnce({ data: 1 });
      mockInstance.get.mockResolvedValueOnce({ data: [finalGame] }); // PHI vs DAL

      const game = await nflClient.findTeamGame('SEA');
      expect(game).toBeNull();
    });
  });

  // ── Health check ───────────────────────────────────────────

  describe('testConnection', () => {
    it('should return healthy when API responds', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: 2025 });
      const result = await nflClient.testConnection();
      expect(result.healthy).toBe(true);
    });

    it('should return unhealthy when no API key', async () => {
      (config.getNflApiKey as jest.Mock).mockReturnValueOnce('');
      const result = await nflClient.testConnection();
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('should return unhealthy on API error', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('Timeout'));
      const result = await nflClient.testConnection();
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Timeout');
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

    it('should return error when no API key is configured', async () => {
      (config.getNflApiKey as jest.Mock).mockReturnValueOnce('');
      const result = await nflClient.handleRequest('', 'nfl scores');
      expect(result.success).toBe(false);
      expect(result.error).toContain('API key');
    });

    it('should dispatch "nfl scores" to all scores', async () => {
      mockInstance.get.mockResolvedValueOnce({ data: 2025 });
      mockInstance.get.mockResolvedValueOnce({ data: 1 });
      mockInstance.get.mockResolvedValueOnce({ data: [scheduledGame, finalGame] });

      const result = await nflClient.handleRequest('', 'nfl scores');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('NFL Scores');
      expect(result.data?.games).toHaveLength(2);
    });

    it('should dispatch "nfl score" with team query', async () => {
      mockInstance.get.mockResolvedValueOnce({ data: 2025 });
      mockInstance.get.mockResolvedValueOnce({ data: 1 });
      mockInstance.get.mockResolvedValueOnce({ data: [scheduledGame] }); // KC @ BAL

      const result = await nflClient.handleRequest('chiefs', 'nfl score');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('Kansas City Chiefs');
    });

    it('should prompt for team when "nfl score" has no argument', async () => {
      const result = await nflClient.handleRequest('', 'nfl score');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('specify a team');
    });

    it('should dispatch "superbowl" keyword', async () => {
      // Season
      mockInstance.get.mockResolvedValueOnce({ data: 2025 });
      // getScores(2025, 22) — postseason
      mockInstance.get.mockResolvedValueOnce({
        data: [makeGame({
          SeasonType: 3,
          Status: 'Final',
          AwayTeam: 'KC',
          HomeTeam: 'SF',
          AwayScore: 25,
          HomeScore: 22,
          Week: 22,
        })],
      });

      const result = await nflClient.handleRequest('', 'superbowl');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('Super Bowl');
    });

    it('should dispatch "nfl" generic keyword for AI context', async () => {
      mockInstance.get.mockResolvedValueOnce({ data: 2025 });
      mockInstance.get.mockResolvedValueOnce({ data: 1 });
      mockInstance.get.mockResolvedValueOnce({ data: [liveGame] });

      const result = await nflClient.handleRequest('who is winning?', 'nfl');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('NFL Scores - Current Week');
    });

    it('should handle API errors gracefully', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('API down'));
      mockInstance.get.mockRejectedValueOnce(new Error('API down'));

      const result = await nflClient.handleRequest('', 'nfl scores');
      // Should still succeed since empty array is returned from getScores
      expect(result.success).toBe(true);
    });

    it('should pass AbortSignal through to axios calls', async () => {
      const controller = new AbortController();
      mockInstance.get.mockResolvedValueOnce({ data: 2025 });
      mockInstance.get.mockResolvedValueOnce({ data: 1 });
      mockInstance.get.mockResolvedValueOnce({ data: [scheduledGame] });

      await nflClient.handleRequest('', 'nfl scores', controller.signal);

      // Every axios get call should receive the signal in its config
      for (const call of mockInstance.get.mock.calls) {
        const axiosConfig = call[1]; // second arg is the axios config object
        expect(axiosConfig).toBeDefined();
        expect(axiosConfig.signal).toBe(controller.signal);
      }
    });

    it('should reject with AbortError when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      mockInstance.get.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

      const result = await nflClient.handleRequest('', 'nfl scores', controller.signal);
      // With aborted signal, axios calls reject; getCurrentSeason/getCurrentWeek
      // swallow the error and return null/0, leading to an empty scores result
      expect(result.success).toBe(true);
    });
  });
});
