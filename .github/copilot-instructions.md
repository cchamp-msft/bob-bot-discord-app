# Copilot Guidance

## Best Practices
- New features require unit tests.
- Changes to code should be evaluated for documentation and README updates.
- If changes can be made in small commits, please do so to make review easier.
- During plan phase of a new feature, consider overall commit strategy dividing work into logical steps that can be committed separately (e.g. "Add config option and basic handling", "Implement new API endpoint", "Add tests for new feature", "Update documentation").

## Commit Messages
- Use: "type(scope): desc"
- Use a maximum of 50 characters for the first line and 72 characters for subsequent lines.
- Include bullet points describing the changes in the commit to support the short description.
- Use the following types (but not limited to):
  - feat: A new feature
  - fix: A bug fix
  - docs: Documentation changes
  - style: Code style changes (formatting, missing semicolons, etc.)
  - refactor: Code changes that neither fix a bug nor add a feature
  - perf: Performance improvements
  - test: Adding or updating tests
  - chore: Changes to the build process or auxiliary tools and libraries such as documentation generation
  - ci: Changes to our CI configuration files and scripts
  - build: Changes that affect the build system or external dependencies
- When keyword "commitpls" is used in the prompt, use it as short hand to review pending changes and generate a commit message based on the above guidelines. If the prompt includes "commitpls: <type>(<scope>): <description>", use the provided type, scope, and description in the generated commit message. Otherwise, analyze the changes and determine the appropriate type, scope, and description for the commit message. Offer to run "git -A -v && git commit -m '<generated commit message>'" to commit the changes.
