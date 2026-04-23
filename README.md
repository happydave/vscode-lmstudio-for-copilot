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
- **Real-time Streaming**: Responses stream live as tokens are generated
- **Silent Degradation**: Gracefully disables when LM Studio isn't running—no errors or popups
- **Multi-language Support**: Works with TypeScript, JavaScript, Python, Go, Rust, Java, and C#
- **Status Display**: Status bar shows connection state and active model
- **Manual Refresh**: Command to force model discovery without restarting

## Requirements

- **VS Code**: 1.85.0 or later
- **LM Studio**: Running locally on your machine
- **A loaded model**: At least one model must be loaded in LM Studio's UI for suggestions to work

## Installation

### From a VSIX Package

Install the `.vsix` file directly in VS Code:
1. Copy the `.vsix` file to your machine
2. In VS Code: Ctrl+Shift+P → "Extensions: Install from VSIX" → select the file

### Building from Source

```bash
# Install dependencies (requires Node.js and npm)
make install

# Build the extension
make compile

# Package as VSIX
make package

# The generated .vsix file can then be installed as above
```

## Configuration

Configure the extension in VS Code settings (File → Preferences → Settings, then search for "lmstudio"):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `lmStudioCopilot.serverHost` | string | "localhost" | Hostname or IP address of LM Studio server (e.g., `localhost`, `192.168.1.100`, `lm-studio.example.com`) |
| `lmStudioCopilot.serverPort` | number | 1234 | Port number where LM Studio HTTP API listens |
| `lmStudioCopilot.requestTimeout` | number | 0 | Timeout in milliseconds for API requests. Use `0` for no timeout (default). Requests may still timeout at OS/network level. |
| `lmStudioCopilot.disableAllTimeouts` | boolean | true | Disable all request timeouts entirely. Recommended for local models which may be slow on large tasks. |
| `lmStudioCopilot.enableSuggestions` | boolean | true | Enable/disable inline code suggestions |
| `lmStudioCopilot.toolGuidanceEnabled` | boolean | true | Enable system prompt guidance to encourage use of native file-writing tools (`create_file`, `replace_string_in_file`) for proper VS Code diff tracking |
| `lmStudioCopilot.nativeToolIntegration` | boolean | false | Route tool calls through VS Code's filesystem API for proper diff tracking (currently experimental) |
| `lmStudioCopilot.showReasoningContent` | boolean | true | Show reasoning/thinking tokens from models that emit them (e.g., DeepSeek-R1, QwQ). These appear as plain text before the main response. |

Or add directly to `settings.json`:

```json
"lmStudioCopilot.serverHost": "localhost",
"lmStudioCopilot.serverPort": 1234,
"lmStudioCopilot.requestTimeout": 0,
"lmStudioCopilot.disableAllTimeouts": true,
"lmStudioCopilot.enableSuggestions": true,
"lmStudioCopilot.toolGuidanceEnabled": true,
"lmStudioCopilot.nativeToolIntegration": false
```

**Examples:**

### Using Native Tools for File Operations

When `toolGuidanceEnabled=true` (default), the extension sends a system prompt encouraging models to use native tools like `create_file` and `replace_string_in_file`. These tools trigger VS Code's diff tracking, so you'll see changes in the editor just like with GitHub Copilot.

Example model output using native tools:
```xml
<tool_call>
<function=create_file>
<parameter=filePath>/path/to/newfile.ts
```json
"lmStudioCopilot.serverHost": "192.168.1.50",
"lmStudioCopilot.serverPort": 8000
```

Long timeout for slow models (300 seconds):
```json
"lmStudioCopilot.requestTimeout": 300000
```

Never timeout (default):
```json
"lmStudioCopilot.requestTimeout": 0
```

**To edit `settings.json` directly:**
1. Press Ctrl+Shift+P (Cmd+Shift+P on Mac)
2. Type "Preferences: Open User Settings (JSON)"
3. Add the lines above to the JSON object (ensure there's a comma after the last setting before them)

## Commands

Access these commands via Command Palette (Ctrl+Shift+P):

- **LM Studio: Refresh Models** - Manually re-query available models from LM Studio
- **LM Studio: Toggle Suggestions** - Enable or disable inline suggestions
- **LM Studio: Open Output Channel** - Show debug logs and diagnostics

## Project Structure

```
src/
  extension.ts              - Extension entry point and command handlers
  discovery.ts              - LM Studio connection and model detection
  modelManager.ts           - Tracks available models and active selection
  chatClient.ts             - Sends requests to LM Studio's chat API
  statusBarIndicator.ts     - Displays status in VS Code status bar
test/
  discovery.test.ts         - Unit tests for discovery service
```

## Architecture

### Discovery Service (`discovery.ts`)
- Periodically checks if LM Studio is running at the configured port
- Fetches available models from `/api/models/list` endpoint
- Handles connection timeouts and retries automatically
- Reports `Connected`, `Disconnected`, or error states

### Model Manager (`modelManager.ts`)
- Parses model list responses from LM Studio
- Automatically selects the first model with `loaded === true`
- Tracks model metadata: name, ID, max context length, quantization info
- Emits updates when active model changes

### Chat Client (`chatClient.ts`)
- Sends requests to LM Studio's OpenAI-compatible API at `/v1/chat/completions`
- Enables streaming mode (`stream=true`) for real-time token delivery
- Parses SSE (Server-Sent Events) stream responses
- Accumulates text chunks into complete suggestions

### Status Bar Indicator (`statusBarIndicator.ts`)
- Displays current state in VS Code's status bar
- Shows connection status and active model name
- Color-coded: green (ready), yellow (no model), red (disconnected)
- Opens output channel when clicked

## Troubleshooting

**Status shows "Disconnected"**
- Verify LM Studio is running and listening on the correct port
- Check that `lmStudioCopilot.serverHost` and `lmStudioCopilot.serverPort` match your LM Studio configuration
- If LM Studio is on a remote machine, verify network connectivity and firewall rules
- View logs via Command Palette → "LM Studio: Open Output Channel"

**Cannot connect to remote LM Studio server**
- Verify the hostname/IP is reachable: `ping <serverHost>`
- Test HTTP connectivity: `curl http://<serverHost>:<serverPort>/api/models/list`
- Check firewall rules on both machines (port must be open)
- Ensure LM Studio is configured to listen on all interfaces (0.0.0.0), not just localhost

**Suggestions timeout while waiting for response**
- If requests are timing out, increase `lmStudioCopilot.requestTimeout` (in milliseconds)
- For slow models or networks, use a higher value (e.g., `300000` for 5 minutes)
- Use `0` (default) to disable timeout entirely
- Check LM Studio logs to see if requests are actually being processed

**No suggestions appearing**
- Ensure a model is loaded in LM Studio's UI
- Verify you're editing a supported file type (JS, TS, Python, Go, Rust, Java, C#)
- Check that `lmStudioCopilot.enableSuggestions` is `true` in settings
- Try Command Palette → "LM Studio: Refresh Models"

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

## License

MIT

## Contributing

Contributions are welcome. This extension follows structured development patterns defined in the framework documentation.

For detailed implementation specifications, see [docs/feature-plan.md](docs/feature-plan.md).
