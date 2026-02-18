# AGENTS.md - Development Guidelines for Bob Bot Discord App

This file contains development guidelines, build commands, and coding standards for agentic coding assistants working on the Bob Bot Discord application.

## Build, Lint, and Test Commands

### Primary Commands
- **Build**: `npm run build` - Compiles TypeScript to JavaScript using tsc
- **Test All**: `npm test` - Runs all Jest tests
- **Test Watch**: `npm run test:watch` - Runs tests in watch mode
- **Development**: `npm run dev` - Runs with ts-node for development
- **Development Watch**: `npm run dev:watch` - Runs with nodemon for auto-restart

### Specialized Commands
- **Register Discord Commands**: `npm run register` - Registers slash commands with Discord
- **Install Dependencies**: `npm ci` - Clean install (recommended for CI/production)

### Running a Single Test
```bash
# Run specific test file
npm test -- tests/config.test.ts

# Run tests matching pattern
npm test -- --testNamePattern="should load keywords"

# Run tests for specific functionality
npm test -- --testPathPattern="config"
```

### Linting and Formatting
*Note: ESLint and Prettier are planned but not yet configured. Follow existing code style patterns.*

## Code Style Guidelines

### TypeScript Configuration
- **Strict Mode**: Enabled - all code must pass strict type checking
- **Target**: ES2020
- **Module System**: CommonJS
- **Declaration Files**: Generated for distribution

### Naming Conventions
- **Classes**: PascalCase (e.g., `BaseCommand`, `GenerateCommand`, `ConfigManager`)
- **Interfaces**: PascalCase with descriptive names (e.g., `ChatMessage`, `ApiType`, `NFLGameScore`)
- **Functions/Methods**: camelCase (e.g., `execute()`, `getTimeout()`, `handleResponse()`)
- **Variables/Properties**: camelCase (e.g., `apiResult`, `requester`, `configDir`)
- **Constants**: UPPER_SNAKE_CASE for truly constant values
- **Files**: kebab-case for file names (e.g., `api-manager.ts`, `request-queue.ts`)

### Import Organization
```typescript
// External libraries first
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import axios from 'axios';

// Internal modules (relative imports)
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { apiManager } from '../api';
```

### Error Handling
- Use specific error types and messages (avoid generic "Unknown error")
- Prefer try/catch with meaningful error messages
- Log errors with context for debugging
- Return structured error responses with error codes when applicable

```typescript
try {
  // operation
} catch (error) {
  const errorMsg = error instanceof Error ? error.message : 'Unknown error';
  logger.logError(requester, errorMsg);
  return { success: false, error: errorMsg };
}
```

### Async/Await Patterns
- Use async/await over Promise chains
- Handle timeouts appropriately for API calls
- Use AbortSignal for cancellable operations

### Testing Standards
- **Framework**: Jest with ts-jest preset
- **Test Location**: `tests/` directory with `.test.ts` extension
- **Test Structure**: describe/it blocks with clear descriptions
- **Setup/Teardown**: Use beforeEach/afterEach for test isolation
- **Mocking**: Use Jest mocks for external dependencies
- **Coverage**: New features require unit tests

```typescript
describe('Config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load keywords from file', () => {
    // test implementation
  });
});
```

### Documentation Standards
- **JSDoc**: Required for interfaces, complex functions, and public APIs
- **Comments**: Use `//` for implementation notes, `/** */` for API documentation
- **README Updates**: Evaluate changes for documentation updates

### Commit Message Standards
Follow Conventional Commits format:
```
type(scope): description

- Bullet point details
- More context if needed
```

**Types**: feat, fix, docs, style, refactor, perf, test, chore, ci, build

**Examples**:
```
feat(config): add support for custom timeout values

- Added timeout configuration option
- Updated config validation
- Added unit tests for timeout handling

fix(api): handle rate limit errors gracefully

- Added retry logic for 429 responses
- Improved error messages for rate limiting
```

### Security Considerations
- Never commit secrets or API keys
- Use environment variables for sensitive configuration
- Add tests for security-sensitive changes (auth, input validation)
- Prefer specific error messages over generic ones for security

### File Organization
```
src/
├── index.ts              # Main entry point
├── bot/                  # Discord client logic
├── commands/             # Slash command definitions
├── api/                  # External API clients
├── public/               # Web interface assets
└── utils/                # Shared utilities

tests/                    # Unit tests (mirror src structure)
config/                   # Configuration files
outputs/                  # Generated files (gitignored)
```

### Code Review Checklist
- [ ] New features include unit tests
- [ ] Changes evaluated for documentation updates
- [ ] Error handling uses specific error types
- [ ] Security-sensitive changes include attack scenario tests
- [ ] Code passes TypeScript strict mode
- [ ] Commit messages follow conventional format
- [ ] Changes are broken into logical, reviewable commits

## Development Workflow

1. **Issue First**: Open an issue describing the problem/change before implementing
2. **Small Commits**: Break changes into logical commits for easier review
3. **Test Coverage**: Ensure new features have appropriate test coverage
4. **Documentation**: Update README/docs for user-facing changes
5. **Hot Reload**: Most config changes support hot reload (no restart needed)

## Copilot/Cursor Integration Rules

*These rules are automatically applied in Cursor and should be followed by all agents:*

### Best Practices
- New features require unit tests
- Changes should be evaluated for documentation and README updates
- Changes should be made in small commits for easier review
- During planning, consider commit strategy dividing work into logical steps
- Prefer specific error classes and messages for testability
- Add tests for security-sensitive changes simulating attack scenarios

### Commit Messages
- Use `type(scope): desc` format with 50 char first line, 72 char subsequent lines
- Include bullet points describing changes
- Use conventional commit types: feat, fix, docs, style, refactor, perf, test, chore, ci, build
- Never add co-authoring trailers
- Use `commitpls` keyword in prompts to trigger proper commit message generation

## Performance Guidelines
- Use efficient data structures for large datasets
- Implement proper cleanup for resources (timers, connections, files)
- Consider memory usage for long-running processes
- Use streaming for large file operations
- Implement rate limiting for API calls

## Monitoring and Logging
- Use structured logging with context
- Log errors with sufficient detail for debugging
- Include request IDs for tracking
- Log performance metrics for optimization
- Use appropriate log levels (error, warn, info, debug)</content>
<parameter name="filePath">/mnt/c/git/bob-bot-discord-app/AGENTS.md