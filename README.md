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
- **Conversation-Driven Context**: Automatically includes the currently active editor file in the chat context when it is not already referenced in the conversation. Files the user has not explicitly opened or attached are never injected.
- **Smart Context Scanner** *(opt-in)*: Discovers files that are already referenced in the conversation — via attached files, tool calls, or tool results — and injects those files into the context. Only files explicitly grounded in the conversation are considered; the workspace index is never scanned.
- **Real-time Streaming**: Responses stream live as tokens are generated

- Use `0` (default) to disable timeout entirely
- Check LM Studio logs to see if requests are actually being processed

**No suggestions appearing**
- Ensure a model is loaded in LM Studio's UI
- Verify you're editing a supported file type (JS, TS, Python, Go, Rust, Java, C#)
- Check that `lmStudioCopilot.enableSuggestions` is `true` in settings
- Try Command Palette → "LM Studio: Refresh Models"

**Adjusting Context Injection**
- By default, the extension injects the currently active editor file into the chat context when it is not already present in the conversation.
- To disable this entirely, set `lmStudioCopilot.enableContextPrioritization` to `false` or use the **"LM Studio: Toggle Context Prioritization"** command.
- To change the maximum tokens allowed for injected context, adjust `lmStudioCopilot.contextTokenBudget` (default 20,000 tokens).
- To enable the smart context scanner, set `lmStudioCopilot.enableSmartContextScanner` to `true`. The scanner discovers files from the conversation itself — files attached via `#file:`, paths extracted from tool call inputs, and paths found in tool result text — scores them by recency and frequency of reference, and injects the highest-scoring files that are not already present in the conversation. Requires `enableContextPrioritization` to be `true`.
- Tune scanner behavior with `lmStudioCopilot.smartContextScanner.maxFilesToScan` (default 50, max candidates that advance to the file-read stage after scoring) and `lmStudioCopilot.smartContextScanner.maxResultFiles` (default 5, max files injected per request).

**Configuring Temperature**
- Global default temperature can be set via `lmStudioCopilot.temperature` (default `0.7`).
- Per-model overrides can be set via `lmStudioCopilot.modelTemperatures` using an object mapping model IDs to temperature values (e.g., `{ "qwen2.5-7b-instruct": 0.1 }`).
- Per-model overrides take precedence over the global default.

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
