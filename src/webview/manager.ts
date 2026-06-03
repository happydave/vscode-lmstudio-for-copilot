import * as vscode from "vscode";
import * as fs from "fs";
import { LmStudioApiClient } from "../api/client";
import { ConnectionStorage } from "../connection/storage";
import { ConnectionManager } from "../connection/manager";
import { ModelManager } from "../modelManager";
import type {
  ConnectionConfig,
  LmStudioModel,
  WebviewInboundMessage,
  WebviewOutboundMessage,
} from "../api/types";

const PANEL_ID = "lmstudio-config";
const PANEL_TITLE = "LM Studio Configuration";

export class WebviewManager implements vscode.WebviewViewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private sidebarView: vscode.WebviewView | undefined;
  private readonly context: vscode.ExtensionContext;
  private readonly connectionManager: ConnectionManager;
  private readonly storage: ConnectionStorage;
  private readonly modelManager: ModelManager;
  private readonly notifyModelsChanged: () => void;
  private readonly logger: vscode.LogOutputChannel;
  private lastFetchTimestamp = 0;

  constructor(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    storage: ConnectionStorage,
    modelManager: ModelManager,
    notifyModelsChanged: () => void,
    logger: vscode.LogOutputChannel,
  ) {
    this.context = context;
    this.connectionManager = connectionManager;
    this.storage = storage;
    this.modelManager = modelManager;
    this.notifyModelsChanged = notifyModelsChanged;
    this.logger = logger;
  }

  // ── Panel Lifecycle ────────────────────────────────────────

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      PANEL_ID,
      PANEL_TITLE,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "resources", "webview"),
        ],
      },
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, null, this.context.subscriptions);

    this.panel.webview.onDidReceiveMessage(
      async (message: WebviewInboundMessage) => {
        await this.handleWebviewMessage(message);
      },
      null,
      this.context.subscriptions,
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        this.sendConnectionsUpdated();
        const activeName = this.connectionManager.getActiveName() || '';
        const now = Date.now();
        if (activeName && (now - this.lastFetchTimestamp) > 2000) {
          void this.fetchAndSendModels(activeName);
        }
      }
    });
  }

  // ── Sidebar Provider ───────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.sidebarView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "resources", "webview"),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewInboundMessage) => {
        await this.handleWebviewMessage(message);
      },
      null,
      this.context.subscriptions,
    );

    webviewView.onDidDispose(() => {
      this.sidebarView = undefined;
    }, null, this.context.subscriptions);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendConnectionsUpdated();
        const activeName = this.connectionManager.getActiveName() || '';
        const now = Date.now();
        if (activeName && (now - this.lastFetchTimestamp) > 2000) {
          void this.fetchAndSendModels(activeName);
        }
      }
    });
  }

  // ── HTML Generation ────────────────────────────────────────

  getHtml(webview: vscode.Webview): string {
    const webviewUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "resources", "webview"),
    );

    const htmlPath = vscode.Uri.joinPath(
      this.context.extensionUri, "resources", "webview", "index.html",
    );
    let rawHtml: string;
    try {
      rawHtml = fs.readFileSync(htmlPath.fsPath, "utf-8");
    } catch {
      return "<html><body>LM Studio Configuration</body></html>";
    }

    rawHtml = rawHtml.replace(/{{webviewUri}}/g, webviewUri.toString());
    rawHtml = rawHtml.replace(/{{cspSource}}/g, webview.cspSource);

    return rawHtml;
  }

  // ── Outbound Messages to Webview ───────────────────────────

  private post(msg: WebviewOutboundMessage): void {
    this.logger.debug(`[WebviewManager] Posting message: ${msg.type}`);
    this.panel?.webview.postMessage(msg);
    this.sidebarView?.webview.postMessage(msg);
  }

  sendConnectionsUpdated(): void {
    const connections = this.storage.getConnections();
    const activeName = this.connectionManager.getActiveName() || "";
    const lastConnectedMap: Record<string, boolean> = {};
    for (const conn of connections) {
      if (conn.name === activeName && this.connectionManager.getLastConnected()) {
        lastConnectedMap[conn.name] = true;
      }
    }

    const safeConnections = connections.map((c) => ({
      name: c.name,
      scheme: c.scheme,
      host: c.host,
      port: c.port,
    }));

    this.post({
      type: "connectionsUpdated",
      connections: safeConnections,
      activeName,
      lastConnectedMap,
    });
  }

  // ── Message Handler (Webview → Extension) ──────────────────

  private async handleWebviewMessage(message: WebviewInboundMessage): Promise<void> {
    this.logger.debug(`[WebviewManager] Received message: ${message.type}`);
    switch (message.type) {
      case "init":
        this.sendConnectionsUpdated();
        break;

      case "fetchConnections":
        this.sendConnectionsUpdated();
        break;

      case "fetchModels":
        this.lastFetchTimestamp = Date.now();
        await this.fetchAndSendModels(message.serverName);
        break;

      case "activeServerChanged":
        await this.handleActiveServerChange(message.serverName);
        break;

      case "switchConnection":
        await this.handleSwitchConnection(message.name);
        break;

      case "testConnection":
        await this.handleTestConnection(message.config, message.token);
        break;

      case "addServer":
        await this.handleAddServer(message.config, message.token);
        break;

      case "removeServer":
        await this.handleRemoveServer(message.name);
        break;

      case "editServer":
        await this.handleEditServer(message.name, message.config, message.token);
        break;

      case "validationError":
        break;

      case "loadModelDefault":
        await this.handleLoadModelDefault(message.modelKey, message.instanceId);
        break;

      case "loadModelSettings":
        await this.handleLoadModelSettings(
          message.payload.modelKey,
          message.payload.instanceId,
          message.payload.config,
        );
        break;

      case "unloadModel":
        await this.handleUnloadModel(message.instanceId);
        break;

      case "unloadAllModels":
        await this.handleUnloadAllModels();
        break;

      case "reloadModelSettings":
        await this.handleReloadModelSettings(
          message.payload.modelKey,
          message.payload.instanceId,
          message.payload.config,
        );
        break;

      case "refreshServer":
        this.lastFetchTimestamp = Date.now();
        await this.fetchAndSendModels(message.serverName);
        break;

      case "refreshAll":
        await this.handleRefreshAll();
        break;

      case "setCopilotEnabled":
        this.modelManager.setCopilotEnabled(message.modelKey, message.enabled);
        this.notifyModelsChanged();
        break;

      default:
        break;
    }
  }

  // ── Message Handlers ───────────────────────────────────────

  private async handleActiveServerChange(serverName: string): Promise<void> {
    const success = await this.connectionManager.switchConnection(serverName);
    if (success) {
      this.sendConnectionsUpdated();
      await this.fetchAndSendModels(serverName);
    } else {
      this.post({ type: "operationFailed", error: `Failed to switch to connection "${serverName}".` });
    }
  }

  private async handleSwitchConnection(name: string): Promise<void> {
    const success = await this.connectionManager.switchConnection(name);
    if (success) {
      this.sendConnectionsUpdated();
      await this.fetchAndSendModels(name);
      void vscode.window.showInformationMessage(`Switched to connection "${name}".`);
    } else {
      void vscode.window.showErrorMessage("Failed to switch connection.");
    }
  }

  private async handleTestConnection(config: ConnectionConfig, token?: string): Promise<void> {
    try {
      const getToken = token ? async (_name: string) => token : undefined;
      const client = new LmStudioApiClient(config, getToken);
      await client.getModels();
      this.post({ type: "connectionTested", success: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.post({ type: "connectionTested", success: false, error: msg });
    }
  }

  private async handleAddServer(
    config: { name: string; scheme: "http" | "https"; host: string; port: number },
    token?: string,
  ): Promise<void> {
    const connections = this.storage.getConnections();
    if (connections.some((c) => c.name === config.name)) {
      void vscode.window.showErrorMessage(`A connection named "${config.name}" already exists.`);
      return;
    }

    connections.push({ ...config });
    await this.storage.saveConnections(connections);

    if (token) {
      await this.storage.saveToken(config.name, token);
    }

    const success = await this.connectionManager.switchConnection(config.name);
    this.sendConnectionsUpdated();

    if (success) {
      await this.fetchAndSendModels(config.name);
      void vscode.window.showInformationMessage(`Connection "${config.name}" added successfully.`);
    } else {
      void vscode.window.showWarningMessage(`Connection "${config.name}" saved, but failed to connect.`);
    }
  }

  private async handleRemoveServer(name: string): Promise<void> {
    const connections = this.storage.getConnections();

    if (connections.length <= 1) {
      void vscode.window.showErrorMessage("Cannot remove the last connection.");
      return;
    }

    const activeName = this.connectionManager.getActiveName();
    if (name === activeName) {
      try {
        const connConfig = connections.find((c) => c.name === name);
        if (connConfig) {
          const client = new LmStudioApiClient(connConfig, (n) => this.storage.getToken(n));
          const response = await client.getModels();
          const hasLoaded = response.models.some(
            (m: { loaded_instances: unknown[] }) => m.loaded_instances.length > 0,
          );
          if (hasLoaded) {
            void vscode.window.showErrorMessage(
              `Cannot remove "${name}" — it has loaded models. Unload them first or switch to another connection.`,
            );
            return;
          }
        }
      } catch {
        // Cannot reach server; allow removal
      }
    }

    const remaining = connections.filter((c) => c.name !== name);
    await this.storage.saveConnections(remaining);

    if (name === activeName && remaining.length > 0) {
      await this.connectionManager.switchConnection(remaining[0].name);
    }

    await this.storage.saveToken(name, undefined);
    this.sendConnectionsUpdated();
    void vscode.window.showInformationMessage(`Connection "${name}" removed.`);
  }

  private async handleEditServer(
    name: string,
    config?: { scheme?: "http" | "https"; host?: string; port?: number },
    token?: string,
  ): Promise<void> {
    const connections = this.storage.getConnections();
    const idx = connections.findIndex((c) => c.name === name);
    if (idx === -1) {
      void vscode.window.showErrorMessage(`Connection "${name}" not found.`);
      return;
    }

    if (config) {
      if (config.scheme !== undefined) { connections[idx].scheme = config.scheme; }
      if (config.host !== undefined) { connections[idx].host = config.host; }
      if (config.port !== undefined) { connections[idx].port = config.port; }
    }

    await this.storage.saveConnections(connections);

    if (token && token.length > 0) {
      await this.storage.saveToken(name, token);
    }

    const activeName = this.connectionManager.getActiveName();
    if (name === activeName) {
      const updatedConfig = connections.find((c) => c.name === name);
      if (updatedConfig) {
        await this.connectionManager.switchConnection(name);
      }
    }

    this.sendConnectionsUpdated();
    void vscode.window.showInformationMessage(`Connection "${name}" updated.`);
  }

  private async handleLoadModelDefault(modelKey: string, instanceId?: string): Promise<void> {
    const client = this.connectionManager.getActiveClient();
    if (!client) {
      void vscode.window.showErrorMessage("No active connection.");
      return;
    }

    try {
      const response = await client.getModels();
      const currentModel = response.models.find((m: { key: string }) => m.key === modelKey);
      if (!currentModel) {
        this.post({ type: "operationFailed", error: "Model no longer available on the server." });
        return;
      }
      if (currentModel.loaded_instances.length > 0 && !instanceId) {
        this.post({ type: "operationComplete", message: `"${currentModel.display_name}" is already loaded.` });
        return;
      }

      const maxContext = currentModel.max_context_length || undefined;
      const loadConfig: Record<string, unknown> = {};
      if (maxContext) { loadConfig.context_length = maxContext; }
      if (currentModel.format === "gguf") {
        loadConfig.flash_attention = true;
        loadConfig.offload_kv_cache_to_gpu = true;
      }

      this.post({ type: "operationProgress", message: `Loading "${currentModel.display_name}"...` });
      const result = await client.loadModel({ model: modelKey, ...loadConfig } as LoadModelRequest);
      this.post({ type: "operationComplete", message: `Loaded "${currentModel.display_name}" in ${result.load_time_seconds.toFixed(1)}s.` });

      const activeName = this.connectionManager.getActiveName() || "";
      await this.fetchAndSendModels(activeName);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.post({ type: "operationFailed", error: `Failed to load model: ${msg}` });
    }
  }

  private async handleLoadModelSettings(
    modelKey: string,
    instanceId: string | undefined,
    config: Record<string, unknown>,
  ): Promise<void> {
    const client = this.connectionManager.getActiveClient();
    if (!client) {
      void vscode.window.showErrorMessage("No active connection.");
      return;
    }

    if (instanceId) {
      void vscode.window.showWarningMessage("Use Reload Settings for existing instances.");
      return;
    }

    try {
      const response = await client.getModels();
      const currentModel = response.models.find((m: { key: string }) => m.key === modelKey);
      if (!currentModel) {
        this.post({ type: "operationFailed", error: "Model no longer available on the server." });
        return;
      }
      if (currentModel.loaded_instances.length > 0) {
        this.post({ type: "operationComplete", message: `"${currentModel.display_name}" is already loaded.` });
        return;
      }

      const loadConfig: Record<string, unknown> = { model: modelKey };
      if (config.context_length !== undefined) { loadConfig.context_length = config.context_length; }
      if (currentModel.format === "gguf") {
        loadConfig.flash_attention = config.flash_attention !== undefined ? config.flash_attention : true;
        loadConfig.offload_kv_cache_to_gpu = config.offload_kv_cache_to_gpu !== undefined ? config.offload_kv_cache_to_gpu : true;
      }

      this.post({ type: "operationProgress", message: `Loading "${currentModel.display_name}"...` });
      const result = await client.loadModel(loadConfig as unknown as import("../api/types").LoadModelRequest);
      this.post({ type: "operationComplete", message: `Loaded "${currentModel.display_name}" in ${result.load_time_seconds.toFixed(1)}s.` });

      const activeName = this.connectionManager.getActiveName() || "";
      await this.fetchAndSendModels(activeName);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.post({ type: "operationFailed", error: `Failed to load model: ${msg}` });
    }
  }

  private async handleUnloadModel(instanceId: string): Promise<void> {
    const client = this.connectionManager.getActiveClient();
    if (!client) {
      void vscode.window.showErrorMessage("No active connection.");
      return;
    }

    try {
      await client.unloadModel({ instance_id: instanceId });
      this.post({ type: "operationComplete", message: "Model unloaded." });
      const activeName = this.connectionManager.getActiveName() || "";
      await this.fetchAndSendModels(activeName);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.post({ type: "operationFailed", error: `Failed to unload model: ${msg}` });
    }
  }

  private async handleUnloadAllModels(): Promise<void> {
    const client = this.connectionManager.getActiveClient();
    if (!client) {
      void vscode.window.showErrorMessage("No active connection.");
      return;
    }

    try {
      const response = await client.getModels();
      const loadedModels = response.models.filter(
        (m: { loaded_instances: unknown[] }) => m.loaded_instances.length > 0,
      );

      if (loadedModels.length === 0) {
        this.post({ type: "operationComplete", message: "No models are currently loaded." });
        return;
      }

      let successCount = 0;
      let failCount = 0;

      for (const model of loadedModels) {
        const instanceId = (model.loaded_instances as Array<{ id: string }>)[0]?.id;
        try {
          await client.unloadModel({ instance_id: instanceId });
          successCount++;
        } catch {
          failCount++;
        }
      }

      let message = `Unloaded ${successCount} model(s).`;
      if (failCount > 0) { message += ` ${failCount} failed.`; }
      this.post({ type: "operationComplete", message });

      const activeName = this.connectionManager.getActiveName() || "";
      await this.fetchAndSendModels(activeName);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.post({ type: "operationFailed", error: `Failed to unload all models: ${msg}` });
    }
  }

  private async handleReloadModelSettings(
    modelKey: string,
    instanceId: string | undefined,
    config: Record<string, unknown>,
  ): Promise<void> {
    const client = this.connectionManager.getActiveClient();
    if (!client) {
      void vscode.window.showErrorMessage("No active connection.");
      return;
    }

    let displayName = modelKey;
    try {
      const response = await client.getModels();
      const currentModel = response.models.find((m: { key: string }) => m.key === modelKey);
      if (currentModel) { displayName = currentModel.display_name; }
    } catch { /* use modelKey as fallback */ }

    this.post({ type: "operationProgress", message: `Reloading "${displayName}"...` });

    try {
      await client.unloadModel({ instance_id: instanceId! });

      const loadConfig: Record<string, unknown> = { model: modelKey };
      if (config.context_length !== undefined) { loadConfig.context_length = config.context_length; }
      if (config.flash_attention !== undefined) { loadConfig.flash_attention = config.flash_attention; }
      if (config.offload_kv_cache_to_gpu !== undefined) { loadConfig.offload_kv_cache_to_gpu = config.offload_kv_cache_to_gpu; }

      const result = await client.loadModel(loadConfig as unknown as import("../api/types").LoadModelRequest);
      this.post({ type: "operationComplete", message: `Reloaded "${displayName}" in ${result.load_time_seconds.toFixed(1)}s.` });

      const activeName = this.connectionManager.getActiveName() || "";
      await this.fetchAndSendModels(activeName);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.post({ type: "operationFailed", error: `Failed to reload model: ${msg}` });
    }
  }

  private async handleRefreshAll(): Promise<void> {
    this.sendConnectionsUpdated();
    const connections = this.storage.getConnections();
    const fetchPromises = connections.map(async (conn) => {
      try {
        const client = new LmStudioApiClient(conn, (n) => this.storage.getToken(n));
        const response = await client.getModels();
        if (conn.name === this.connectionManager.getActiveName()) {
          const copilotEnabled = this.modelManager.getCopilotEnabledMap();
          this.post({ type: "modelsUpdated", serverName: conn.name, models: response.models, copilotEnabled });
        }
      } catch {
        // Silently fail per-server
      }
    });
    await Promise.all(fetchPromises);
  }

  // ── Model Fetching ─────────────────────────────────────────

  private async fetchAndSendModels(serverName: string): Promise<void> {
    const connections = this.storage.getConnections();
    const config = connections.find((c) => c.name === serverName);
    if (!config) { return; }

    try {
      const client = new LmStudioApiClient(config, (n) => this.storage.getToken(n));
      const response = await client.getModels();

      if (serverName === this.connectionManager.getActiveName()) {
        this.connectionManager.setLastConnected(true);
      }

      const copilotEnabled = this.modelManager.getCopilotEnabledMap();
      this.post({ type: "modelsUpdated", serverName, models: response.models, copilotEnabled });
    } catch {
      if (serverName === this.connectionManager.getActiveName()) {
        this.connectionManager.setLastConnected(false);
        const safeConnections = connections.map((c) => ({ name: c.name, scheme: c.scheme, host: c.host, port: c.port }));
        this.post({
          type: "connectionsUpdated",
          connections: safeConnections,
          activeName: this.connectionManager.getActiveName() || "",
          lastConnectedMap: { [serverName]: false },
        });
      }
    }
  }
}

// Type helper used in handleLoadModelDefault to satisfy TS
type LoadModelRequest = import("../api/types").LoadModelRequest;
