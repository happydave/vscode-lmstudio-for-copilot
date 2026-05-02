# LM Studio Copilot

A VS Code extension that enables inline code suggestions powered by language models running in LM Studio. The extension automatically discovers your LM Studio instance, detects available models, and uses the currently loaded model to provide contextual code completions.

## Quick Start

1. **Install LM Studio**: Download from [lmstudio.ai](https://lmstudio.ai)
2. **Start LM Studio**: Run the LM Studio application on your machine
3. **Load a model**: Select and load a model in LM Studio's UI
4. **Install extension**: Install this extension in VS Code
5. **Start coding**: Inline suggestions will appear automatically as you type

## How It Works

The extension connects to LM Studio's local API server (default: `http://localhost:1234`) to:
- Detect connected LM Studio instances
- Discover available models
- Automatically use the currently loaded model
- Stream code completion suggestions to your editor in real-time

## Features

- **Automatic Discovery**: Detects LM Studio at startup and monitors for availability
- **Model Auto-Selection**: Uses whichever model is currently loaded in LM Studio's UI
- **Workspace Context Prioritization**: Automatically includes the most relevant workspace files in the prompt context based on recency, proximity, and relevance heuristics.
- **Real-time Streaming**: Responses stream live as tokens are generated

- Use `0` (default) to disable timeout entirely
- Check LM Studio logs to see if requests are actually being processed

**No suggestions appearing**
- Ensure a model is loaded in LM Studio's UI
- Verify you're editing a supported file type (JS, TS, Python, Go, Rust, Java, C#)
- Check that `lmStudioCopilot.enableSuggestions` is `true` in settings
- Try Command Palette → "LM Studio: Refresh Models"

**Adjusting Context Injection**
- By default, the extension automatically injects relevant workspace files into the chat context.
- To disable this, set `lmStudioCopilot.enableContextPrioritization` to `false` or use the **"LM Studio: Toggle Context Prioritization"** command.
- To change the total amount of context allowed, adjust `lmStudioCopilot.contextTokenBudget` (default 20,000 tokens).

**See "Refresh ignored" message when clicking refresh button**
- This is expected behavior - the extension throttles rapid refresh attempts to prevent API overload
- Default cooldown is 5 seconds between manual refreshes. Wait for the indicated time and try again
- To adjust this behavior, configure `lmStudioCopilot.refreshCooldownMs` in settings (lower values allow faster refreshes)

**Output channel shows API errors**
- This typically means LM Studio is running but the model encountered an issue
- Try reloading the model or restarting LM Studio
- Check LM Studio's own logs for more details
- Verify sufficient system memory is available

## Development

### Prerequisites
- Node.js 16+ and npm
- Docker (optional, for consistent build environment)

### Build Commands

```bash
# Install dependencies
make install

# Watch mode: auto-compile on source changes
make watch

# Run unit tests
make test

# Lint TypeScript code
make lint

# Clean build artifacts
make clean
```

### Testing

Run tests with:
```bash
make test
```

Tests use Jest and cover discovery service functionality.

## Contributing

Contributions are welcome. This extension follows structured development patterns defined in the framework documentation.

For detailed implementation specifications, see [docs/feature-plan.md](docs/feature-plan.md).
