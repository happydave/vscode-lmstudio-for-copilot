"use strict";
/**
 * Mock VS Code API for Jest tests
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogOutputChannel = exports.ThemeColor = exports.CancellationToken = exports.EventEmitter = exports.lm = exports.commands = exports.languages = exports.workspace = exports.window = exports.StatusBarItem = exports.StatusBarAlignment = exports.LanguageModelDataPart = exports.LanguageModelToolCallPart = exports.LanguageModelTextPart = exports.LanguageModelChatMessageRole = void 0;
exports.LanguageModelChatMessageRole = {
    User: 'user',
    Assistant: 'assistant'
};
class LanguageModelTextPart {
    value;
    constructor(value) {
        this.value = value;
    }
}
exports.LanguageModelTextPart = LanguageModelTextPart;
class LanguageModelToolCallPart {
    callId;
    name;
    input;
    constructor(callId, name, input) {
        this.callId = callId;
        this.name = name;
        this.input = input;
    }
}
exports.LanguageModelToolCallPart = LanguageModelToolCallPart;
class LanguageModelDataPart {
    data;
    mimeType;
    static image(data, mime) {
        return new LanguageModelDataPart(data, mime);
    }
    static json(value, mime) {
        return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mime || 'application/json');
    }
    static text(value, mime) {
        return new LanguageModelDataPart(new TextEncoder().encode(value), mime || 'text/plain');
    }
    constructor(data, mimeType) {
        this.data = data;
        this.mimeType = mimeType;
    }
}
exports.LanguageModelDataPart = LanguageModelDataPart;
exports.StatusBarAlignment = {
    Left: 1,
    Right: 2
};
class StatusBarItem {
    text = '';
    color;
    tooltip;
    command;
    show() { }
    hide() { }
}
exports.StatusBarItem = StatusBarItem;
exports.window = {
    createStatusBarItem: jest.fn(() => new StatusBarItem()),
    showInformationMessage: jest.fn(),
    createOutputChannel: jest.fn(() => ({
        trace: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }))
};
exports.workspace = {
    getConfiguration: jest.fn(() => ({
        get: jest.fn((key, defaultValue) => {
            if (key === 'showReasoningContent')
                return true;
            return defaultValue ?? false;
        })
    })),
    onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() }))
};
exports.languages = {
    registerInlineCompletionItemProvider: jest.fn()
};
exports.commands = {
    registerCommand: jest.fn()
};
exports.lm = {
    registerLanguageModelChatProvider: jest.fn()
};
const EventEmitter = class {
    event;
    fire;
    constructor() {
        this.fire = jest.fn();
        this.event = {};
    }
};
exports.EventEmitter = EventEmitter;
const CancellationToken = class {
    isCancellationRequested = false;
    reason;
    onCancellationRequested;
};
exports.CancellationToken = CancellationToken;
const ThemeColor = class {
    colorName;
    constructor(colorName) {
        this.colorName = colorName;
    }
};
exports.ThemeColor = ThemeColor;
const LogOutputChannel = class {
    trace = jest.fn();
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
};
exports.LogOutputChannel = LogOutputChannel;
// Export all as default for compatibility
exports.default = {
    LanguageModelChatMessageRole: exports.LanguageModelChatMessageRole,
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelDataPart,
    StatusBarAlignment: exports.StatusBarAlignment,
    StatusBarItem,
    window: exports.window,
    workspace: exports.workspace,
    languages: exports.languages,
    commands: exports.commands,
    lm: exports.lm,
    EventEmitter: exports.EventEmitter,
    CancellationToken: exports.CancellationToken,
    ThemeColor: exports.ThemeColor,
    LogOutputChannel: exports.LogOutputChannel
};
//# sourceMappingURL=vscode.js.map