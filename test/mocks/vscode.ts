/**
 * Mock VS Code API for Jest tests
 */

export const LanguageModelChatMessageRole = {
  User: 1,
  Assistant: 2
};

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object
  ) {}
}

export class LanguageModelDataPart {
  static image(data: Uint8Array, mime: string) {
    return new LanguageModelDataPart(data, mime);
  }
  
  static json(value: any, mime?: string) {
    return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mime || 'application/json');
  }
  
  static text(value: string, mime?: string) {
    return new LanguageModelDataPart(new TextEncoder().encode(value), mime || 'text/plain');
  }

  constructor(public data: Uint8Array, public mimeType: string) {}
}

export const StatusBarAlignment = {
  Left: 1,
  Right: 2
};

export class StatusBarItem {
  text: string = '';
  color?: any;
  tooltip?: string;
  command?: string;
  
  show() {}
  hide() {}
}

export const window = {
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

export const workspace = {
  getConfiguration: jest.fn(() => ({
    get: jest.fn((key: string, defaultValue?: any) => {
      if (key === 'showReasoningContent') return true;
      return defaultValue ?? false;
    })
  })),
  onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() }))
};

export const languages = {
  registerInlineCompletionItemProvider: jest.fn()
};

export const commands = {
  registerCommand: jest.fn()
};

export const lm = {
  registerLanguageModelChatProvider: jest.fn()
};

export const EventEmitter = class {
  event: any;
  fire: jest.Mock;
  
  constructor() {
    this.fire = jest.fn();
    this.event = {};
  }
};

export const CancellationToken = class {
  isCancellationRequested = false;
  reason?: any;
  onCancellationRequested: any;
};

export class MockMemento {
  private storage = new Map<string, any>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.storage.has(key) ? this.storage.get(key) : defaultValue;
  }

  update(key: string, value: any): Promise<void> {
    if (value === undefined) {
      this.storage.delete(key);
    } else {
      this.storage.set(key, value);
    }
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return Array.from(this.storage.keys());
  }
}

export const ThemeColor = class {
  constructor(public colorName: string) {}
};

export const LogOutputChannel = class {
  trace = jest.fn();
  debug = jest.fn();
  info = jest.fn();
  warn = jest.fn();
  error = jest.fn();
};

// Export all as default for compatibility
export default {
  LanguageModelChatMessageRole,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelDataPart,
  StatusBarAlignment,
  StatusBarItem,
  window,
  workspace,
  languages,
  commands,
  lm,
  EventEmitter,
  CancellationToken,
  MockMemento,
  ThemeColor,
  LogOutputChannel
};
