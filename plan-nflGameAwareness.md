# NFL Game Awareness Feature Plan

## Executive Summary

Add NFL game awareness to the Discord bot with keywords like `nfl` and `superbowl` that can report live game progress, scores, and Super Bowl status. The feature will intelligently route requests to either direct API responses (for simple queries like "superbowl score") or enhance Ollama responses with live NFL data.

## API Selection

**Recommended: SportsData.io NFL API**

### Why SportsData.io over SportRadar:
- ✅ **Simpler REST API** - Straightforward endpoint structure
- ✅ **Clear workflow guide** - Excellent documentation of when to call what
- ✅ **No special subscriptions needed** - Basic live data doesn't require push feeds
- ✅ **Better game state tracking** - Simple status fields: `Scheduled`, `InProgress`, `Final`
- ✅ **15-20s TV delay** - Acceptable for Discord bot use case
- ✅ **Comprehensive game data** - Scores, play-by-play, box scores, schedules all available

SportRadar is more powerful but requires push feeds (Realtime subscription) for optimal use and has more complexity than needed for this use case.

## Key Endpoints to Use

### 1. **Current Season Schedule**
- Endpoint: `/scores/json/Schedules/{season}`
- Use: Get all games for current season, identify Super Bowl
- Call: Once daily, cache results

### 2. **Current Week Schedule** 
- Endpoint: `/scores/json/ScoresBasic/{season}/{week}`
- Use: Get games happening this week
- Call: A few times per day during season

### 3. **Live Game Scores (Real-time)**
- Endpoint: `/scores/json/ScoresBasic/{season}/{week}` (same as above)
- Use: Get live scores, game status, quarter, time remaining
- Call: During live games (has 2s TTL when InProgress)

### 4. **Game Box Score** (optional, for detailed stats)
- Endpoint: `/scores/json/BoxScoreV3/{season}/{week}/{hometeam}`
- Use: Detailed scoring breakdown, player stats
- Call: On-demand for detailed requests

## Architecture Design

### New Files to Create

#### 1. `src/api/nflClient.ts`
```typescript
interface NFLGame {
  GameKey: string;
  Season: number;
  Week: number;
  HomeTeam: string;
  AwayTeam: string;
  HomeScore: number;
  AwayScore: number;
  Quarter: string; // "1", "2", "3", "4", "Half", "OT", "F"
  TimeRemaining: string;
  Status: string; // "Scheduled", "InProgress", "Final", "F/OT"
  Stadium: string;
  Channel: string;
  Date: string;
  IsClosed: boolean;
}

interface NFLClientConfig {
  apiKey: string;
  baseUrl: string;
  currentSeason: number;
  currentWeek: number;
  superBowlWeek: number; // Usually week 22 (playoffs)
}

class NFLClient {
  // Get current week's games
  async getCurrentWeekGames(): Promise<NFLGame[]>
  
  // Get specific game status
  async getGameStatus(gameKey: string): Promise<NFLGame>
  
  // Find and return Super Bowl game
  async getSuperBowlGame(): Promise<NFLGame | null>
  
  // Get all games in progress right now
  async getLiveGames(): Promise<NFLGame[]>
  
  // Search for games by team name
  async findGamesByTeam(teamName: string): Promise<NFLGame[]>
}
```

#### 2. `src/utils/nflFormatter.ts`
```typescript
// Format game data into readable Discord messages
class NFLFormatter {
  // Format a single game's status
  static formatGameStatus(game: NFLGame): string
  
  // Format Super Bowl specific response
  static formatSuperBowl(game: NFLGame): string
  
  // Format multiple games (e.g., "all games today")
  static formatGameList(games: NFLGame[]): string
  
  // Format score with emoji indicators (🏈, 🏆, etc.)
  static formatScoreWithEmoji(game: NFLGame): string
}
```

#### 3. `src/utils/nflRouter.ts`
```typescript
// Determine if query can bypass Ollama
interface NFLRoutingDecision {
  shouldBypassOllama: boolean;
  intent: 'superbowl' | 'score-single' | 'scores-all' | 'game-info' | 'general-nfl' | 'unknown';
  extractedData?: {
    action?: 'score' | 'scores' | 'game' | 'standings';
    teamName?: string;
  };
}

class NFLRouter {
  /**
   * Analyze user query to determine routing strategy
   * 
   * BYPASS OLLAMA for:
   * - "superbowl" (exact keyword)
   * - "nfl score <team>" (structured query)
   * - "nfl scores" (all games)
   * - "nfl game <team>" (team-specific game info)
   * 
   * ENHANCE OLLAMA for:
   * - "nfl who's favored in the superbowl?"
   * - "nfl tell me about the chiefs season"
   * - "nfl playoff predictions"
   */
  static analyzeQuery(content: string): NFLRoutingDecision
  
  // Execute direct API response (bypass Ollama)
  static async executeDirectQuery(decision: NFLRoutingDecision): Promise<string>
}
```

### Enhanced Message Handler Flow

```
User Message: "superbowl"
     ↓
Keyword Classifier detects "superbowl"
     ↓
NFLRouter.analyzeQuery()
     ↓
Decision: shouldBypassOllama = true (exact keyword)
     ↓
NFLClient.getSuperBowlGame()
     ↓
NFLFormatter.formatSuperBowl()
     ↓
Return formatted response directly
```

```
User Message: "nfl score chiefs"
     ↓
Keyword Classifier detects "nfl"
     ↓
NFLRouter.analyzeQuery()
     ↓
Decision: shouldBypassOllama = true (structured query)
     ↓
Extract: item="score", arg="chiefs"
     ↓
NFLClient.findGamesByTeam("chiefs")
     ↓
NFLFormatter.formatGameStatus()
     ↓
Return formatted response directly
```

```
User Message: "nfl what happened in yesterday's game?"
     ↓
Keyword Classifier detects "nfl"
     ↓
NFLRouter.analyzeQuery()
     ↓
Decision: shouldBypassOllama = false (complex question)
     ↓
NFLClient.getCurrentWeekGames() [fetch context]
     ↓
Inject game data into Ollama context
     ↓
Ollama generates response with live data
     ↓
Return Ollama response
```

## Keyword Configuration

### keywords.json additions:

```json
{
  "keyword": "superbowl",
  "api": "nfl",
  "timeout": 30,
  "description": "Get current Super Bowl game status and score",
  "behavior": "direct" // bypass Ollama for simple queries
},
{
  "keyword": "nfl",
  "api": "nfl-enhanced",
  "timeout": 60,
  "description": "Get NFL game information, can enhance responses with live data",
  "behavior": "hybrid" // may bypass Ollama OR enhance it
}
```

### Additional useful keywords (optional):

```json
{
  "keyword": "football",
  "api": "nfl-enhanced",
  "timeout": 60,
  "description": "NFL game information (alias for nfl keyword)"
},
{
  "keyword": "playoffs",
  "api": "nfl",
  "timeout": 30,
  "description": "Get current playoff game status"
}
```

## Configuration Requirements

### .env additions:

```env
# NFL / SportsData.io Configuration
NFL_API_KEY=your_sportsdata_api_key_here
NFL_BASE_URL=https://api.sportsdata.io/v3/nfl/scores
NFL_CURRENT_SEASON=2026
NFL_ENABLED=true

# Cache duration (in seconds)
NFL_CACHE_DURATION=120  # 2 minutes during live games
NFL_SCHEDULE_CACHE_DURATION=86400  # 24 hours for schedule
```

## Implementation Phases

### Phase 1: Basic Infrastructure (Highest Priority)
1. Create `nflClient.ts` with basic API integration
2. Implement `getCurrentWeekGames()` and `getGameStatus()`
3. Create `nflFormatter.ts` with simple formatting
4. Add NFL config to `.env` and `config.ts`
5. Unit tests for client and formatter

**Deliverable:** Can fetch and format NFL game data

### Phase 2: Keyword Integration (High Priority)
1. Add "superbowl" keyword to keywords.json
2. Create `nflRouter.ts` with query analysis
3. Implement direct response for "superbowl" keyword
4. Update `messageHandler.ts` to route NFL keywords
5. Test superbowl keyword end-to-end

**Deliverable:** Users can type "superbowl" and get current game status

### Phase 3: Hybrid Routing (Medium Priority)
1. Add "nfl" keyword with hybrid behavior
2. Implement Ollama context injection with NFL data
3. Add team name extraction from queries
4. Implement direct responses for team-specific queries
5. Update `apiRouter.ts` to support hybrid API types

**Deliverable:** "nfl" keyword works with intelligent routing

### Phase 4: Polish & Features (Lower Priority)
1. Add game state emojis and rich formatting
2. Implement caching for API responses
3. Add playoff bracket awareness
4. Add "football" and "playoffs" keyword aliases
5. Comprehensive error handling for off-season

**Deliverable:** Production-ready feature with great UX

## Example User Interactions

### Direct API Response (Bypass Ollama)

**User:** `@BobBot superbowl`

**Bot Response:**
```
🏈 **Super Bowl LX** 🏈
🏟️ Allegiant Stadium, Las Vegas

**Kansas City Chiefs** 24
**San Francisco 49ers** 21

📊 Status: 4th Quarter, 3:42 remaining
📺 CBS
```

---

**User:** `@BobBot nfl score chiefs`

**Bot Response:**
```
🏈 **Kansas City Chiefs** 24 - **San Francisco 49ers** 21
Status: 4th Quarter, 3:42 remaining
```

---

**User:** `@BobBot nfl scores`

**Bot Response:**
```
🏈 **NFL Live Games**

Chiefs 24 - 49ers 21 (4th, 3:42)
Bills 28 - Patriots 14 (Final)
Cowboys 17 - Eagles 17 (Halftime)
```

### Enhanced Ollama Response

**User:** `@BobBot nfl who's having a better season, mahomes or purdy?`

**Bot Context Injection:**
```
[NFL Data Context]
Current Season: 2026
Patrick Mahomes (KC): 4,200 passing yards, 34 TDs, 8 INTs
Brock Purdy (SF): 3,850 passing yards, 28 TDs, 6 INTs
Chiefs Record: 14-3
49ers Record: 13-4
[End NFL Data]

User Question: who's having a better season, mahomes or purdy?
```

**Bot Response:** (Generated by Ollama with context)
```
Based on the current season stats, Mahomes has the edge statistically with 
more passing yards (4,200 vs 3,850) and touchdowns (34 vs 28), though 
Purdy has fewer interceptions. Both QBs are leading their teams to excellent 
records...
```

## Response Formatting Guidelines

### Status Indicators
- ⏰ Scheduled games
- 🏈 In-progress games
- ✅ Final score
- 🏆 Super Bowl / Championship
- 📺 TV channel info
- 🏟️ Stadium

### Score Formatting
```
[Team] [Score] - [Team] [Score]
Status: [Quarter/Final] [Time/Empty]
```

### Multiple Games
```
🏈 **NFL Games - Week 18**

Chiefs 31 - Raiders 3 (Final)
Bills 28 - Patriots 14 (Final) 
Cowboys 24 - Eagles 21 (4th, 5:23)
⏰ 49ers @ Seahawks (8:20 PM ET, NBC)
```

## Error Handling

### Scenarios to Handle:
1. **No Super Bowl in progress** → Report last Super Bowl result
2. **Off-season** → Indicate season hasn't started, offer last season results
3. **API failure** → Log error, return friendly message
4. **Team not found** → Suggest correct team names
5. **Ambiguous query** → Ask for clarification

### Example Error Messages:

```typescript
// No Super Bowl active
"The Super Bowl hasn't been played yet this season. Super Bowl LIX 
is scheduled for February 9, 2026."

// Off-season
"The NFL season hasn't started yet. The 2026 season begins in September. 
Would you like information about last season?"

// API error
"I'm having trouble fetching NFL data right now. Please try again in a moment."

// Team not found  
"I couldn't find a team matching 'chifs'. Did you mean: Chiefs, Bills, or 49ers?"
```

## Caching Strategy

### Cache Tiers:
1. **Season Schedule** - Cache 24 hours (rare changes)
2. **Live Game Data** - Cache 2 seconds during games (real-time)
3. **Final Scores** - Cache indefinitely (never changes)
4. **Team Search** - Cache 1 hour (roster changes)

### Implementation:
```typescript
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresIn: number; // milliseconds
}

class NFLCache {
  private cache: Map<string, CacheEntry<any>>;
  
  get<T>(key: string): T | null
  set<T>(key: string, data: T, ttl: number): void
  invalidate(key: string): void
  clear(): void
}
```

## Testing Strategy

### Unit Tests Required:

1. **nflClient.test.ts**
   - Mock API responses
   - Test game parsing
   - Test error handling
   - Test Super Bowl detection

2. **nflFormatter.test.ts**
   - Test score formatting
   - Test emoji placement
   - Test time formatting
   - Test multi-game lists

3. **nflRouter.test.ts**
   - Test bypass detection
   - Test team extraction
   - Test intent classification

### Integration Tests:

1. End-to-end "superbowl" keyword
2. End-to-end "nfl" + team name
3. Ollama context injection
4. Cache behavior during live games

### Manual Testing Checklist:

- [ ] Superbowl during game
- [ ] Superbowl when no game active
- [ ] Team-specific query (e.g., "chiefs score")
- [ ] General NFL question requiring Ollama
- [ ] Multiple live games
- [ ] Off-season behavior
- [ ] API timeout handling
- [ ] Invalid team name

## API Cost Considerations

### SportsData.io Trial/Paid Tiers:
- Trial: 1,000 calls/month (may be limited)
- Basic: $20-$69/month depending on data needs
- Real-time data requires higher tiers

### Call Optimization:
1. Cache aggressively (2s during games, 24h for schedules)
2. Batch requests when possible
3. Use `ScoresBasic` endpoints (less data = cheaper)
4. Only fetch game details when explicitly requested
5. Monitor usage with logging

### Rate Limiting:
```typescript
class NFLRateLimiter {
  private callCount: number = 0;
  private resetTime: number = Date.now() + 60000; // 1 minute
  
  async checkLimit(): Promise<boolean> {
    // Implement rate limit checking
    // Return false if over limit
  }
}
```

## Documentation Updates

### Files to Update:

1. **README.md** - Add NFL feature section
2. **PRIVACY_POLICY.md** - Mention SportsData.io API usage
3. **package.json** - Add description of NFL features
4. **.env.example** - Add NFL configuration template

### User-Facing Documentation:

```markdown
## NFL Game Awareness

BobBot can report NFL game scores, Super Bowl status, and answer football questions.

### Commands:
- `@BobBot superbowl` - Get current Super Bowl game status
- `@BobBot nfl scores` - Get all live game scores
- `@BobBot nfl score <team>` - Get specific team's game status
- `@BobBot nfl game <team>` - Get team's game information
- `@BobBot nfl [question]` - Ask any NFL question (enhanced with live data)

### Examples:
- "superbowl" → Direct score and status
- "nfl score chiefs" → Kansas City's current game
- "nfl scores" → All live games
- "nfl who's winning?" → All live games with analysis
- "nfl playoff bracket" → Current playoff status  
```

## Potential Future Enhancements

### Phase 5+ (Future):
1. **Player Stats** - "mahomes stats today"
2. **Betting Lines** - "superbowl odds" (if betting data tier available)
3. **Schedule Reminders** - "remind me when chiefs play"
4. **Play-by-Play** - Live play narration during games
5. **Fantasy Football** - Player performance tracking
6. **Historical Data** - "last time chiefs won superbowl"
7. **Playoff Bracket** - Visual bracket (using images)
8. **Team Standings** - Division/conference standings

## Success Metrics

### Measure:
1. Number of "superbowl" keyword uses per week
2. Successful API calls vs failures
3. Response time (should be <2s for direct queries)
4. User satisfaction (via Discord reactions?)
5. Cache hit rate (should be >70% during games)

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| API cost overruns | High | Aggressive caching, rate limiting, monitoring |
| Off-season usage confusion | Medium | Clear messaging about season status |
| Ambiguous team names | Low | Fuzzy matching, common abbreviations |
| API downtime | Medium | Graceful degradation, cached fallbacks |
| Wrong season/week data | Medium | Configuration validation, logging |

## Commit Strategy

Following conventional commits format:

### Suggested Commits:

1. `feat(nfl): add NFL client with SportsData.io integration`
   - Create nflClient.ts
   - Add API request methods
   - Unit tests for client

2. `feat(nfl): add NFL response formatter`
   - Create nflFormatter.ts
   - Score and game status formatting
   - Tests for formatter

3. `feat(nfl): add NFL query router for smart routing`
   - Create nflRouter.ts
   - Intent detection logic
   - Bypass vs enhance decisions

4. `feat(nfl): integrate superbowl keyword`
   - Add keyword to keywords.json
   - Update messageHandler for routing
   - End-to-end tests

5. `feat(nfl): integrate nfl keyword with hybrid routing`
   - Update apiRouter for nfl-enhanced
   - Ollama context injection
   - Team-specific direct queries

6. `test(nfl): comprehensive test coverage for NFL features`
   - Integration tests
   - Mock API responses
   - Error scenario tests

7. `docs(nfl): add NFL feature documentation`
   - Update README
   - Update privacy policy
   - Add .env.example entries

8. `chore(nfl): add NFL configuration and dependencies`
   - Environment variables
   - Config getters/setters
   - Dependencies if needed

## Dependencies

### New NPM Packages (if needed):
- None required (use existing `fetch` and `AbortSignal`)

### Configuration Dependencies:
- SportsData.io API key (from https://sportsdata.io/)
- Current season/week tracking (may need manual updates)

## Getting Started

### For Developer Implementation:

1. **Get API Key:**
   - Sign up at https://sportsdata.io/
   - Get trial key (1,000 calls/month)
   - Add to `.env` as `NFL_API_KEY`

2. **Test API Manually:**
   ```bash
   curl "https://api.sportsdata.io/v3/nfl/scores/json/CurrentWeek?key=YOUR_KEY"
   ```

3. **Start with Phase 1:**
   - Create `nflClient.ts` skeleton
   - Implement one endpoint at a time
   - Test with real API

4. **Follow Commit Strategy:**
   - Small, logical commits
   - Tests with each feature
   - Documentation as you go

## Questions to Resolve Before Implementation

1. ✅ **Which API?** → SportsData.io (easier, better documented)
2. ⚠️ **API key budget?** → Need to determine if trial is sufficient or if paid tier needed
3. ⚠️ **Cache implementation?** → Use in-memory Map or add Redis?
4. ⚠️ **Season/week tracking?** → Manual config updates or auto-detect from API?
5. ⚠️ **Playoff handling?** → Separate endpoint or infer from week number?

## Conclusion

This plan provides a comprehensive roadmap for adding NFL game awareness to the Discord bot. The phased approach allows for iterative development and testing, with the "superbowl" keyword as the first milestone and full "nfl" hybrid routing as the complete feature.

**Key Success Factors:**
- ✅ Simple, direct responses for exact keywords
- ✅ Smart routing to bypass Ollama when appropriate
- ✅ Context injection to enhance Ollama for complex questions
- ✅ Aggressive caching to minimize API costs
- ✅ Great error handling for off-season and failures
- ✅ Clear user-facing documentation

**Next Steps:**
1. Get SportsData.io API key
2. Test API manually to verify endpoints
3. Begin Phase 1 implementation
4. Create first commit with nflClient.ts
