# LM Studio Copilot

A VS Code extension that enables inline code suggestions powered by language models running in LM Studio. The extension automatically discovers your LM Studio instance, detects available models, and uses the currently loaded model to provide contextual code completions.

## Quick Start

1. **Install LM Studio**: Download from [lmstudio.ai](https://lmstudio.ai)
2. **Start LM Studio**: Run the LM Studio application on your machine
3. **Load a model**: Select and load a model in LM Studio's UI (or use the Configuration panel)
4. **Install extension**: Install this extension in VS Code
5. **Configure connection** *(optional)*: Click the **LM Studio icon** in the activity bar, or open Command Palette → **"LM Studio: Open Configuration"**, to add remote servers or manage connections (defaults to `localhost:1234`)
6. **Start coding**: Inline suggestions will appear automatically as you type

## How It Works

The extension connects to LM Studio's local API server (default: `http://localhost:1234`) to:
- Detect connected LM Studio instances
- Discover available models
- Automatically use the currently loaded model
- Stream code completion suggestions to your editor in real-time

## Features

- **Automatic Discovery**: Detects LM Studio at startup and monitors for availability
- **Model Auto-Selection**: Uses whichever model is currently loaded in LM Studio's UI
- **Configuration Panel**: Click the **LM Studio icon** in the activity bar (sidebar) or open via Command Palette → **"LM Studio: Open Configuration"** to manage server connections, load/unload models, and control which models appear in the Copilot model picker
- **Copilot Model Picker**: Each model card in the configuration panel has a **Copilot** checkbox. Only checked models that are currently loaded appear in VS Code's Copilot model picker. All models are enabled by default; preferences persist across restarts. Clicking a server card refreshes the picker immediately — no window reload required
- **Conversation-Driven Context**: Automatically includes the currently active editor file in the chat context when it is not already referenced in the conversation. Files the user has not explicitly opened or attached are never injected.
- **Smart Context Scanner** *(opt-in)*: Discovers files that are already referenced in the conversation — via attached files, tool calls, or tool results — and injects those files into the context. Only files explicitly grounded in the conversation are considered; the workspace index is never scanned.
- **Real-time Streaming**: Responses stream live as tokens are generated

## Troubleshooting

**LM Studio not connecting / models not appearing in Copilot picker**
- Open the LM Studio Copilot output channel (`LM Studio: Open Output Channel`) — it logs which server address is being used and whether discovery succeeded
- If it shows the wrong address, open the Configuration panel, add your server, and click **→** (Switch) to make it active
- Click the server card in the Configuration panel to refresh the model list immediately

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
- The easiest way to set temperature is directly in the **Configuration panel**: expand a model card and adjust the **Temperature** field (default `1`). Saving loads the model with that temperature and persists it for all subsequent requests using that model.
- A global default can also be set via `lmStudioCopilot.temperature` in VS Code settings (default `0.7`).
- Per-model values set via the panel are stored under `lmStudioCopilot.modelTemperatures` and take precedence over the global default.

**See "Refresh ignored" message when clicking refresh button**
- This is expected behavior - the extension throttles rapid refresh attempts to prevent API overload
- Default cooldown is 5 seconds between manual refreshes. Wait for the indicated time and try again
- To adjust this behavior, configure `lmStudioCopilot.refreshCooldownMs` in settings (lower values allow faster refreshes)

**Response cancelled before completing (slow or large models)**
- VS Code enforces a ~60-second timeout before the first token of a response arrives. Slow models — or models that need time to load — can exceed this and get cancelled.
- The extension automatically sends an invisible heartbeat token every 45 seconds while waiting for the first token, which resets VS Code's timer.
- If your model consistently takes longer than 45 seconds to start, lower the interval: set `lmStudioCopilot.heartbeatIntervalSeconds` to a smaller value (e.g., `30`).
- To disable heartbeats entirely, set `lmStudioCopilot.heartbeatIntervalSeconds` to `0`.

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

This extension follows structured development patterns defined in the framework documentation.
