/**
 * Mock VS Code API for Jest tests
 */
export declare const LanguageModelChatMessageRole: {
    User: string;
    Assistant: string;
};
export declare class LanguageModelTextPart {
    value: string;
    constructor(value: string);
}
export declare class LanguageModelToolCallPart {
    callId: string;
    name: string;
    input: object;
    constructor(callId: string, name: string, input: object);
}
export declare class LanguageModelDataPart {
    data: Uint8Array;
    mimeType: string;
    static image(data: Uint8Array, mime: string): LanguageModelDataPart;
    static json(value: any, mime?: string): LanguageModelDataPart;
    static text(value: string, mime?: string): LanguageModelDataPart;
    constructor(data: Uint8Array, mimeType: string);
}
export declare const StatusBarAlignment: {
    Left: number;
    Right: number;
};
export declare class StatusBarItem {
    text: string;
    color?: any;
    tooltip?: string;
    command?: string;
    show(): void;
    hide(): void;
}
export declare const window: {
    createStatusBarItem: jest.Mock<StatusBarItem, [], any>;
    showInformationMessage: jest.Mock<any, any, any>;
    createOutputChannel: jest.Mock<{
        trace: jest.Mock<any, any, any>;
        debug: jest.Mock<any, any, any>;
        info: jest.Mock<any, any, any>;
        warn: jest.Mock<any, any, any>;
        error: jest.Mock<any, any, any>;
    }, [], any>;
};
export declare const workspace: {
    getConfiguration: jest.Mock<{
        get: jest.Mock<any, [key: string, defaultValue?: any], any>;
    }, [], any>;
    onDidChangeConfiguration: jest.Mock<{
        dispose: jest.Mock<any, any, any>;
    }, [], any>;
};
export declare const languages: {
    registerInlineCompletionItemProvider: jest.Mock<any, any, any>;
};
export declare const commands: {
    registerCommand: jest.Mock<any, any, any>;
};
export declare const lm: {
    registerLanguageModelChatProvider: jest.Mock<any, any, any>;
};
export declare const EventEmitter: {
    new (): {
        event: any;
        fire: jest.Mock;
    };
};
export declare const CancellationToken: {
    new (): {
        isCancellationRequested: boolean;
        reason?: any;
        onCancellationRequested: any;
    };
};
export declare const ThemeColor: {
    new (colorName: string): {
        colorName: string;
    };
};
export declare const LogOutputChannel: {
    new (): {
        trace: jest.Mock<any, any, any>;
        debug: jest.Mock<any, any, any>;
        info: jest.Mock<any, any, any>;
        warn: jest.Mock<any, any, any>;
        error: jest.Mock<any, any, any>;
    };
};
declare const _default: {
    LanguageModelChatMessageRole: {
        User: string;
        Assistant: string;
    };
    LanguageModelTextPart: typeof LanguageModelTextPart;
    LanguageModelToolCallPart: typeof LanguageModelToolCallPart;
    LanguageModelDataPart: typeof LanguageModelDataPart;
    StatusBarAlignment: {
        Left: number;
        Right: number;
    };
    StatusBarItem: typeof StatusBarItem;
    window: {
        createStatusBarItem: jest.Mock<StatusBarItem, [], any>;
        showInformationMessage: jest.Mock<any, any, any>;
        createOutputChannel: jest.Mock<{
            trace: jest.Mock<any, any, any>;
            debug: jest.Mock<any, any, any>;
            info: jest.Mock<any, any, any>;
            warn: jest.Mock<any, any, any>;
            error: jest.Mock<any, any, any>;
        }, [], any>;
    };
    workspace: {
        getConfiguration: jest.Mock<{
            get: jest.Mock<any, [key: string, defaultValue?: any], any>;
        }, [], any>;
        onDidChangeConfiguration: jest.Mock<{
            dispose: jest.Mock<any, any, any>;
        }, [], any>;
    };
    languages: {
        registerInlineCompletionItemProvider: jest.Mock<any, any, any>;
    };
    commands: {
        registerCommand: jest.Mock<any, any, any>;
    };
    lm: {
        registerLanguageModelChatProvider: jest.Mock<any, any, any>;
    };
    EventEmitter: {
        new (): {
            event: any;
            fire: jest.Mock;
        };
    };
    CancellationToken: {
        new (): {
            isCancellationRequested: boolean;
            reason?: any;
            onCancellationRequested: any;
        };
    };
    ThemeColor: {
        new (colorName: string): {
            colorName: string;
        };
    };
    LogOutputChannel: {
        new (): {
            trace: jest.Mock<any, any, any>;
            debug: jest.Mock<any, any, any>;
            info: jest.Mock<any, any, any>;
            warn: jest.Mock<any, any, any>;
            error: jest.Mock<any, any, any>;
        };
    };
};
export default _default;
//# sourceMappingURL=vscode.d.ts.map